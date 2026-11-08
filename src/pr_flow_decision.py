"""Decide whether a verified PR warrants a standard issue handoff.

This module is deliberately I/O free. Its caller must supply complete, fresh
GitHub data and must verify the last handoff before publishing anything.
"""

import re

from mvp_decision import _date, parse_flow
from pr_admission import SHA, pr_issue_number


def draft_message(number):
    return ("[FLOW]\nRola: automat\nStan docelowy: review\n"
            f"Wykonano: Przygotowano PR #{number} do review.\n"
            "Następny krok: Wykonać review i zakończyć testy.")


def merged_message(number):
    return ("[FLOW]\nRola: automat\nStan docelowy: smoke\n"
            f"Wykonano: Scalono PR #{number} do smoke.\n"
            "Następny krok: Wykonać wspólny smoke.")


def _mentions_pr_in_review(body, number):
    """Allow a trusted human handoff when its work field names one PR."""
    lines = body.splitlines()
    if len(lines) != 5 or lines[1].partition(":")[2].strip().casefold() == "automat":
        return False
    numbers = re.findall(r"\bPR\s+#([1-9][0-9]*)\b", lines[3], flags=re.IGNORECASE)
    return numbers == [str(number)]


def decide_pr_handoff(pr, issue, last_flow, *, enrolled_at, app_author_id):
    """Return the exact handoff, or None when there is no safe transition.

    The current status and last handoff must agree. A merge can advance only
    the PR named in the latest review handoff, or a PR created after the
    current agent-ready handoff if the service missed the whole PR cycle.
    The caller must reject ambiguous or incomplete PR candidates.
    """
    try:
        if (not isinstance(pr, dict) or not isinstance(issue, dict)
                or not isinstance(last_flow, dict) or issue.get("complete") is not True
                or issue.get("state") != "OPEN" or type(issue.get("number")) is not int
                or issue["number"] <= 0 or type(pr.get("number")) is not int
                or pr["number"] <= 0 or type(app_author_id) is not int or app_author_id <= 0
                or pr.get("same_repository") is not True or pr.get("base_ref") != "smoke"
                or not isinstance(pr.get("head_ref"), str) or pr["head_ref"].startswith("sync-main/")
                or pr_issue_number(pr.get("body")) != issue["number"]):
            return None
        boundary = _date(enrolled_at)
        created = _date(pr.get("created_at"))
        flow_time = _date(last_flow.get("created_at"))
        if created <= boundary or flow_time <= boundary:
            return None
        reopen = issue.get("latest_reopen")
        if reopen is not None and (not isinstance(reopen, dict)
                or created <= _date(reopen.get("created_at"))
                or flow_time <= _date(reopen.get("created_at"))):
            return None
        body = last_flow.get("body")
        current = parse_flow(body)
        if current != issue.get("status"):
            return None
        if pr.get("state") == "open" and pr.get("merged") is False:
            if current == "agent-ready" and flow_time <= created:
                return draft_message(pr["number"])
        elif pr.get("state") == "closed" and pr.get("merged") is True:
            if not isinstance(pr.get("merge_commit_sha"), str) or not SHA.fullmatch(pr["merge_commit_sha"]):
                return None
            merged_at = _date(pr.get("merged_at"))
            if (current == "review" and last_flow.get("author_id") == app_author_id
                    and body == draft_message(pr["number"])
                    and merged_at >= flow_time):
                return merged_message(pr["number"])
            if (current == "review" and last_flow.get("author_id") != app_author_id
                    and _mentions_pr_in_review(body, pr["number"])
                    and created <= flow_time <= merged_at):
                return merged_message(pr["number"])
            if current == "agent-ready" and flow_time <= created <= merged_at:
                return merged_message(pr["number"])
        return None
    except (ValueError, TypeError, OverflowError):
        return None


def select_pr_handoff(candidates, issue, last_flow, *, enrolled_at, app_author_id):
    """Choose only when a complete candidate read has one possible outcome."""
    if not isinstance(candidates, list):
        return None
    decisions = [decide_pr_handoff(pr, issue, last_flow, enrolled_at=enrolled_at,
                                   app_author_id=app_author_id) for pr in candidates]
    decisions = [value for value in decisions if value is not None]
    return decisions[0] if len(decisions) == 1 else None
