"""Detached, fail-closed webhook intake model for the future central controller.

This module does not start a server, call GitHub, drain its queue, or change a
Project. A future worker must independently re-read current GitHub state: GitHub
signs the body, not the event and delivery headers. No payload is persisted.
"""
import hashlib
import hmac
import json
import os
import re
import sqlite3
import stat
import uuid
from datetime import datetime, timezone
from pathlib import Path

MAX_BODY = 256 * 1024
APPLICATION_ID = 0x41474631
SCHEMA_VERSION = 1
SIGNATURE = re.compile(r"sha256=[0-9a-f]{64}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
ACTIONS = {
    "issues": frozenset({"opened", "closed", "reopened", "edited", "deleted", "transferred"}),
    "issue_comment": frozenset({"created", "edited", "deleted"}),
}
IGNORED_ISSUE_ACTIONS = frozenset({
    "assigned", "unassigned", "labeled", "unlabeled", "locked", "unlocked",
    "milestoned", "demilestoned", "pinned", "unpinned", "typed", "untyped",
})
DELIVERIES_SQL = """CREATE TABLE ingress_deliveries (
            delivery_id TEXT PRIMARY KEY,
            installation_id INTEGER NOT NULL,
            repository_id INTEGER NOT NULL,
            event TEXT NOT NULL,
            action TEXT NOT NULL,
            issue_number INTEGER NOT NULL,
            comment_id INTEGER,
            body_mac TEXT NOT NULL,
            received_at TEXT NOT NULL
        )"""
META_SQL = """CREATE TABLE ingress_meta (
            name TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )"""


def positive_id(value):
    return type(value) is int and 0 < value < 2**63


def canonical_delivery(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def validate_registry(entries):
    """Freeze explicit (installation_id, repository_id) pairs; reject ambiguity."""
    if not isinstance(entries, (list, tuple)) or not entries:
        raise ValueError("Invalid registry")
    pairs = []
    for entry in entries:
        if not isinstance(entry, (list, tuple)) or len(entry) != 2:
            raise ValueError("Invalid registry")
        installation, repository = entry
        if not positive_id(installation) or not positive_id(repository):
            raise ValueError("Invalid registry")
        pairs.append((installation, repository))
    if len(set(pairs)) != len(pairs) or len({r for _, r in pairs}) != len(pairs):
        raise ValueError("Ambiguous registry")
    return frozenset(pairs)


def check_storage(path):
    if not hasattr(os, "geteuid"):
        raise RuntimeError("POSIX host required")
    path = os.path.abspath(os.fspath(path))
    parent = os.lstat(os.path.dirname(path))
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o077:
        raise ValueError("Unsafe queue directory")
    for item in (path, path + "-journal", path + "-wal", path + "-shm"):
        try:
            entry = os.lstat(item)
        except FileNotFoundError:
            if item == path:
                raise
            continue
        if not stat.S_ISREG(entry.st_mode) or entry.st_uid != os.geteuid() or entry.st_mode & 0o077:
            raise ValueError("Unsafe queue file")
        if item in (path + "-wal", path + "-shm"):
            raise ValueError("Unexpected WAL sidecar")
    return path


def connect_existing(path):
    path = check_storage(path)
    db = sqlite3.connect(Path(path).as_uri() + "?mode=rw", uri=True, timeout=2)
    try:
        app = db.execute("PRAGMA application_id").fetchone()[0]
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if app != APPLICATION_ID or version != SCHEMA_VERSION:
            raise ValueError("Unknown queue schema")
        return db
    except BaseException:
        db.close()
        raise


def validate_schema(db, fingerprint_key):
    """Verify schema and key inside the caller's transaction/lock."""
    if db.execute("PRAGMA application_id").fetchone()[0] != APPLICATION_ID:
        raise ValueError("Unknown queue schema")
    if db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
        raise ValueError("Unknown queue schema")
    if db.execute("PRAGMA journal_mode").fetchone()[0] != "delete":
        raise ValueError("Unexpected queue journal mode")
    objects = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").fetchall()
    expected = [
        ("table", "ingress_deliveries", "ingress_deliveries", DELIVERIES_SQL),
        ("table", "ingress_meta", "ingress_meta", META_SQL),
        ("index", "sqlite_autoindex_ingress_deliveries_1", "ingress_deliveries", None),
        ("index", "sqlite_autoindex_ingress_meta_1", "ingress_meta", None),
    ]
    if objects != expected:
        raise ValueError("Unknown queue schema")
    key_marker = hmac.new(fingerprint_key, b"agf-ingress-key-identity-v1", hashlib.sha256).hexdigest()
    markers = db.execute("SELECT name,value FROM ingress_meta").fetchall()
    if (len(markers) != 1 or markers[0][0] != "fingerprint_key"
            or not isinstance(markers[0][1], str) or not DIGEST.fullmatch(markers[0][1])
            or not hmac.compare_digest(markers[0][1], key_marker)):
        raise ValueError("Unknown queue fingerprint key")


def initialize(path, fingerprint_key):
    """Create or verify this queue without migrating an unrelated database."""
    if not isinstance(fingerprint_key, bytes) or len(fingerprint_key) < 32:
        raise ValueError("Invalid fingerprint key")
    if not hasattr(os, "geteuid"):
        raise RuntimeError("POSIX host required")
    path = os.path.abspath(os.fspath(path))
    parent = os.lstat(os.path.dirname(path))
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o077:
        raise ValueError("Unsafe queue directory")
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        db = connect_existing(path)
        try:
            db.execute("BEGIN")
            validate_schema(db, fingerprint_key)
            db.commit()
        finally:
            db.close()
        return
    else:
        os.close(descriptor)
    db = sqlite3.connect(Path(path).as_uri() + "?mode=rw", uri=True, timeout=2)
    try:
        if db.execute("PRAGMA journal_mode=DELETE").fetchone()[0] != "delete":
            raise ValueError("DELETE journal unavailable")
        db.execute("PRAGMA synchronous=EXTRA")
        if db.execute("PRAGMA synchronous").fetchone()[0] != 3:
            raise ValueError("EXTRA synchronization unavailable")
        db.execute("BEGIN IMMEDIATE")
        db.execute(f"PRAGMA application_id={APPLICATION_ID}")
        db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        db.execute(DELIVERIES_SQL)
        db.execute(META_SQL)
        key_marker = hmac.new(fingerprint_key, b"agf-ingress-key-identity-v1", hashlib.sha256).hexdigest()
        db.execute("INSERT INTO ingress_meta VALUES (?,?)", ("fingerprint_key", key_marker))
        db.commit()
    finally:
        db.close()


def receive(path, secret, fingerprint_key, registry, delivery_id, event, signature, body):
    """Return a non-sensitive outcome; ignored requires an explicit 2xx policy.

    The configured registry must come from an authenticated source. Event and
    delivery_id are not authenticated by GitHub's body signature. Identical
    bodies under different IDs remain distinct; downstream state revalidation,
    a single worker, abuse controls and recovery are separate requirements.
    """
    if (not isinstance(secret, bytes) or len(secret) < 32 or not isinstance(fingerprint_key, bytes)
            or len(fingerprint_key) < 32 or hmac.compare_digest(secret, fingerprint_key)
            or not isinstance(registry, frozenset) or not registry):
        return "configuration_error"
    if not isinstance(body, bytes) or not 0 < len(body) <= MAX_BODY or not canonical_delivery(delivery_id):
        return "invalid"
    if not isinstance(signature, str) or not SIGNATURE.fullmatch(signature):
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
    comment_id = None
    if event == "issue_comment":
        comment = payload.get("comment")
        if not isinstance(comment, dict) or not positive_id(comment.get("id")):
            return "invalid"
        comment_id = comment["id"]
    body_mac = hmac.new(fingerprint_key, b"agf-ingress-body-v1\0" + body, hashlib.sha256).hexdigest()
    record = (installation_id, repository_id, event, action, issue["number"], comment_id, body_mac)
    db = None
    try:
        db = connect_existing(path)
        db.execute("PRAGMA synchronous=EXTRA")
        if db.execute("PRAGMA synchronous").fetchone()[0] != 3:
            raise ValueError("EXTRA synchronization unavailable")
        db.execute("BEGIN IMMEDIATE")
        validate_schema(db, fingerprint_key)
        old = db.execute("""SELECT installation_id,repository_id,event,action,issue_number,comment_id,body_mac
                            FROM ingress_deliveries WHERE delivery_id=?""", (delivery_id,)).fetchone()
        if old is not None:
            db.commit()
            return "duplicate" if old == record else "conflict"
        received_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        db.execute("INSERT INTO ingress_deliveries VALUES (?,?,?,?,?,?,?,?,?)", (delivery_id, *record, received_at))
        db.commit()
        return "accepted"
    except (sqlite3.Error, OSError, ValueError):
        return "storage_unavailable"
    finally:
        if db is not None:
            db.close()
