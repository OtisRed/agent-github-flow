#!/usr/bin/env python3
"""Bounded GitHub App webhook spike: authenticate and durably record metadata.

This service never calls GitHub, changes issues, or changes Projects. It must
run on loopback behind HTTPS; neither request bodies nor credentials are logged.
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import socket
import socketserver
import sqlite3
import stat
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

MAX_BODY = 256 * 1024
HEX_SIGNATURE = re.compile(r"sha256=[0-9a-f]{64}\Z")
DISPATCH_ACTION = "agf_webhook_spike_v1"
EVENT_ACTIONS = {
    "issues": {"opened", "closed", "reopened"},
    "issue_comment": {"created", "edited", "deleted"},
    "repository_dispatch": {DISPATCH_ACTION},
}


def initialize(database):
    parent = os.stat(os.path.dirname(os.path.abspath(database)))
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o077:
        raise ValueError("Unsafe storage directory")
    for filename in (database, database + "-wal", database + "-shm"):
        try:
            entry = os.lstat(filename)
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(entry.st_mode) or entry.st_uid != os.geteuid() or entry.st_mode & 0o077:
            raise ValueError("Unsafe storage file")
    with sqlite3.connect(database, timeout=2) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("""CREATE TABLE IF NOT EXISTS deliveries (
          delivery_id TEXT PRIMARY KEY, event TEXT NOT NULL, action TEXT NOT NULL,
          issue_number INTEGER, comment_id INTEGER, signature TEXT NOT NULL,
          received_at TEXT NOT NULL
        )""")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS deliveries_signature ON deliveries(signature)")


def checked_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def positive_int(value):
    return type(value) is int and 0 < value < 2**63


def save_delivery(database, delivery_id, event, action, issue_number, comment_id, signature):
    # Commit precedes any 2xx response. The existing GitHub delivery ID is the
    # deduplication key; the keyed digest detects conflicting redeliveries.
    with sqlite3.connect(database, timeout=2) as db:
        db.execute("PRAGMA synchronous=FULL")
        db.execute("BEGIN IMMEDIATE")
        old = db.execute("SELECT event, action, issue_number, comment_id, signature FROM deliveries WHERE delivery_id=?", (delivery_id,)).fetchone()
        record = (event, action, issue_number, comment_id, signature)
        if old is not None:
            return "duplicate" if old == record else "conflict"
        if db.execute("SELECT 1 FROM deliveries WHERE signature=?", (signature,)).fetchone() is not None:
            return "conflict"
        received_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        db.execute("INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, ?, ?)", (delivery_id, *record, received_at))
    return "stored"


def create_handler(secret, database, repository_id, installation_id):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format, *args):
            # Standard library logs request paths; keep all request data private.
            return

        def respond(self, status):
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def do_GET(self):
            self.respond(200 if self.path == "/agf-spike/health" else 404)

        def do_POST(self):
            if self.path != "/agf-spike/webhook":
                return self.respond(404)
            for name in ("Content-Length", "X-Hub-Signature-256", "X-GitHub-Event", "X-GitHub-Delivery"):
                if len(self.headers.get_all(name, [])) != 1:
                    return self.respond(400)
            if self.headers.get("Transfer-Encoding") is not None:
                return self.respond(400)
            length = self.headers.get("Content-Length", "")
            signature = self.headers.get("X-Hub-Signature-256", "")
            delivery_id = self.headers.get("X-GitHub-Delivery", "")
            event = self.headers.get("X-GitHub-Event", "")
            if not length.isascii() or not length.isdigit() or len(length) > 7 or not 0 < int(length) <= MAX_BODY:
                return self.respond(413)
            if not HEX_SIGNATURE.fullmatch(signature) or not checked_uuid(delivery_id):
                return self.respond(403)
            self.connection.settimeout(5)
            try:
                body = self.rfile.read(int(length))
            except (TimeoutError, OSError):
                return self.respond(408)
            if len(body) != int(length):
                return self.respond(400)
            expected = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, signature):
                return self.respond(403)
            try:
                data = json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
                return self.respond(400)
            if not isinstance(data, dict):
                return self.respond(400)
            if event == "ping":
                return self.respond(204)
            # One installation and one real project only. Other authentic App
            # events are acknowledged without storage or downstream action.
            repo, install = data.get("repository"), data.get("installation")
            if not isinstance(repo, dict) or not isinstance(install, dict):
                return self.respond(202)
            if not positive_int(repo.get("id")) or not positive_int(install.get("id")):
                return self.respond(400)
            if repo.get("id") != repository_id or install.get("id") != installation_id:
                return self.respond(202)
            action = data.get("action")
            if not isinstance(action, str) or action not in EVENT_ACTIONS.get(event, set()):
                return self.respond(202)
            issue_number = comment_id = None
            if event in ("issues", "issue_comment"):
                issue = data.get("issue")
                if not isinstance(issue, dict) or "pull_request" in issue or not positive_int(issue.get("number")):
                    return self.respond(400)
                issue_number = issue["number"]
                if event == "issue_comment":
                    comment = data.get("comment")
                    if not isinstance(comment, dict) or not positive_int(comment.get("id")):
                        return self.respond(400)
                    comment_id = comment["id"]
            try:
                result = save_delivery(database, delivery_id, event, action, issue_number, comment_id, signature)
            except sqlite3.Error:
                return self.respond(503)
            return self.respond(409 if result == "conflict" else 202)

    return Handler


class BoundedHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    """Bound concurrent local connections and enforce a wall-clock deadline."""
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, address, handler):
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        def abort():
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        timer = threading.Timer(8, abort)
        timer.daemon = True
        timer.start()
        try:
            super().process_request_thread(request, client_address)
        finally:
            timer.cancel()
            self.slots.release()

    def handle_error(self, _request, _client_address):
        # Tracebacks may contain untrusted request data. Never emit them.
        return


def main():
    parser = argparse.ArgumentParser(description="Bounded read-only GitHub App webhook spike")
    parser.add_argument("--database", required=True)
    parser.add_argument("--secret-file", required=True)
    parser.add_argument("--repository-id", type=int, required=True)
    parser.add_argument("--installation-id", type=int, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    if not positive_int(args.repository_id) or not positive_int(args.installation_id) or not 1024 <= args.port <= 65535:
        sys.exit("Invalid configuration")
    try:
        with open(args.secret_file, "rb") as file:
            secret = file.read(4097)
        if len(secret) < 32 or len(secret) > 4096 or b"\n" in secret or b"\r" in secret:
            raise ValueError("Invalid secret")
        os.umask(0o077)
        initialize(args.database)
        server = BoundedHTTPServer(("127.0.0.1", args.port), create_handler(secret, args.database, args.repository_id, args.installation_id))
        server.serve_forever()
    except (OSError, ValueError, sqlite3.Error):
        sys.exit("Receiver configuration or storage unavailable")


if __name__ == "__main__":
    main()
