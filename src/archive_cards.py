"""Preview AGF card archiving, or apply it to one eligible issue."""
import argparse
import json
import os
from datetime import datetime, timezone

from archive_promotion import archive_evidence
from mvp_archive import archive_candidates, archive_one
from mvp_credentials import AppToken, read_private_file
from mvp_errors import GitHubRequestError
from mvp_github import GitHub
from mvp_service import _load, _lock
from mvp_store import Store


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", help="Enrolled OWNER/REPO")
    parser.add_argument("--issue", type=int)
    parser.add_argument("--apply", action="store_true", help="Archive the specified issue card")
    parser.add_argument("--config", default="/etc/agent-github-flow-mvp/config.json")
    args = parser.parse_args()
    if (args.apply and args.issue is None) or (args.issue is not None and args.issue <= 0):
        parser.error("Supply one positive issue number for --apply")

    lock = None
    try:
        config = _load(args.config)
        project, = [project for project in config["projects"]
                    if f"{project['owner']}/{project['repository']}".casefold() == args.repository.casefold()]
        if project.get("status_enabled") is False:
            parser.exit(1, "This Project is not managed by the controller.\n")
        if args.apply and not (config.get("archive_enabled") is True
                               and project.get("archive_require_evidence") is True):
            parser.exit(1, "Evidence-based archiving is not enabled for this repository.\n")

        repo_id = project["repository_id"]
        key = read_private_file(config["app_key_path"])
        token = AppToken(config["app_id"], config["installation_id"], repo_id, key, purpose="archive_proof")
        github = GitHub(repository_id=repo_id, owner=project["owner"], repository=project["repository"],
                        project_owner=project["project_owner"], project_number=project["project_number"],
                        app_token=token, project_token=read_private_file(config["project_token_path"]).strip().decode())
        evidence = archive_evidence(config, project, key)
        if args.apply:
            try:
                lock = _lock(config["state_path"] + ".archive.lock")
            except BlockingIOError:
                parser.exit(1, "Another archive operation is active. Try again after it finishes.\n")
        now = datetime.now(timezone.utc)
        candidates = [candidate for candidate in archive_candidates(github, now)
                      if args.issue is None or args.issue == candidate[0]]
        results = []
        for candidate in candidates:
            outcome = archive_one(github, candidate, now, evidence=evidence, dry_run=not args.apply)
            if outcome == "changed":
                Store(config["state_path"]).enqueue_now(repo_id, candidate[0])
            results.append({"issue": candidate[0], "outcome": outcome})
        if args.issue is not None and not results:
            results.append({"issue": args.issue, "outcome": "not-a-candidate"})
    except (GitHubRequestError, OSError, RuntimeError, ValueError, KeyError, TypeError):
        parser.exit(1, "Archive result unavailable. Check current card state before retrying.\n")
    finally:
        if lock is not None:
            os.close(lock)
    print(json.dumps({"dry_run": not args.apply, "cards": results}, indent=2))
    return int(args.apply and results[0]["outcome"] != "archived")


if __name__ == "__main__":
    raise SystemExit(main())
