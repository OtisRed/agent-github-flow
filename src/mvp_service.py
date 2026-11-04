"""Run one controller process on a private POSIX host; no implicit bootstrap."""
import argparse
import fcntl
import json
import os
import signal
import stat
import sys
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from mvp_credentials import AppToken, read_private_file
from mvp_decision import _date
from mvp_github import GitHub
from mvp_http import make_server
from mvp_store import Store
from mvp_worker import process_one
from webhook_ingress import validate_registry


def _private_directory(path):
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("State directory must be private and service-owned")


def _lock(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("Invalid controller lock")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def validate_config(config):
    if not isinstance(config, dict):
        raise ValueError("Invalid config")
    for name in ("app_id", "installation_id", "port"):
        if type(config.get(name)) is not int or config[name] <= 0:
            raise ValueError("Invalid config")
    if config["port"] > 65535:
        raise ValueError("Invalid port")
    for name in ("state_path", "webhook_secret_path", "project_token_path", "app_key_path"):
        if not isinstance(config.get(name), str) or not os.path.isabs(config[name]):
            raise ValueError("Invalid config path")
    projects = config.get("projects")
    if not isinstance(projects, list) or not projects:
        raise ValueError("No configured projects")
    ids = []
    for project in projects:
        if not isinstance(project, dict) or type(project.get("repository_id")) is not int or project["repository_id"] <= 0:
            raise ValueError("Invalid project")
        ids.append(project["repository_id"])
        authors = project.get("trusted_author_ids")
        if (not isinstance(authors, list) or not authors or any(type(value) is not int or value <= 0 for value in authors)
                or len(set(authors)) != len(authors)):
            raise ValueError("Invalid trusted authors")
        _date(project.get("enrolled_at"))
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate project")
    return config


def _load(path):
    return validate_config(json.loads(read_private_file(path)))


def initialize(config):
    """Explicit first creation only; never restore or replace a missing DB."""
    state = Path(config["state_path"])
    _private_directory(state.parent)
    fd = _lock(str(state) + ".lock")
    try:
        Store(state).initialize()
    finally:
        os.close(fd)


def run(config):
    state = Path(config["state_path"])
    _private_directory(state.parent)
    # Verify owner, file type and permissions without reading its content.
    info = os.stat(state, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("State file must be private and service-owned")
    fd = _lock(str(state) + ".lock")
    server = None
    thread = None
    try:
        store = Store(state)
        store.next_pending()  # fail closed on a missing or incompatible database
        webhook_secret = read_private_file(config["webhook_secret_path"]).strip()
        project_token = read_private_file(config["project_token_path"]).decode("utf-8").strip()
        private_key = read_private_file(config["app_key_path"])
        registry = validate_registry([(config["installation_id"], p["repository_id"]) for p in config["projects"]])
        clients = {}
        for project in config["projects"]:
            repository_id = project["repository_id"]
            store.register_boundary(repository_id, project["enrolled_at"])
            token = AppToken(config["app_id"], config["installation_id"], repository_id, private_key)
            client = GitHub(repository_id=repository_id, owner=project["owner"], repository=project["repository"],
                            project_owner=project["project_owner"], project_number=project["project_number"],
                            app_token=token, project_token=project_token)
            clients[repository_id] = (client, project["enrolled_at"], frozenset(project["trusted_author_ids"]))
        server = make_server(store, webhook_secret, registry, port=config["port"])
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        stop = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        zone = ZoneInfo("Europe/Warsaw")
        today = datetime.now(zone)
        last_night = today.date() if today.hour >= 2 else today.date() - timedelta(days=1)
        pending_scans = set(clients)  # startup reconciliation
        scan_reason = "startup"
        backup_pending = True
        next_scan = time.monotonic()
        while not stop.is_set():
            if not thread.is_alive():
                raise RuntimeError("Webhook listener stopped")
            now = datetime.now(zone)
            if now.hour >= 2 and now.date() != last_night:
                pending_scans.update(clients)
                scan_reason = "nightly"
                backup_pending = True
                next_scan = time.monotonic()
                last_night = now.date()
            if (pending_scans or backup_pending) and time.monotonic() >= next_scan:
                if backup_pending:
                    try:
                        store.backup()
                        backup_pending = False
                    except Exception:
                        print("FLOW attention: backup-failed", file=sys.stderr, flush=True)
                had_pending_scans = bool(pending_scans)
                for repository_id in list(pending_scans):
                    client, enrolled_at, _authors = clients[repository_id]
                    try:
                        for issue_number in client.reconciliation_candidates(enrolled_at):
                            store.enqueue(repository_id, issue_number)
                        pending_scans.remove(repository_id)
                    except Exception:
                        print("FLOW attention: reconciliation-failed", file=sys.stderr, flush=True)
                if had_pending_scans and not pending_scans:
                    print("FLOW scan: " + scan_reason + " candidates queued", flush=True)
                next_scan = time.monotonic() + 60
            row = store.next_pending()
            if row is None:
                stop.wait(1)
                continue
            project = clients.get(row["repository_id"])
            if project is None:
                store.block(row["repository_id"], row["issue_number"], row["generation"], "unknown-project")
                continue
            client, enrolled_at, authors = project
            result = process_one(store, client, enrolled_at=enrolled_at, trusted_authors=authors)
            if result["kind"] in ("read-failed", "blocked", "write-uncertain", "awaiting-card"):
                # No issue IDs, response bodies, tokens or comment contents.
                print("FLOW attention: " + result["kind"], file=sys.stderr, flush=True)
            if result["kind"] in ("rescan", "read-failed", "waiting"):
                stop.wait(1)
    finally:
        if server is not None:
            if thread is not None and thread.is_alive():
                server.shutdown()
                thread.join(timeout=10)
            server.server_close()
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description="Private agent-github-flow MVP service")
    parser.add_argument("action", choices=("initialize", "run"))
    parser.add_argument("config", help="Path to a private service-owned JSON config")
    args = parser.parse_args()
    try:
        config = _load(args.config)
        initialize(config) if args.action == "initialize" else run(config)
    except Exception as exc:
        # Do not print file contents, tokens, paths or HTTP response bodies.
        raise SystemExit("FLOW service failed: " + type(exc).__name__) from None


if __name__ == "__main__":
    main()
