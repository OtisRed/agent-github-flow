"""MVP decision for one freshly observed issue; this module does no I/O.

The caller supplies a complete, authenticated snapshot (including every
comment and the most recent native reopen), a trusted author allowlist, and a
fixed onboarding boundary. The caller must verify freshness before writes.
"""
import re
from datetime import datetime, timezone

from mvp_store import checkpoint_status, comment_digest

STATUSES = frozenset({"decision-gate", "needs-design", "audit", "spike",
                      "agent-ready", "review", "smoke", "done"})
FIELDS = ("Rola", "Stan docelowy", "Wykonano", "Następny krok")
JS_TRIM = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def _date(value):
    if not isinstance(value, str):
        raise ValueError("Invalid timestamp")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Invalid timestamp") from exc
    if result.tzinfo is None:
        raise ValueError("Timezone required")
    return result.astimezone(timezone.utc)


def _id(value):
    return type(value) is int and 0 < value < 2**63


def parse_flow(body):
    """Apply the five-line format from flow.mjs without requiring Node on VPS."""
    if not isinstance(body, str):
        return None
    lines = re.split(r"\r\n|\n", body)
    if lines and lines[-1] == "":
        lines.pop()
    if len(lines) != 5 or lines[0] != "[FLOW]":
        return None
    values = []
    for line, field in zip(lines[1:], FIELDS):
        prefix = field + ":"
        if not line.startswith(prefix):
            return None
        value = line[len(prefix):].strip(JS_TRIM)
        if not value or "\r" in value or "\n" in value:
            return None
        values.append(value)
    if values[1] not in STATUSES:
        return None
    return values[1]


def decide(snapshot, checkpoint, *, enrolled_at, trusted_authors):
    """Return a target, no-op, or explicit block, never changing GitHub.

    A reopen is projected to needs-design before any later handoff and requests
    another pass. Its ID must be persisted atomically by the integrating worker.
    """
    blocked = lambda reason: {"kind": "blocked", "reason": reason}
    try:
        if (not isinstance(snapshot, dict) or snapshot.get("complete") is not True
                or snapshot.get("state") not in ("OPEN", "CLOSED")
                or (snapshot.get("status") is not None and snapshot.get("status") not in STATUSES)
                or not isinstance(checkpoint, dict)
                or not isinstance(trusted_authors, frozenset) or not trusted_authors
                or any(not _id(value) for value in trusted_authors)):
            return blocked("invalid-snapshot")
        boundary = _date(enrolled_at)
        created = _date(snapshot.get("created_at"))
        comments = snapshot.get("comments")
        if not isinstance(comments, list):
            return blocked("incomplete-comments")
        seen = set()
        ordered = []
        for comment in comments:
            if (not isinstance(comment, dict) or not _id(comment.get("id"))
                    or not _id(comment.get("author_id")) or not isinstance(comment.get("body"), str)
                    or comment["id"] in seen):
                return blocked("invalid-comment")
            seen.add(comment["id"])
            created_at = _date(comment.get("created_at"))
            if _date(comment.get("updated_at")) < created_at:
                return blocked("invalid-comment")
            ordered.append((created_at, comment["id"], comment))
        ordered.sort(key=lambda entry: (entry[0], entry[1]))
        tracked_id, tracked_digest = checkpoint.get("comment_id"), checkpoint.get("comment_digest")
        tracked = next((entry[2] for entry in ordered if entry[1] == tracked_id), None)
        continuity = checkpoint_status(tracked_id, tracked_digest, tracked)
        if continuity not in ("not-initialized", "unchanged"):
            return blocked("checkpoint-" + continuity)
        if tracked is not None and tracked["author_id"] not in trusted_authors:
            return blocked("checkpoint-untrusted")

        reopen = snapshot.get("latest_reopen")
        reopen_id, reopen_time = None, None
        if reopen is not None:
            if not isinstance(reopen, dict) or not _id(reopen.get("id")):
                return blocked("invalid-reopen")
            reopen_id, reopen_time = reopen["id"], _date(reopen.get("created_at"))
        old_reopen = checkpoint.get("reopen_id")
        if old_reopen is not None and not _id(old_reopen):
            return blocked("invalid-checkpoint")
        if old_reopen is not None and (reopen_time is None or reopen_time <= boundary):
            return blocked("reopen-history-missing")
        if snapshot["state"] == "CLOSED":
            return {"kind": "target", "status": "done"}
        if created == boundary:
            return blocked("ambiguous-issue-boundary")
        if reopen_time is not None and reopen_time > boundary:
            if reopen_id != old_reopen:
                return {"kind": "target", "status": "needs-design", "reopen_id": reopen_id, "recheck": True}
            boundary = max(boundary, reopen_time)

        if snapshot.get("status") == "done":
            # An open issue cannot remain done, including legacy reopened cards
            # whose most recent reopen predates controller enrollment.
            return {"kind": "target", "status": "needs-design", "recheck": True}

        if any(entry[0] == boundary and entry[2]["author_id"] in trusted_authors for entry in ordered):
            return blocked("ambiguous-comment-boundary")
        eligible = [entry for entry in ordered if entry[0] > boundary and entry[2]["author_id"] in trusted_authors]
        if eligible:
            comment = eligible[-1][2]
            target = parse_flow(comment["body"])
            if target is None:
                return blocked("invalid-flow-comment")
            if target == "done":
                return blocked("open-issue-cannot-be-done")
            return {"kind": "target", "status": target, "comment_id": comment["id"],
                    "comment_digest": comment_digest(comment["body"], comment["updated_at"])}
        if created > boundary:
            return {"kind": "target", "status": "needs-design"}
        return {"kind": "no-change"}
    except (ValueError, TypeError, UnicodeError, OverflowError):
        return blocked("invalid-snapshot")
