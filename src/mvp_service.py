"""Run one controller process on a private POSIX host; no implicit bootstrap."""
import argparse
import fcntl
import json
import os
import queue
import signal
import stat
import sys
import threading
import time
from collections import deque
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from mvp_credentials import AppToken, read_private_file
from mvp_archive import archive_candidates, archive_one
from mvp_decision import _date
from mvp_errors import format_read_failure
from mvp_github import GitHub
from mvp_http import make_server
from mvp_scan import collect_in_background, stage_one
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
    if 'archive_enabled' in config and type(config['archive_enabled']) is not bool:
        raise ValueError("Invalid archive setting")
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
        scan_clients = {}
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
            # A separate read-only client avoids sharing the worker's mutable
            # snapshot and token cache with the background collector.
            scan_token = AppToken(config["app_id"], config["installation_id"], repository_id, private_key)
            scan_client = GitHub(repository_id=repository_id, owner=project["owner"], repository=project["repository"],
                                 project_owner=project["project_owner"], project_number=project["project_number"],
                                 app_token=scan_token, project_token=project_token)
            scan_clients[repository_id] = (scan_client, project["enrolled_at"])
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
        scan_backlog = deque()
        scan_in_progress = bool(pending_scans)
        scan_reason = "startup"
        scan_epoch = 0
        scan_results = None
        scan_results_epoch = None
        archive_pending = set()
        archive_backlog = deque()
        archive_in_progress = False
        archive_failed = False
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
                scan_epoch += 1
                pending_scans.update(clients)
                scan_in_progress = bool(pending_scans) or bool(scan_backlog)
                scan_reason = "nightly"
                backup_pending = True
                next_scan = time.monotonic()
                last_night = now.date()
                if config.get("archive_enabled") is True:
                    archive_pending.update(clients)
                    archive_in_progress = bool(archive_pending) or bool(archive_backlog)
                    archive_failed = False
            if (pending_scans or backup_pending) and time.monotonic() >= next_scan:
                if backup_pending:
                    try:
                        store.backup()
                        backup_pending = False
                    except Exception:
                        print("FLOW attention: backup-failed", file=sys.stderr, flush=True)
                if pending_scans and scan_results is None:
                    scan_results = collect_in_background(store, scan_clients, sorted(pending_scans), stop)
                    scan_results_epoch = scan_epoch
                    next_scan = time.monotonic() + 60
                elif not pending_scans:
                    next_scan = time.monotonic() + 60
            if scan_results is not None:
                while True:
                    try:
                        result = scan_results.get_nowait()
                    except queue.Empty:
                        break
                    if result is None:
                        scan_results = None
                        break
                    repository_id, candidates, elapsed = result
                    if candidates is None:
                        print("FLOW attention: reconciliation-failed", file=sys.stderr, flush=True)
                    else:
                        scan_backlog.extend((repository_id, number) for number in candidates)
                        if scan_results_epoch == scan_epoch:
                            pending_scans.discard(repository_id)
                    print("FLOW scan: collection seconds=" + str(round(elapsed, 1)), file=sys.stderr, flush=True)
            row = store.next_pending()
            if row is None and scan_backlog:
                try:
                    stage_one(store, scan_backlog)
                    row = store.next_pending()
                except Exception:
                    print("FLOW attention: reconciliation-failed", file=sys.stderr, flush=True)
                    stop.wait(1)
            if scan_in_progress and not pending_scans and not scan_backlog and scan_results is None:
                print("FLOW scan: " + scan_reason + " candidates queued", flush=True)
                scan_in_progress = False
            if row is None:
                # Project cards are archived only after reconciliation and
                # only when there is no ready issue work. One card per turn.
                if not pending_scans and not scan_backlog and not backup_pending and scan_results is None:
                    if archive_pending and not archive_backlog:
                        repository_id = min(archive_pending)
                        client = clients[repository_id][0]
                        try:
                            archive_backlog.extend((repository_id, candidate) for candidate in
                                                   archive_candidates(client, datetime.now(zone)))
                            archive_pending.remove(repository_id)
                        except Exception:
                            print("FLOW attention: archive-plan-failed", file=sys.stderr, flush=True)
                            archive_failed = True
                            archive_pending.remove(repository_id)  # retry on the next night
                    if archive_backlog:
                        repository_id, candidate = archive_backlog.popleft()
                        try:
                            outcome = archive_one(clients[repository_id][0], candidate, datetime.now(zone))
                            if outcome == "changed":
                                store.enqueue_now(repository_id, candidate[0])
                        except Exception:
                            print("FLOW attention: archive-write-unconfirmed", file=sys.stderr, flush=True)
                            archive_failed = True
                    if archive_in_progress and not archive_pending and not archive_backlog:
                        print("FLOW archive: nightly " + ("failed" if archive_failed else "complete"), flush=True)
                        archive_in_progress = False
                stop.wait(1)
                continue
            project = clients.get(row["repository_id"])
            if project is None:
                store.block(row["repository_id"], row["issue_number"], row["generation"], "unknown-project")
                continue
            client, enrolled_at, authors, pr_flow = project
            print("FLOW worker: step started", flush=True)
            step_started = time.monotonic()
            result = process_one(store, client, enrolled_at=enrolled_at, trusted_authors=authors, row=row,
                                 pr_flow=pr_flow)
            print("FLOW worker: step seconds=" + str(round(time.monotonic() - step_started, 1)), flush=True)
            if result["kind"] in ("read-failed", "blocked", "write-uncertain", "awaiting-card"):
                # No issue IDs, response bodies, tokens or comment contents.
                message = format_read_failure(result) if result["kind"] == "read-failed" else "FLOW attention: " + result["kind"]
                print(message, file=sys.stderr, flush=True)
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
