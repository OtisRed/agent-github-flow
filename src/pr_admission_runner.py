"""Bounded PR admission orchestration; a supplied gateway owns GitHub IO.

This module is not wired to the production controller. A gateway must return
complete fresh snapshots, enforce repository/author identity, and ensure that
the reported test evidence comes from the configured trusted CI. No mutation
occurs on an exception, incomplete snapshot, or unconfirmed protection.
"""

from pr_admission import evaluate


def _decision(snapshot, trusted_authors):
    if not isinstance(snapshot, dict) or snapshot.get("complete") is not True:
        return "incomplete-snapshot"
    pr = snapshot.get("pr")
    if not isinstance(pr, dict):
        return "incomplete-snapshot"
    if (pr.get("base_ref") != "smoke" or pr.get("same_repository") is not True
            or pr.get("auto_merge_enabled") is not False):
        return "unsupported-pr"
    return evaluate(pr, snapshot.get("issue"), snapshot.get("comments"), trusted_authors)


def admission_step(gateway, pr_number, trusted_authors):
    """Publish an initial result or attempt one guarded final merge.

    The gateway returns `checks` as one of `pending`, `failure` or `success`
    for explicitly configured required test checks on the snapshot's head.
    An absent/unknown value never authorizes a merge. Repeated calls do not
    schedule tests or enable GitHub auto-merge. The gateway must independently
    authenticate and verify the repository and required protection before it
    can claim `protection` true. An uncertain merge is resolved by a later
    fresh read, never retried by this function.
    """
    if type(pr_number) is not int or pr_number <= 0:
        raise ValueError("Invalid pull request number")
    first = gateway.read_snapshot(pr_number)
    verdict = _decision(first, trusted_authors)
    pr = first.get("pr") if isinstance(first, dict) else None
    head = pr.get("head_sha") if isinstance(pr, dict) else None
    if isinstance(head, str):
        gateway.publish(head, verdict)
    if verdict != "ready":
        return verdict
    if first.get("protection") is not True:
        return "protection-unverified"
    if first.get("checks") != "success":
        return "waiting-tests" if first.get("checks") == "pending" else "tests-not-green"
    second = gateway.read_snapshot(pr_number)
    verdict = _decision(second, trusted_authors)
    if verdict != "ready":
        second_pr = second.get("pr") if isinstance(second, dict) else None
        second_head = second_pr.get("head_sha") if isinstance(second_pr, dict) else None
        if isinstance(second_head, str):
            gateway.publish(second_head, verdict)
        return verdict
    if second["pr"]["head_sha"] != head:
        return "head-changed"
    if any(first.get(key) != second.get(key) for key in ("pr", "issue", "comments")):
        gateway.publish(head, "review-input-changed")
        return "review-input-changed"
    if second.get("protection") is not True or second.get("checks") != "success":
        return "checks-or-protection-changed"
    # GitHub must enforce `head` as its expected head in the merge call.
    # A thrown error or timeout is propagated; no blind second write is made.
    gateway.merge(pr_number, head)
    return "merge-requested"
