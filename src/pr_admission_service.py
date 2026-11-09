"""Optional central PR admission worker; disabled unless explicitly configured."""

import sys
import time
from pathlib import Path

from mvp_credentials import AppToken
from mvp_github import request
from pr_admission_github import AdmissionReader
from pr_admission_journal import MergeJournal
from pr_admission_runner import admission_step
from dependabot_github import DependabotGitHub
from dependabot_intake import intake_step
from dependabot_journal import DependabotJournal


def build_readers(config, private_key, *, transport=request, store=None, clients=None):
    readers = []
    for project in config["projects"]:
        if project.get("admission_enabled") is not True:
            continue
        repository_id = project["repository_id"]
        token = AppToken(config["app_id"], config["installation_id"], repository_id, private_key,
                         purpose="admission", transport=transport)
        tests = tuple((x["context"], x["app_id"]) for x in project["admission_tests"])
        reader = AdmissionReader(owner=project["owner"], repository=project["repository"],
                                 repository_id=repository_id, token=token, transport=transport,
                                 admission=("flow-admission", config["app_id"]), required_tests=tests,
                                 journal=MergeJournal(Path(config["state_path"]).parent, repository_id),
                                 workflow=project.get("admission_workflow", "ci.yml"),
                                 gate_job=project.get("admission_gate_job", "verify"),
                                 workflow_event=project.get("admission_workflow_event", "pull_request"),
                                 sync_bot_id=project.get("admission_sync_bot_id"))
        if project.get("dependabot_enabled") is True:
            if store is None or clients is None or repository_id not in clients:
                raise ValueError("Dependabot requires the status owner and journal")
            journal = DependabotJournal(store)
            journal.initialize()
            bot_token = AppToken(config["app_id"], config["installation_id"], repository_id, private_key,
                                 purpose="dependabot", transport=transport)
            reader.dependabot = (DependabotGitHub(clients[repository_id][0], bot_token, transport), journal)
        readers.append((reader, frozenset(project["trusted_author_ids"])))
    return readers


def run_admission(stop, wake, readers):
    """Rescan open PRs on startup, wakeups and a bounded periodic fallback."""
    reported = {}
    dependabot_retry = {}
    while not stop.is_set():
        for reader, authors in readers:
            if stop.is_set():
                break
            dependabot = getattr(reader, "dependabot", None)
            if dependabot:
                try:
                    gateway, journal = dependabot
                    for number in gateway.candidates():
                        key = (reader.repository_id, number)
                        if time.monotonic() < dependabot_retry.get(key, 0):
                            continue
                        try:
                            result = intake_step(gateway, journal, f"{gateway.client.owner}/{gateway.client.repository}",
                                                 reader.repository_id, number)
                        except Exception:
                            result = "failed"
                        if result in ("creation-unconfirmed", "issue-mismatch", "ambiguous", "pr-changed", "failed"):
                            print(f"FLOW attention: dependabot-{result} repo={reader.repository_id} pr={number}",
                                  file=sys.stderr, flush=True)
                            dependabot_retry[key] = time.monotonic() + 300
                        else:
                            dependabot_retry.pop(key, None)
                        # Bound each pass so a backlog of bot PRs does not
                        # monopolize the existing admission worker.
                        break
                except Exception:
                    print("FLOW attention: dependabot-failed", file=sys.stderr, flush=True)
            try:
                uncertain = reader.reconcile_merges()
                if uncertain and not reported.get((reader.repository_id, "uncertain")):
                    print("FLOW attention: admission-merge-uncertain", file=sys.stderr, flush=True)
                reported[(reader.repository_id, "uncertain")] = bool(uncertain)
                numbers = reader.open_pr_numbers()
            except Exception:
                print("FLOW attention: admission-list-failed", file=sys.stderr, flush=True)
                continue
            for number in numbers:
                if stop.is_set():
                    break
                try:
                    result = admission_step(reader, number, authors)
                    if result in ("tests-not-green", "sync-verified"):
                        reader.rerun_blocked_ci(number)
                    if result in ("protection-unverified", "checks-or-protection-changed"):
                        print("FLOW attention: admission-" + result, file=sys.stderr, flush=True)
                except FileExistsError:
                    if not reported.get((reader.repository_id, "uncertain")):
                        print("FLOW attention: admission-merge-uncertain", file=sys.stderr, flush=True)
                    reported[(reader.repository_id, "uncertain")] = True
                except Exception:
                    print("FLOW attention: admission-failed", file=sys.stderr, flush=True)
        wake.wait(20)
        wake.clear()
