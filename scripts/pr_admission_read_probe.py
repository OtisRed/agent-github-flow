"""Owner-scoped read-only probe; emits only bounded admission metadata."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_credentials import AppToken, read_private_file
from mvp_service import _load
from pr_admission import evaluate
from pr_admission_github import AdmissionReader


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("config")
    parser.add_argument("repository_id", type=int)
    parser.add_argument("pr", type=int)
    args = parser.parse_args()
    try:
        config = _load(args.config)
        matches = [p for p in config["projects"] if p["repository_id"] == args.repository_id]
        if len(matches) != 1:
            raise ValueError("Repository is not configured")
        project = matches[0]
        private_key = read_private_file(config["app_key_path"])
        token = AppToken(config["app_id"], config["installation_id"], args.repository_id, private_key,
                         purpose="admission")
        reader = AdmissionReader(owner=project["owner"], repository=project["repository"],
                                 repository_id=args.repository_id, token=token,
                                 transport=__import__("mvp_github").request)
        snapshot = reader.read_snapshot(args.pr)
        verdict = evaluate(snapshot["pr"], snapshot["issue"], snapshot["comments"],
                           frozenset(project["trusted_author_ids"]))
        print(json.dumps({"result": "read-ok", "draft": snapshot["pr"]["draft"],
                          "same_repository": snapshot["pr"]["same_repository"], "verdict": verdict}))
    except Exception as exc:
        print(json.dumps({"result": "read-failed", "error": type(exc).__name__}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
