"""Recover or create a managed Dependabot issue, without writing Project status."""

from dependabot_plan import find_managed, inspect_pr, issue_body
from pr_admission import REF


def intake_step(gateway, journal, repository, repository_id, pr_number):
    """Use a durable intent before creation; never retry an uncertain creation."""
    pr = gateway.read_pr(pr_number)
    state = inspect_pr(pr, repository_id, pr_number)
    if state in ("unsupported", "ambiguous"):
        return state
    # Existing linked PRs are left to their owner unless they are ours.
    issues = gateway.list_issues()
    managed = find_managed(issues, repository, pr_number)
    saved = journal.read(repository_id, pr_number)
    if saved and saved["issue_number"] is not None and managed != saved["issue_number"]:
        return "issue-mismatch"
    if state == "linked":
        refs = [int(m.group(1)) for line in pr["body"].splitlines() if (m := REF.fullmatch(line))]
        if managed != refs[0]:
            return "already-linked"
    if managed is None:
        if saved is not None or not journal.begin(repository_id, pr_number):
            return "creation-unconfirmed"
        # If the response is lost, a later scan may find the marker, but must
        # not post a second issue even when the result is still invisible.
        try:
            gateway.create_issue(pr_number, issue_body(repository, pr_number))
        except Exception:
            return "creation-unconfirmed"
        managed = find_managed(gateway.list_issues(), repository, pr_number)
        if managed is None:
            return "creation-unconfirmed"
    journal.bind(repository_id, pr_number, managed)
    current = gateway.read_pr(pr_number)
    if current != pr:
        return "pr-changed"
    if state == "unlinked" or not pr["draft"] or pr["base"]["ref"] != "smoke":
        gateway.normalize(pr, managed)
        return "normalized"
    return "ready"
