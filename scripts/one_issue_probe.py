#!/usr/bin/env python3
"""One bounded real-issue probe; never closes issues or reveals credentials."""
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_credentials import AppToken, read_private_file
from mvp_decision import _date
from mvp_github import GitHub
from mvp_service import _load
from mvp_store import Store
from mvp_worker import process_one


def main():
    if len(sys.argv) != 4:
        raise ValueError("Expected config, repository and issue")
    config = _load(sys.argv[1])
    repo, issue = int(sys.argv[2]), int(sys.argv[3])
    project = next(p for p in config["projects"] if p["repository_id"] == repo)
    key = read_private_file(config["app_key_path"])
    token = read_private_file(config["project_token_path"]).decode("utf-8").strip()
    app = AppToken(config["app_id"], config["installation_id"], repo, key)
    client = GitHub(repository_id=repo, owner=project["owner"], repository=project["repository"],
                    project_owner=project["project_owner"], project_number=project["project_number"],
                    app_token=app, project_token=token)
    initial = client.read(repo, issue)
    if (not initial.get("complete") or initial.get("state") != "OPEN"
            or _date(initial.get("created_at")) <= _date(project["enrolled_at"])):
        raise ValueError("Issue is not a new open probe issue")
    state_directory = Path(config["state_path"]).parent
    directory = Path(tempfile.mkdtemp(prefix="flow-one-issue-", dir=state_directory))
    success = False
    try:
        store = Store(directory / "state.sqlite")
        store.initialize()
        store.register_boundary(repo, project["enrolled_at"])
        store.enqueue(repo, issue)
        authors = frozenset(project["trusted_author_ids"])
        for _ in range(3):
            result = process_one(store, client, enrolled_at=project["enrolled_at"], trusted_authors=authors)
            if result["kind"] == "rescan":
                continue
            if result["kind"] != "completed":
                print(json.dumps({"result": result["kind"], "reason": result.get("reason"),
                                  "probe_state_preserved": True}))
                return 1
            final = client.read(repo, issue)
            if not final.get("complete") or final.get("state") != "OPEN" or final.get("status") != "needs-design":
                raise ValueError("Unconfirmed result")
            success = True
            print(json.dumps({"result": "confirmed", "state": "OPEN", "status": "needs-design"}))
            return 0
        print(json.dumps({"result": "rescan-limit", "probe_state_preserved": True}))
        return 1
    finally:
        if success:
            shutil.rmtree(directory)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        raise SystemExit("Probe failed: " + type(exc).__name__ + "; if started, probe state was preserved.") from None
