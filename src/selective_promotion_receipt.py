"""Read the recorded selective promotion of an issue from controller state."""
import argparse
import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path

from mvp_credentials import AppToken, read_private_file
from mvp_decision import _id
from mvp_errors import GitHubRequestError
from mvp_github import request
from mvp_store import APPLICATION_ID
from promotion_plan import SHA
from selective_promotion_merge import _validated_manifest


def read_receipt(path, repository, repository_id, issue, read):
    """Verify matching journal records against a stable observed main."""
    if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository)
            or not _id(repository_id) or not _id(issue)):
        raise ValueError("Invalid repository or issue")
    root = f"/repos/{repository}"

    def main_head():
        sha = read(root + "/git/ref/heads/main")["object"]["sha"]
        if not SHA.fullmatch(sha):
            raise ValueError("Invalid main head")
        return sha

    repo = read(root)
    if repo["id"] != repository_id or repo["full_name"].casefold() != repository.casefold():
        raise ValueError("Repository identity changed")
    main = main_head()
    with closing(sqlite3.connect(Path(path).absolute().as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA application_id").fetchone() != (APPLICATION_ID,):
            raise ValueError("Not an AGF state database")
        ledger = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attempt'").fetchone()
        rows = db.execute("""
            SELECT pr, manifest, result FROM attempt
            WHERE repo = ? AND EXISTS (
                SELECT 1 FROM json_each(manifest, '$.sources') AS source
                WHERE json_extract(source.value, '$.issue') = ?
            )
            ORDER BY pr
        """, (repository_id, issue)).fetchall() if ledger else []

    receipts = []
    for pr, encoded, squash in rows:
        manifest = json.loads(encoded)
        if not _validated_manifest(manifest, pr) or manifest["repository_id"] != repository_id:
            raise ValueError("Invalid promotion journal record")
        sources = [source for source in manifest["sources"] if source["issue"] == issue]
        cycles = {source["cycle"] for source in sources}
        if len(cycles) != 1:
            raise ValueError("Invalid promotion cycle")
        entry = {"promotion_pr": pr, "cycle": cycles.pop(),
                 "source_prs": [{"pr": source["pr"], "sha": source["sha"]} for source in sources]}
        if squash is None:
            entry["status"] = "pending"
        else:
            if not SHA.fullmatch(squash):
                raise ValueError("Invalid recorded squash")
            commit = read(root + f"/git/commits/{squash}")
            if (commit["sha"] != squash or commit["tree"]["sha"] != manifest["tree"]
                    or [p["sha"] for p in commit["parents"]] != [manifest["main"]]):
                raise ValueError("Squash does not match the recorded promotion")
            on_main = squash == main or read(root + f"/compare/{squash}...{main}?per_page=1")[
                "merge_base_commit"]["sha"] == squash
            if on_main:
                entry.update(status="confirmed", squash=squash)
            else:
                entry["status"] = "not-on-main"
        receipts.append(entry)
    if main_head() != main:
        raise ValueError("Main changed while reading promotions")
    return {"repository": repository, "issue": issue, "main": main,
            "status": "recorded" if receipts else "not-recorded", "receipts": receipts}


def main():
    from mvp_service import _load

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", help="Enrolled OWNER/REPO")
    parser.add_argument("issue", type=int)
    parser.add_argument("--config", default="/etc/agent-github-flow-mvp/config.json")
    args = parser.parse_args()
    try:
        config = _load(args.config)
        project, = [p for p in config["projects"] if
                    f"{p['owner']}/{p['repository']}".casefold() == args.repository.casefold()]
        repo_id = project["repository_id"]
        key = read_private_file(config["app_key_path"])
        token = AppToken(config["app_id"], config["installation_id"], repo_id, key, purpose="deployment")()
        report = read_receipt(config["state_path"], args.repository, repo_id, args.issue,
                              lambda path: request(path, token)[0])
    except (GitHubRequestError, OSError, sqlite3.Error, ValueError, TypeError, KeyError, AttributeError):
        parser.exit(1, "Promotion receipt unavailable. Check the repository, credentials, state, and main.\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
