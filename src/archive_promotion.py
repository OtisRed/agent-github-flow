"""Read promotion evidence for the current closed issue cycle without changing GitHub."""
import argparse
import json
import sqlite3

from archive_cleanup import read_cleanup
from deployment_source import pull_request_merge_oid
from mvp_credentials import AppToken, read_private_file
from mvp_decision import _id
from mvp_errors import GitHubRequestError
from mvp_github import GitHub, request
from promotion_plan import SHA
from promotion_schedule import promotion_mode
from selective_promotion_github import ObservationError, _completed_cycle, _merged_sources, _pages, _require
from selective_promotion_receipt import read_receipt


def read_archive_promotion(issue, project, state_path, transport, token, project_status, *, with_cleanup=False,
                           expected_closed_at=None):
    """Confirm the complete current source set, or leave the decision blocked."""
    try:
        repo_id = project["repository_id"]
        owner, name = project["owner"], project["repository"]
        repo = f"{owner}/{name}"
        mode = promotion_mode(project)
        _require(_id(issue) and _id(repo_id), "invalid-identity")
        _require(mode in ("prefix", "selective"), "promotion-disabled")
        root = f"/repos/{repo}"

        def read(path):
            return transport(path, token)[0]

        def fetch(path):
            result = read(f"{root}/{path}")
            if expected_closed_at is not None and path == f"issues/{issue}":
                _require(result["closed_at"] == expected_closed_at, "closure-cycle-changed")
            return result

        def current_cleanup():
            return read_cleanup(_pages(fetch, f"issues/{issue}/comments"), cycle, end,
                                project["trusted_author_ids"], issue=issue)

        def refs():
            heads = tuple(fetch(f"git/ref/heads/{ref}")["object"]["sha"] for ref in ("main", "smoke"))
            _require(all(isinstance(sha, str) and SHA.fullmatch(sha) for sha in heads), "invalid-ref")
            return heads

        def contains(sha, tip):
            if sha == tip:
                return True
            ancestor = fetch(f"compare/{sha}...{tip}?per_page=1")["merge_base_commit"]["sha"]
            _require(isinstance(ancestor, str) and SHA.fullmatch(ancestor), "invalid-comparison")
            return ancestor == sha

        identity = read(root)
        _require(identity["id"] == repo_id and identity["full_name"].casefold() == repo.casefold(),
                 "repository-changed")
        cycle, start, end = _completed_cycle(fetch, project_status, issue, allow_not_planned=with_cleanup)
        if with_cleanup:
            cleanup = current_cleanup()
            if cleanup["kind"] != "confirmed":
                return {**cleanup, "issue": issue, "cycle": cycle}
            recipient = cleanup.get("worktree_transferred_to")
            if recipient is not None:
                target = fetch(f"issues/{recipient}")
                _require(target["number"] == recipient and "pull_request" not in target,
                         "invalid-worktree-recipient")
        main, smoke = refs()
        sources = _merged_sources(fetch, {issue: (start, end)}, repo_id,
                                  lambda pr: pull_request_merge_oid(transport, token, owner, name, pr))
        _require(bool(sources) or with_cleanup, "no-source-pr")
        source_prs = [{"pr": pr, "sha": sha} for pr, (_, sha) in sorted(sources.items())]
        _require(len({source["sha"] for source in source_prs}) == len(source_prs), "ambiguous-source-merge")
        _require(all(contains(source["sha"], smoke) for source in source_prs), "source-not-on-smoke")
        result = {"kind": "confirmed", "mode": mode, "issue": issue, "cycle": cycle, "main": main,
                  "source_prs": source_prs}
        if mode == "selective":
            ledger = read_receipt(state_path, repo, repo_id, issue, read)
            _require(ledger["main"] == main, "observation-changed")
            matches = [entry for entry in ledger["receipts"] if entry["cycle"] == cycle]
        if not source_prs:
            _require(mode != "selective" or not matches, "source-set-changed")
            result["promotion"] = "not-applicable"
        elif mode == "prefix":
            _require(all(contains(source["sha"], main) for source in source_prs), "source-not-on-main")
        elif not matches and project.get("archive_legacy_prefix_tip") is not None:
            tip = project["archive_legacy_prefix_tip"]
            _require(isinstance(tip, str) and SHA.fullmatch(tip), "invalid-legacy-prefix-tip")
            _require(contains(tip, main), "legacy-prefix-not-on-main")
            _require(all(contains(source["sha"], tip) for source in source_prs), "promotion-not-confirmed")
            result.update(promotion="legacy-prefix", legacy_prefix_tip=tip)
        else:
            _require(len(matches) == 1 and matches[0]["status"] == "confirmed", "promotion-not-confirmed")
            entry = matches[0]
            _require(sorted(entry["source_prs"], key=lambda item: item["pr"]) == source_prs, "source-set-changed")
            result.update(promotion_pr=entry["promotion_pr"], squash=entry["squash"])
        if with_cleanup:
            _require((cleanup["scope"] == "code") == bool(source_prs), "cleanup-scope-mismatch")
        _require(_completed_cycle(fetch, project_status, issue, allow_not_planned=with_cleanup) == (cycle, start, end)
                 and refs() == (main, smoke),
                 "observation-changed")
        if with_cleanup:
            _require(current_cleanup() == cleanup, "cleanup-changed")
            result["cleanup"] = cleanup
        return result
    except ObservationError as error:
        return {"kind": "blocked", "reason": str(error)}
    except (GitHubRequestError, OSError, sqlite3.Error, KeyError, TypeError, ValueError, AttributeError, OverflowError):
        return {"kind": "blocked", "reason": "evidence-unavailable"}


