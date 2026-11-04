#!/usr/bin/env python3
"""Read-only split-identity check on one configured issue; no GitHub writes."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_credentials import AppToken, read_private_file
from mvp_github import GitHub
from mvp_service import _load


def main():
    if len(sys.argv) != 4:
        raise ValueError("Expected config path, repository ID and issue number")
    config = _load(sys.argv[1])
    repository_id, issue_number = int(sys.argv[2]), int(sys.argv[3])
    project = next(p for p in config["projects"] if p["repository_id"] == repository_id)
    key = read_private_file(config["app_key_path"])
    token = read_private_file(config["project_token_path"]).decode("utf-8").strip()
    app = AppToken(config["app_id"], config["installation_id"], repository_id, key)
    app()
    print(json.dumps({"scoped_app_token": "issued"}), flush=True)
    client = GitHub(repository_id=repository_id, owner=project["owner"], repository=project["repository"],
                    project_owner=project["project_owner"], project_number=project["project_number"],
                    app_token=app, project_token=token)
    # Explicitly forbid writes even if a future adapter changes its interface.
    client.set_status = lambda *_: (_ for _ in ()).throw(RuntimeError("Writes disabled"))
    first = client.read(repository_id, issue_number)
    second = client.read(repository_id, issue_number)
    candidates = client.reconciliation_candidates(project["enrolled_at"])
    print(json.dumps({"complete": first.get("complete"), "missing_card": first.get("missing_card", False),
                      "consistent_reads": first == second, "card_in_scan": issue_number in candidates,
                      "candidate_count": len(candidates), "mutations": 0}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        raise SystemExit("Read-only probe failed: " + type(exc).__name__) from None
