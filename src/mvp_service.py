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
from promotion_schedule import run_promotions
from pr_admission_service import build_readers, run_admission
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
        if 'promotion_enabled' in project and type(project['promotion_enabled']) is not bool:
            raise ValueError("Invalid promotion setting")
        if 'status_enabled' in project and type(project['status_enabled']) is not bool:
            raise ValueError("Invalid status setting")
        if 'admission_enabled' in project and type(project['admission_enabled']) is not bool:
            raise ValueError("Invalid admission setting")
        if 'dependabot_enabled' in project and type(project['dependabot_enabled']) is not bool:
            raise ValueError("Invalid Dependabot setting")
        if project.get('dependabot_enabled') is True and (project.get('status_enabled') is False
                or project.get('admission_enabled') is not True):
            raise ValueError("Dependabot requires the central status and admission owners")
        if 'pr_flow_enabled' in project and type(project['pr_flow_enabled']) is not bool:
            raise ValueError("Invalid PR handoff setting")
        if project.get('admission_enabled') is True:
            bot = project.get('admission_sync_bot_id')
            if bot is not None and (type(bot) is not int or bot <= 0):
                raise ValueError("Invalid admission sync bot")
            if project.get('admission_workflow_event', 'pull_request') not in ('pull_request', 'pull_request_target'):
                raise ValueError("Invalid admission workflow event")
            checks = project.get('admission_tests')
            if (not isinstance(checks, list) or not checks
                    or any(not isinstance(c, dict) or not isinstance(c.get('context'), str) or not c['context']
                           or type(c.get('app_id')) is not int or c['app_id'] <= 0 for c in checks)
                    or len({(c['context'], c['app_id']) for c in checks}) != len(checks)):
                raise ValueError("Invalid admission test checks")
        ids.append(project["repository_id"])
        authors = project.get("trusted_author_ids")
        if (not isinstance(authors, list) or not authors or any(type(value) is not int or value <= 0 for value in authors)
                or len(set(authors)) != len(authors)):
            raise ValueError("Invalid trusted authors")
        _date(project.get("enrolled_at"))
        if project.get("pr_flow_enabled") is True:
            if (project.get("status_enabled") is False
                    or type(project.get("pr_flow_app_author_id")) is not int
                    or project["pr_flow_app_author_id"] not in authors
                    or _date(project.get("pr_flow_enrolled_at")) < _date(project["enrolled_at"])):
                raise ValueError("Invalid PR handoff configuration")
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


def migrate_v1(config):
    """Upgrade a stopped service's existing state under its regular lock."""
    state = Path(config["state_path"])
    _private_directory(state.parent)
    info = os.stat(state, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("State file must be private and service-owned")
    fd = _lock(str(state) + ".lock")
    try:
        Store(state).migrate_v1()
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
    promotion_thread = None
    admission_thread = None
    stop = threading.Event()
    wake_admission = threading.Event()
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
            if project.get("status_enabled") is False:
                continue
            store.register_boundary(repository_id, project["enrolled_at"])
            token = AppToken(config["app_id"], config["installation_id"], repository_id, private_key)
            pr_flow = None
            pr_flow_token = None
            if project.get("pr_flow_enabled") is True:
                pr_flow_token = AppToken(config["app_id"], config["installation_id"], repository_id, private_key,
                                         purpose="pr_handoff")
                pr_flow = {"enrolled_at": project["pr_flow_enrolled_at"],
                           "app_author_id": project["pr_flow_app_author_id"]}
            client = GitHub(repository_id=repository_id, owner=project["owner"], repository=project["repository"],
                            project_owner=project["project_owner"], project_number=project["project_number"],
                            app_token=token, project_token=project_token, pr_flow_token=pr_flow_token)
            clients[repository_id] = (client, project["enrolled_at"], frozenset(project["trusted_author_ids"]), pr_flow)
        readers = build_readers(config, private_key, store=store, clients=clients)
        server = make_server(store, webhook_secret, registry, port=config["port"],
                             wake_admission=wake_admission.set if readers else None,
                             status_repositories=frozenset(clients))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        if any(p.get('promotion_enabled') is True for p in config['projects']):
            promotion_thread = threading.Thread(target=run_promotions, args=(stop, config, private_key), daemon=True)
            promotion_thread.start()
        if readers:
            admission_thread = threading.Thread(target=run_admission, args=(stop, wake_admission, readers), daemon=True)
            admission_thread.start()
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
            if promotion_thread is not None and not promotion_thread.is_alive():
                raise RuntimeError("Promotion worker stopped")
            if admission_thread is not None and not admission_thread.is_alive():
                raise RuntimeError("Admission worker stopped")
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
                    client, enrolled_at, _authors, _pr_flow = clients[repository_id]
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
            client, enrolled_at, authors, pr_flow = project
            result = process_one(store, client, enrolled_at=enrolled_at, trusted_authors=authors, row=row,
                                 pr_flow=pr_flow)
            if result["kind"] in ("read-failed", "blocked", "write-uncertain", "awaiting-card"):
                # No issue IDs, response bodies, tokens or comment contents.
                print("FLOW attention: " + result["kind"], file=sys.stderr, flush=True)
            if result["kind"] in ("rescan", "read-failed", "waiting"):
                stop.wait(1)
    finally:
        stop.set()
        wake_admission.set()
        if admission_thread is not None:
            admission_thread.join(timeout=30)
        if promotion_thread is not None:
            promotion_thread.join(timeout=10)
        if server is not None:
            if thread is not None and thread.is_alive():
                server.shutdown()
                thread.join(timeout=10)
            server.server_close()
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description="Private agent-github-flow MVP service")
    parser.add_argument("action", choices=("initialize", "migrate-v1", "run"))
    parser.add_argument("config", help="Path to a private service-owned JSON config")
    args = parser.parse_args()
    try:
        config = _load(args.config)
        if args.action == "initialize":
            initialize(config)
        elif args.action == "migrate-v1":
            migrate_v1(config)
        else:
            run(config)
    except Exception as exc:
        # Do not print file contents, tokens, paths or HTTP response bodies.
        raise SystemExit("FLOW service failed: " + type(exc).__name__) from None


if __name__ == "__main__":
    main()
