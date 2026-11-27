"""Validate a trusted cleanup attestation for one closed issue cycle."""
import re

from mvp_decision import _date, _id


MARKER = "[ARCHIVE-CLEANUP]"
FIELDS = ("Cycle", "Scope", "Worktrees", "Branches", "Temporary", "Environment")
REMOVAL = {"removed", "not-created", "blocked"}


def read_cleanup(comments, cycle, closed_at, trusted_authors, *, has_sources=None):
    """Use the newest matching attestation. A correction can explicitly block it."""
    latest = None
    seen = set()
    for comment in comments:
        user = comment["user"]
        body = comment["body"]
        if (user is None or user.get("type") != "User" or user.get("id") not in trusted_authors
                or not isinstance(body, str) or not body.splitlines() or body.splitlines()[0] != MARKER):
            continue
        number, created = comment["id"], _date(comment["created_at"])
        if not _id(number) or number in seen:
            raise ValueError("Invalid cleanup comment identity")
        seen.add(number)
        if created < closed_at:
            continue
        lines = body.splitlines()[1:]
        if lines and re.fullmatch(r"Cycle: [1-9][0-9]{0,18}", lines[0]) and int(lines[0][7:]) != cycle:
            continue
        if latest is None or (created, number) > latest[0]:
            latest = ((created, number), lines, _date(comment["updated_at"]))
    if latest is None:
        return {"kind": "blocked", "reason": "cleanup-missing"}

    (created, number), lines, updated = latest
    if updated != created:
        return {"kind": "blocked", "reason": "cleanup-edited"}
    if len(lines) != len(FIELDS) or any(not line.startswith(field + ": ") for field, line in zip(FIELDS, lines)):
        return {"kind": "blocked", "reason": "cleanup-invalid"}
    cycle_text, scope, worktrees, branches, temporary, environment = [
        line.split(": ", 1)[1] for line in lines
    ]
    if (cycle_text != str(cycle) or scope not in {"code", "no-code"}
            or worktrees not in REMOVAL or branches not in REMOVAL or temporary not in REMOVAL
            or environment not in REMOVAL | {"retained"}):
        return {"kind": "blocked", "reason": "cleanup-invalid"}
    if has_sources is not None and (scope == "code") != has_sources:
        return {"kind": "blocked", "reason": "cleanup-scope-mismatch"}
    if "blocked" in (worktrees, branches, temporary, environment):
        return {"kind": "blocked", "reason": "cleanup-incomplete"}
    return {"kind": "confirmed", "comment_id": number,
            "scope": scope, "worktrees": worktrees, "branches": branches,
            "temporary": temporary, "environment": environment}
