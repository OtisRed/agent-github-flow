"""One bounded MVP processing step; the GitHub adapter is supplied separately.

The adapter must authenticate and fully paginate the intended issue, comments,
reopens and Project card, and bind the card to the configured repository. It
must not retry status writes. Only a single worker may execute this function.
"""
from mvp_decision import decide
from mvp_store import checkpoint_status


def _intent_intact(row, snapshot, trusted_authors):
    if not isinstance(snapshot, dict) or snapshot.get("complete") is not True:
        return False
    comment_id = row["uncertain_comment_id"]
    if comment_id is None:
        return True
    comments = snapshot.get("comments")
    if not isinstance(comments, list):
        return False
    matches = [item for item in comments if isinstance(item, dict) and item.get("id") == comment_id]
    return (len(matches) == 1 and matches[0].get("author_id") in trusted_authors
            and checkpoint_status(comment_id, row["uncertain_comment_digest"], matches[0]) == "unchanged")


def process_one(store, github, *, enrolled_at, trusted_authors, row=None, pr_flow=None):
    """Inspect and process one issue, recording intent before any status write.

    `github.read(repo_id, issue_number)` must supply the snapshot described by
    mvp_decision. `github.set_status(repo_id, issue_number, status)` makes one
    attempt. Its result alone is never taken as proof: a fresh read is required.
    The adapter is trusted and not sandboxed; no credentials pass through here.
    """
    if row is None:
        row = store.next_pending()
    if row is None:
        return {"kind": "idle"}
    repo, number, generation = row["repository_id"], row["issue_number"], row["generation"]
    try:
        current = github.read(repo, number)
    except Exception:
        store.defer(repo, number)
        return {"kind": "read-failed"}

    if isinstance(current, dict) and current.get("missing_card") is True:
        if row["uncertain_since"] is not None or row["completed_generation"] > 0:
            store.block(repo, number, generation, "existing-card-missing")
            return {"kind": "blocked", "reason": "existing-card-missing"}
        # GitHub's Project auto-add creates cards for new or updated issues.
        # It is asynchronous; wait and re-read rather than using broader PAT
        # repository access or treating temporary absence as a missing issue.
        store.defer(repo, number)
        return {"kind": "awaiting-card"}

    if row["uncertain_since"] is not None:
        if not _intent_intact(row, current, trusted_authors):
            store.block(repo, number, generation, "uncertain-intent-unverified")
            return {"kind": "blocked", "reason": "uncertain-intent-unverified"}
        observed = current.get("status") == row["uncertain_target"]
        if not observed and not store.recovery_ready(repo, number):
            return {"kind": "waiting"}
        store.resolve_status_write(repo, number, target_observed=observed)
        row = store.get(repo, number)

    decision = decide(current, row, enrolled_at=enrolled_at, trusted_authors=trusted_authors)
    if decision["kind"] == "blocked":
        store.block(repo, number, generation, decision["reason"])
        return decision
    if pr_flow is not None:
        from pr_flow_runner import process_pr_handoff
        try:
            handoff = process_pr_handoff(store, github, row, current, decision,
                                         trusted_authors=trusted_authors, **pr_flow)
        except Exception:
            store.defer(repo, number)
            return {"kind": "read-failed"}
        if handoff in ("rescan", "handoff-posted"):
            return {"kind": "rescan"}
        if handoff == "write-uncertain":
            return {"kind": "write-uncertain"}
        if handoff == "legacy-comment-edited":
            return {"kind": "blocked", "reason": handoff}

    if decision["kind"] == "no-change":
        store.complete(repo, number, generation)
        return {"kind": "completed"}

    # Two complete reads reduce stale decisions; GitHub offers no conditional
    # status write, so the documented residual concurrent-write risk remains.
    try:
        fresh = github.read(repo, number)
    except Exception:
        store.defer(repo, number)
        return {"kind": "read-failed"}
    latest = store.get(repo, number)
    if fresh != current or latest is None or latest["generation"] != generation:
        if latest is not None:
            store.yield_turn(repo, number)
        return {"kind": "rescan"}
    target = decision["status"]
    if current["status"] != target:
        store.begin_status_write(repo, number, generation, target, comment_id=decision.get("comment_id"),
                                 comment_digest=decision.get("comment_digest"))
        try:
            github.set_status(repo, number, target)
        except Exception:
            return {"kind": "write-uncertain"}
        try:
            observed = github.read(repo, number)
        except Exception:
            return {"kind": "write-uncertain"}
        pending = store.get(repo, number)
        if (not _intent_intact(pending, observed, trusted_authors)
                or observed.get("status") != target):
            return {"kind": "write-uncertain"}
        store.resolve_status_write(repo, number, target_observed=True)
        if pr_flow is not None and target in ("agent-ready", "review"):
            # The PR signal may have arrived before this status was projected.
            store.enqueue_now(repo, number)
    store.complete(repo, number, generation, comment_id=decision.get("comment_id"),
                   comment_digest=decision.get("comment_digest"), reopen_id=decision.get("reopen_id"),
                   recheck=decision.get("recheck", False))
    return {"kind": "completed"}
