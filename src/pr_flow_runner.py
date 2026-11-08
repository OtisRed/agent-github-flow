"""One PR-to-FLOW handoff, using the existing issue queue for recovery."""

from mvp_decision import _date
from pr_flow_decision import select_pr_handoff


def process_pr_handoff(store, gateway, row, snapshot, decision, *, enrolled_at, app_author_id, trusted_authors):
    """Recheck the complete input before one attempt to publish a handoff.

    The caller first validates the issue and checkpoint using mvp_decision.
    The gateway reads the live issue and all candidate PRs; neither webhook
    payloads nor timeline references alone authorize a write.
    """
    if snapshot.get("state") != "OPEN" or snapshot.get("status") not in ("agent-ready", "review"):
        return "no-change"
    repo, number, generation = row["repository_id"], row["issue_number"], row["generation"]
    comments = snapshot.get("comments")
    if not isinstance(comments, list):
        return "no-change"
    if decision.get("kind") == "no-change":
        last = None
    elif (decision.get("kind") == "target" and snapshot.get("status") == decision.get("status")
          and decision.get("comment_id") is not None):
        matches = [comment for comment in comments if comment.get("id") == decision["comment_id"]]
        if len(matches) != 1:
            return "no-change"
        last = matches[0]
    else:
        return "no-change"
    issue = {**snapshot, "number": number}
    candidates = gateway.read_pr_candidates(number)
    text = select_pr_handoff(candidates, issue, last, enrolled_at=enrolled_at, app_author_id=app_author_id)
    if text is None:
        return "no-change"
    boundary = _date(enrolled_at)
    if last is None or _date(last.get("created_at")) < boundary:
        # An edited legacy comment cannot safely stand in for an unchanged
        # pre-cutover history. A new FLOW explicitly starts the next cycle.
        if any(comment.get("author_id") in trusted_authors
               and _date(comment.get("created_at")) <= boundary < _date(comment.get("updated_at"))
               for comment in comments):
            store.block(repo, number, generation, "legacy-comment-edited")
            return "legacy-comment-edited"
    fresh = gateway.read(repo, number)
    current = store.get(repo, number)
    fresh_candidates = gateway.read_pr_candidates(number)
    if (fresh != snapshot or fresh_candidates != candidates or current is None
            or current["generation"] != generation):
        store.yield_turn(repo, number)
        return "rescan"
    # Persist a delay before the write. If the process dies or the reply is
    # lost, the next pass reads GitHub before considering another comment.
    store.defer(repo, number, seconds=120)
    try:
        gateway.post_flow(number, text)
    except Exception:
        return "write-uncertain"
    store.enqueue_now(repo, number)
    return "handoff-posted"
