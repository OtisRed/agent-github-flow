"""Pure decision for the shared PR review contract; performs no GitHub writes."""

import re
from datetime import datetime


SHA = re.compile(r"[0-9a-f]{40}\Z")
REQUIREMENT = re.compile(r"^\s*Wymagane review\s*:(.*)$", re.IGNORECASE)
REQUIREMENT_PREFIX = re.compile(r"^\s*(?:[-*]\s*)?(?:\*{0,2})Wymagane\s+review\b", re.IGNORECASE)
REF = re.compile(r"^\s*Refs\s+#([1-9][0-9]*)\s*$", re.IGNORECASE)
FIELDS = ("Rola", "Commit", "Wynik", "Zakres", "DA")
ROLES = frozenset(("agent-prowadzacy", "subagent"))
RESULTS = frozenset(("pozytywny", "wymaga-poprawek"))
EMPTY_DA = frozenset(("brak uwag", "nie znalazłem uwag", "nie znaleziono uwag", "ok", "n/a", "none"))


def issue_requirement(body):
    if not isinstance(body, str):
        return None
    lines = [line for line in body.splitlines() if REQUIREMENT_PREFIX.match(line)]
    if any(REQUIREMENT.fullmatch(line) is None for line in lines):
        return None
    values = [REQUIREMENT.fullmatch(line).group(1).strip() for line in lines]
    if not values:
        return 1
    if len(values) != 1 or values[0] not in ("1", "2"):
        return None
    return int(values[0])


def pr_issue_number(body):
    if not isinstance(body, str):
        return None
    refs = [int(match.group(1)) for line in body.splitlines() if (match := REF.fullmatch(line))]
    return refs[0] if len(refs) == 1 else None


def parse_review(body):
    """Recognize exact, single-line fields; no inferred identity or DA quality."""
    if not isinstance(body, str):
        return None
    lines = body.strip().splitlines()
    if len(lines) != len(FIELDS) + 1 or lines[0] != "[REVIEW]":
        return None
    values = {}
    for line, field in zip(lines[1:], FIELDS):
        prefix = field + ":"
        if not line.startswith(prefix):
            return None
        value = line[len(prefix):].strip()
        if not value or len(value) > 4000:
            return None
        values[field] = value
    if (values["Rola"] not in ROLES or values["Wynik"] not in RESULTS
            or not SHA.fullmatch(values["Commit"]) or values["DA"].casefold().rstrip(".!") in EMPTY_DA
            or (values["DA"].startswith("<") and values["DA"].endswith(">"))):
        return None
    return values


def evaluate(pr, issue, comments, trusted_author_ids):
    """Evaluate a complete fresh snapshot; a code describes each blocked state.

    The caller must obtain complete pages and re-read immediately before merge.
    Author IDs are GitHub IDs, never roles asserted by the comment itself.
    """
    if (not isinstance(pr, dict) or not isinstance(issue, dict)
            or not isinstance(comments, list) or not isinstance(trusted_author_ids, frozenset)
            or not trusted_author_ids or any(type(i) is not int or i <= 0 for i in trusted_author_ids)):
        return "incomplete-snapshot"
    if pr.get("state") != "open" or pr.get("draft") is not False:
        return "pr-not-ready"
    head = pr.get("head_sha")
    if not isinstance(head, str) or not SHA.fullmatch(head):
        return "invalid-head"
    number = pr_issue_number(pr.get("body"))
    if (number is None or type(issue.get("number")) is not int or issue.get("number") != number
            or issue.get("state") != "open"):
        return "invalid-issue-link"
    required = issue_requirement(issue.get("body"))
    if required is None:
        return "invalid-review-requirement"
    latest = {}
    seen = set()
    for comment in comments:
        if not isinstance(comment, dict):
            return "incomplete-comments"
        cid, author, body = comment.get("id"), comment.get("author_id"), comment.get("body")
        if type(cid) is not int or cid <= 0 or cid in seen or type(author) is not int or not isinstance(body, str):
            return "incomplete-comments"
        seen.add(cid)
        if author not in trusted_author_ids or not body.lstrip().startswith("[REVIEW]"):
            continue
        review = parse_review(body)
        if review is None:
            return "invalid-review"
        if review["Commit"] != head:
            continue
        updated = comment.get("updated_at")
        try:
            stamp = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                return "invalid-review"
            stamp = stamp.timestamp()
        except (AttributeError, ValueError, TypeError, OverflowError, OSError):
            return "invalid-review"
        role = review["Rola"]
        prior = latest.get(role)
        if prior is None or stamp > prior[0]:
            latest[role] = (stamp, review, False)
        elif stamp == prior[0] and review["Wynik"] != prior[1]["Wynik"]:
            latest[role] = (stamp, prior[1], True)
    required_roles = ("agent-prowadzacy", "subagent") if required == 2 else ("agent-prowadzacy",)
    for role in required_roles:
        if role not in latest:
            return "missing-review-" + role
        if latest[role][2]:
            return "ambiguous-review-" + role
        if latest[role][1]["Wynik"] != "pozytywny":
            return "review-requires-changes-" + role
    return "ready"