def archive_evidence(config, project, private_key, *, transport=request):
    token = AppToken(config["app_id"], config["installation_id"], project["repository_id"],
                     private_key, purpose="archive_proof")

    def read(candidate, closed_at):
        try:
            # archive_one verifies done on this exact card before and after this read.
            return read_archive_promotion(candidate[0], project, config["state_path"], transport, token(),
                                          lambda _: "done", with_cleanup=True, expected_closed_at=closed_at)
        except (GitHubRequestError, OSError, ValueError):
            return {"kind": "blocked", "reason": "evidence-unavailable"}

    return read


def main():
    from mvp_service import _load

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", help="Enrolled OWNER/REPO")
    parser.add_argument("issue", type=int)
    parser.add_argument("--with-cleanup", action="store_true", help="Require the current cleanup attestation")
    parser.add_argument("--config", default="/etc/agent-github-flow-mvp/config.json")
    args = parser.parse_args()
    try:
        config = _load(args.config)
        project, = [p for p in config["projects"] if
                    f"{p['owner']}/{p['repository']}".casefold() == args.repository.casefold()]
        repo_id = project["repository_id"]
        token = AppToken(config["app_id"], config["installation_id"], repo_id,
                         read_private_file(config["app_key_path"]), purpose="archive_proof")
        github = GitHub(repository_id=repo_id, owner=project["owner"], repository=project["repository"],
                        project_owner=project["project_owner"], project_number=project["project_number"],
                        app_token=token, project_token=read_private_file(config["project_token_path"]).strip().decode())

        def status(issue):
            card = github.read(repo_id, issue)
            return card["status"] if card.get("archived_card") is False else None

        result = read_archive_promotion(args.issue, project, config["state_path"], request, token(), status,
                                        with_cleanup=args.with_cleanup)
    except (GitHubRequestError, OSError, RuntimeError, ValueError, KeyError, TypeError):
        parser.exit(1, "Promotion evidence unavailable. Check the repository, credentials, and state.\n")
    print(json.dumps(result, indent=2))
    return int(result["kind"] != "confirmed")


if __name__ == "__main__":
    raise SystemExit(main())
