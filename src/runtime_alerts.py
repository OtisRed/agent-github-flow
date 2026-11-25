"""Create repository-scoped operational issues from trusted local services."""
import argparse
import json
import os
import re
import socket
import sqlite3
import struct
import sys
import time
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from mvp_credentials import AppToken, read_private_file
from mvp_errors import GitHubRequestError
from mvp_github import request

KIND = re.compile(r"[a-z][a-z0-9-]{0,63}")
REPOSITORY = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+")
LEGACY_MARKER = re.compile(r"<!-- [A-Za-z0-9:_-]{1,120} -->")


def parse_config(raw):
    peers = {}
    destinations = {}
    for entry in json.loads(raw)["services"]:
        uid, repository_id, repository = (entry["uid"], entry["repository_id"], entry["repository"])
        if (type(uid) is not int or uid < 0 or uid in peers
                or type(repository_id) is not int or repository_id <= 0
                or not REPOSITORY.fullmatch(repository) or repository.split("/")[1] in (".", "..")):
            raise ValueError("Invalid alert service")
        alerts = {}
        for kind, template in entry["alerts"].items():
            title, body = template["title"], template["body"]
            legacy = template.get("legacy_marker")
            if (not KIND.fullmatch(kind) or not isinstance(title, str) or not title.strip()
                    or len(title) > 200 or any(ord(char) < 32 for char in title)
                    or not isinstance(body, str) or not body.strip() or len(body) > 2000
                    or (legacy is not None and not LEGACY_MARKER.fullmatch(legacy))):
                raise ValueError("Invalid alert template")
            destination = (repository.lower(), title, body, legacy)
            if destinations.setdefault((repository_id, kind), destination) != destination:
                raise ValueError("Conflicting alert template")
            alerts[kind] = (title, body, legacy)
        peers[uid] = (repository_id, repository, alerts)
    return peers


def receive_kind(connection):
    deadline = time.monotonic() + 3
    raw = b""
    while b"\n" not in raw:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Alert read timed out")
        connection.settimeout(remaining)
        part = connection.recv(257 - len(raw))
        raw += part
        if not part or len(raw) > 256:
            raise ValueError("Invalid alert request")
    if not raw.endswith(b"\n") or raw.count(b"\n") != 1:
        raise ValueError("Invalid alert request")
    pairs = json.loads(raw, object_pairs_hook=lambda items: items)
    if (not raw.lstrip().startswith(b"{") or len(pairs) != 1 or pairs[0][0] != "kind"
            or not isinstance(pairs[0][1], str) or not KIND.fullmatch(pairs[0][1])):
        raise ValueError("Invalid alert request")
    return pairs[0][1]


def issue_number(issue):
    number = issue.get("number")
    if type(number) is not int or number <= 0 or "pull_request" in issue:
        raise ValueError("Invalid issue response")
    return number


def find_issue(get, endpoint, markers, *, state):
    for page in range(1, 11):
        issues = get(f"{endpoint}?state={state}&per_page=100&page={page}")
        if not isinstance(issues, list):
            raise ValueError("Invalid issue list")
        for issue in issues:
            if "pull_request" in issue or issue.get("state") not in (("open",) if state == "open" else ("open", "closed")):
                continue
            lines = (issue.get("body") or "").splitlines()
            if any(marker in lines for marker in markers):
                return issue_number(issue)
        if len(issues) < 100:
            return None
    raise RuntimeError("Alert search exceeded limit")


def report_alert(db, route, kind, token, *, transport=request):
    repository_id, repository, alerts = route
    title, message, legacy = alerts[kind]
    repository_path = f"/repos/{repository}"
    endpoint = f"{repository_path}/issues"

    def get(path):
        return transport(path, token)[0]

    if get(repository_path).get("id") != repository_id:
        raise ValueError("Unexpected repository")
    marker = f"<!-- agf-runtime-alert:v1:{kind} -->"
    markers = (marker, legacy) if legacy else (marker,)
    db.execute("""CREATE TABLE IF NOT EXISTS alerts (
        repository_id INTEGER, kind TEXT, attempt TEXT NOT NULL, number INTEGER,
        PRIMARY KEY (repository_id, kind))""")
    key = (repository_id, kind)
    saved = db.execute("SELECT attempt, number FROM alerts WHERE repository_id=? AND kind=?", key).fetchone()

    def remember(number):
        db.execute("UPDATE alerts SET number=? WHERE repository_id=? AND kind=?", (number, *key))
        db.commit()

    if saved:
        attempt, number = saved
        if number is None:
            attempt_marker = f"<!-- agf-runtime-alert-attempt:v1:{attempt} -->"
            number = find_issue(get, endpoint, (attempt_marker,), state="all")
            if number is None:
                return {"status": "pending"}
            remember(number)
            return {"status": "existing", "issue": number}
        issue = get(f"{endpoint}/{number}")
        if issue_number(issue) != number or issue.get("state") not in ("open", "closed"):
            raise ValueError("Invalid issue response")
        if issue["state"] == "open":
            return {"status": "existing", "issue": number}

    existing = find_issue(get, endpoint, markers, state="open")
    if existing is not None:
        db.execute("INSERT OR REPLACE INTO alerts VALUES (?, ?, ?, ?)", (*key, uuid4().hex, existing))
        db.commit()
        return {"status": "existing", "issue": existing}

    attempt = uuid4().hex
    db.execute("INSERT OR REPLACE INTO alerts VALUES (?, ?, ?, NULL)", (*key, attempt))
    db.commit()
    body = f"{marker}\n<!-- agf-runtime-alert-attempt:v1:{attempt} -->\n\n{message}"
    try:
        created = transport(endpoint, token, body={"title": title, "body": body})[0]
    except GitHubRequestError as error:
        if error.category in {"http-401", "http-403", "http-404", "http-429"}:
            db.execute("DELETE FROM alerts WHERE repository_id=? AND kind=?", key)
            db.commit()
        raise
    number = issue_number(created)
    remember(number)
    return {"status": "created", "issue": number}


def handle(connection, uid, peers, publish):
    route = peers.get(uid)
    if route is None:
        return {"status": "denied"}
    kind = receive_kind(connection)
    if kind not in route[2]:
        return {"status": "denied"}
    return publish(route, kind)


def main():
    import fcntl

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--routes", required=True)
    parser.add_argument("--app-config", required=True)
    parser.add_argument("--state", type=Path, required=True)
    args = parser.parse_args()

    def publish(route, kind):
        config = json.loads(read_private_file(args.app_config))
        token = AppToken(config["app_id"], config["installation_id"], route[0],
                         read_private_file(config["app_key_path"]), purpose="runtime_alert")
        # The lock spans the GitHub read/create sequence across socket-activated processes.
        with (args.state / "alerts.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {"status": "busy"}
            with closing(sqlite3.connect(args.state / "alerts.sqlite3")) as db:
                return report_alert(db, route, kind, token())

    with socket.fromfd(sys.stdin.fileno(), socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        try:
            credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("iII"))
            _, uid, _ = struct.unpack("iII", credentials)
            reply = handle(connection, uid, parse_config(read_private_file(args.routes)), publish)
        except (KeyError, OSError, TypeError, ValueError, RuntimeError, sqlite3.Error, AttributeError):
            print("runtime_alert_request_failed", file=sys.stderr)
            reply = {"status": "error"}
        try:
            connection.settimeout(3)
            connection.sendall(json.dumps(reply, separators=(",", ":")).encode("ascii") + b"\n")
        except OSError:
            print("runtime_alert_reply_failed", file=sys.stderr)


if __name__ == "__main__":
    main()
