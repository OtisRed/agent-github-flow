"""Read candidate PRs for an issue; no writes or credential storage."""

from mvp_decision import _date
from mvp_github import API


def read_candidates(client, issue_number, *, token=None):
    """Read same-repository PR references, then each PR's current state.

    Cross references are discovery hints, not proof that a PR delivers an
    issue. The decision layer must validate Refs, branches and lifecycle.
    """
    if type(issue_number) is not int or issue_number <= 0:
        raise ValueError("Invalid issue number")
    root = f"/repos/{client.owner}/{client.repository}"
    token = client.app_token() if token is None else token
    events = client._rest_pages(f"{root}/issues/{issue_number}/timeline", token)
    numbers = set()
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("Invalid issue timeline")
        if event.get("event") != "cross-referenced":
            continue
        source = event.get("source")
        item = source.get("issue") if isinstance(source, dict) else None
        if not isinstance(item, dict) or item.get("pull_request") is None:
            continue
        pull = item.get("pull_request")
        if not isinstance(pull, dict):
            raise ValueError("Invalid PR reference")
        repository_url = item.get("repository_url")
        if not isinstance(repository_url, str):
            raise ValueError("Unknown PR repository")
        if repository_url.casefold() != (API + root).casefold():
            continue
        number = item.get("number")
        if type(number) is not int or number <= 0:
            raise ValueError("Invalid referenced PR")
        if not isinstance(pull.get("url"), str) or pull["url"].casefold() != (API + root + f"/pulls/{number}").casefold():
            raise ValueError("Invalid referenced PR URL")
        numbers.add(number)
    results = []
    for number in sorted(numbers):
        pr, _ = client.transport(f"{root}/pulls/{number}", token)
        if not isinstance(pr, dict) or pr.get("number") != number:
            raise ValueError("Invalid PR response")
        head, base = pr.get("head"), pr.get("base")
        if (not isinstance(head, dict) or not isinstance(base, dict)
                or not isinstance(head.get("ref"), str) or not isinstance(base.get("ref"), str)
                or pr.get("state") not in ("open", "closed") or type(pr.get("merged")) is not bool):
            raise ValueError("Invalid PR branches")
        _date(pr.get("created_at"))
        if pr["merged"]:
            _date(pr.get("merged_at"))
        head_repo, base_repo = head.get("repo"), base.get("repo")
        same = (isinstance(head_repo, dict) and isinstance(base_repo, dict)
                and head_repo.get("id") == client.repository_id
                and base_repo.get("id") == client.repository_id)
        results.append({"number": number, "body": pr.get("body"), "state": pr.get("state"),
                        "merged": pr.get("merged"), "created_at": pr.get("created_at"),
                        "merged_at": pr.get("merged_at"), "head_ref": head.get("ref"),
                        "base_ref": base.get("ref"), "same_repository": same})
    return results
