"""Pure closed-prefix planning for the central promotion worker."""
import re

from mvp_decision import _date


SHA = re.compile(r"^[0-9a-f]{40}$")
REFS = re.compile(r"^\s*Refs\s+#([0-9]+)\s*$", re.IGNORECASE | re.MULTILINE)


def issue_reference(body):
    """Accept exactly one standalone reference; never infer issue identity."""
    if not isinstance(body, str):
        return None
    found = REFS.findall(body)
    if len(found) != 1:
        return None
    number = int(found[0])
    return number if 0 < number < 2**63 else None


def closed_prefix(entries, issues):
    """Select a contiguous prefix using current issue state and latest merge.

    The caller supplies a fully read first-parent inventory, an unambiguous PR
    mapping for each entry, and current issue snapshots. Missing or inconsistent
    input is never interpreted as an empty queue or a completed issue.
    """
    if not isinstance(entries, list) or not isinstance(issues, dict):
        return {"kind": "blocked", "reason": "incomplete-input"}
    latest, seen = {}, set()
    try:
        for entry in entries:
            number, sha = entry["issue"], entry["sha"]
            if (type(number) is not int or not 0 < number < 2**63
                    or not isinstance(sha, str) or not SHA.fullmatch(sha) or sha in seen):
                return {"kind": "blocked", "reason": "invalid-entry"}
            seen.add(sha)
            merged = _date(entry["merged_at"])
            latest[number] = max(latest.get(number, merged), merged)
        closed = set()
        for number, merged in latest.items():
            issue = issues[number]
            if not isinstance(issue, dict) or issue.get("state") not in ("open", "closed"):
                return {"kind": "blocked", "reason": "invalid-issue"}
            if issue["state"] == "closed":
                if _date(issue["closed_at"]) > merged:
                    closed.add(number)
    except (KeyError, TypeError, ValueError, OverflowError):
        return {"kind": "blocked", "reason": "incomplete-input"}
    if not entries:
        return {"kind": "idle"}
    count = 0
    for entry in entries:
        if entry["issue"] not in closed:
            break
        count += 1
    if not count:
        return {"kind": "waiting", "reason": "open-issue"}
    return {"kind": "ready", "sha": entries[count - 1]["sha"], "count": count}
