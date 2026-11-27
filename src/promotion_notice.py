"""Publish and verify a GitHub App notice of a confirmed selective promotion."""
import json

from mvp_decision import _date
from mvp_errors import GitHubRequestError
from deployment_source import pull_request_merge_oid
from promotion_plan import SHA
from selective_promotion_github import ObservationError, _completed_cycle, _pages, _require


def notice_body(owner, repo, cycle, pr, squash):
    return (f"[FLOW-PROMOTION]\nCycle: {cycle}\n"
            f"Promotion: https://github.com/{owner}/{repo}/pull/{pr}\nSquash: {squash}")


def notice_required(fetch, project, pr):
    since = project.get("promotion_notice_since")
    if since is None:
        return False
    row = fetch(f"pulls/{pr}")
    _require(row["number"] == pr and row["merged"] is True and row["base"]["ref"] == "main"
             and row["base"]["repo"]["id"] == project["repository_id"], "invalid-promotion-notice-source")
    return _date(row["merged_at"]) >= _date(since)


def notice_exists(fetch, issue, body, bot_id):
    identity = body.splitlines()[:2]
    matches = [item["body"] for item in _pages(fetch, f"issues/{issue}/comments")
               if (item.get("user") or {}).get("id") == bot_id and (item.get("user") or {}).get("type") == "Bot"
               and isinstance(item.get("body"), str) and item["body"].splitlines()[:2] == identity]
    _require(len(matches) <= 1, "duplicate-promotion-notice")
    _require(not matches or matches[0] == body, "conflicting-promotion-notice")
    return bool(matches)


def publish_promotion_notices(transport, token, project, journal, manifest, pr, squash, project_status):
    """On an uncertain POST, reconcile on the next pass without a second POST."""
    owner, repo, repo_id = project["owner"], project["repository"], project["repository_id"]
    root = f"/repos/{owner}/{repo}"

    def fetch(path):
        return transport(f"{root}/{path}", token)[0]

    try:
        if not notice_required(fetch, project, pr):
            return True
        recorded = journal.read(repo_id, pr)
        _require(recorded is not None and recorded[1] == squash and json.loads(recorded[0]) == manifest,
                 "promotion-notice-result-not-recorded")
        main = fetch("git/ref/heads/main")["object"]["sha"]
        _require(isinstance(main, str) and SHA.fullmatch(main)
                 and isinstance(squash, str) and SHA.fullmatch(squash)
                 and pull_request_merge_oid(transport, token, owner, repo, pr) == squash,
                 "invalid-promotion-notice-squash")
        if main != squash:
            _require(fetch(f"compare/{squash}...{main}?per_page=1")["merge_base_commit"]["sha"] == squash,
                     "promotion-notice-squash-not-on-main")
        bot_id = project["admission_sync_bot_id"]
        cycles = sorted({(source["issue"], source["cycle"]) for source in manifest["sources"]})
        _require(len({issue for issue, _ in cycles}) == len(cycles), "ambiguous-promotion-notice-cycle")
        complete = True
        for issue, cycle in cycles:
            body = notice_body(owner, repo, cycle, pr, squash)
            if notice_exists(fetch, issue, body, bot_id):
                continue
            try:
                current, _, _ = _completed_cycle(fetch, project_status, issue)
            except ObservationError as error:
                if str(error) == "issue-not-completed":
                    continue  # No notice for a currently reopened issue.
                raise
            if current != cycle:
                continue
            if not journal.claim_notice(repo_id, issue, cycle):
                complete = False
                continue
            transport(f"{root}/issues/{issue}/comments", token, body={"body": body})
            complete = notice_exists(fetch, issue, body, bot_id) and complete
        return complete
    except (GitHubRequestError, OSError, KeyError, TypeError, ValueError):
        return False
