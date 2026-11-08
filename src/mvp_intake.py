"""Validate a GitHub App webhook and durably wake an issue in the MVP store.

This is not an HTTP server. The event header is not covered by GitHub's body
signature, so the event is only a hint: the worker must re-read GitHub and
validate the author and current state before it makes a decision.
"""
import hashlib
import hmac
import json
import sqlite3

from webhook_ingress import ACTIONS, IGNORED_ISSUE_ACTIONS, MAX_BODY, SIGNATURE, positive_id
from pr_admission import pr_issue_number


def receive(store, secret, registry, event, signature, body, *, wake_admission=None, status_repositories=None):
    """Return 'accepted' only after the store commits; never persist a payload."""
    if not isinstance(secret, bytes) or len(secret) < 32 or not isinstance(registry, frozenset) or not registry:
        return "configuration_error"
    if status_repositories is not None and (not isinstance(status_repositories, frozenset)
            or any(not positive_id(value) for value in status_repositories)):
        return "configuration_error"
    if (not isinstance(body, bytes) or not 0 < len(body) <= MAX_BODY
            or not isinstance(signature, str) or not SIGNATURE.fullmatch(signature)):
        return "invalid"
    expected = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return "bad_signature"
    if event == "ping":
        return "ignored"
    if event in ("installation", "installation_repositories"):
        return "attention"
    admission_event = callable(wake_admission) and event in ("pull_request", "check_run")
    status_pr_event = event == "pull_request" and status_repositories is not None
    if not isinstance(event, str) or (event not in ACTIONS and not admission_event and not status_pr_event):
        return "unsupported"
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, ValueError, RecursionError):
        return "invalid"
    if not isinstance(payload, dict):
        return "invalid"
    repo, installation, issue = payload.get("repository"), payload.get("installation"), payload.get("issue")
    if not isinstance(repo, dict) or not isinstance(installation, dict):
        return "invalid"
    repository_id, installation_id = repo.get("id"), installation.get("id")
    if not positive_id(repository_id) or not positive_id(installation_id):
        return "invalid"
    if not any(registered_installation == installation_id for registered_installation, _ in registry):
        return "unknown_project"
    if (installation_id, repository_id) not in registry:
        # An installation can cover repositories that are not enrolled yet.
        # Acknowledge their signed events without queuing or processing them.
        return "ignored"
    action = payload.get("action")
    if admission_event or status_pr_event:
        if not isinstance(action, str) or not action:
            return "invalid"
        # The event header is only a wakeup hint; the worker re-reads GitHub.
        # A startup scan recovers a wakeup lost during restart.
        if admission_event:
            wake_admission()
        if event == "pull_request" and status_repositories is not None and repository_id in status_repositories:
            pr = payload.get("pull_request")
            if isinstance(pr, dict):
                try:
                    number = pr_issue_number(pr.get("body"))
                except ValueError:
                    number = None
                if positive_id(number):
                    try:
                        store.enqueue(repository_id, number)
                    except (sqlite3.Error, OSError, ValueError):
                        return "storage_unavailable"
        return "accepted"
    if event == "issues" and isinstance(action, str) and action in IGNORED_ISSUE_ACTIONS:
        return "ignored"
    if not isinstance(action, str) or action not in ACTIONS[event]:
        return "unsupported"
    if not isinstance(issue, dict) or not positive_id(issue.get("number")):
        return "invalid"
    if "pull_request" in issue:
        if event == "issue_comment" and callable(wake_admission):
            wake_admission()
            return "accepted"
        return "ignored"
    if event == "issue_comment":
        comment = payload.get("comment")
        if not isinstance(comment, dict) or not positive_id(comment.get("id")):
            return "invalid"
    if status_repositories is not None and repository_id not in status_repositories:
        if callable(wake_admission):
            wake_admission()
        return "ignored"
    try:
        store.enqueue(repository_id, issue["number"])
    except (sqlite3.Error, OSError, ValueError):
        return "storage_unavailable"
    if callable(wake_admission) and event == "issues":
        wake_admission()
    return "accepted"
