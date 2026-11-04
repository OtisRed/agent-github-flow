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


def receive(store, secret, registry, event, signature, body):
    """Return 'accepted' only after the store commits; never persist a payload."""
    if not isinstance(secret, bytes) or len(secret) < 32 or not isinstance(registry, frozenset) or not registry:
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
    if not isinstance(event, str) or event not in ACTIONS:
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
    if (installation_id, repository_id) not in registry:
        return "unknown_project"
    action = payload.get("action")
    if event == "issues" and isinstance(action, str) and action in IGNORED_ISSUE_ACTIONS:
        return "ignored"
    if not isinstance(action, str) or action not in ACTIONS[event]:
        return "unsupported"
    if not isinstance(issue, dict) or not positive_id(issue.get("number")):
        return "invalid"
    if "pull_request" in issue:
        return "ignored"
    if event == "issue_comment":
        comment = payload.get("comment")
        if not isinstance(comment, dict) or not positive_id(comment.get("id")):
            return "invalid"
    try:
        store.enqueue(repository_id, issue["number"])
    except (sqlite3.Error, OSError, ValueError):
        return "storage_unavailable"
    return "accepted"
