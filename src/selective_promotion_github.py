"""Read the AGF promotion pilot from GitHub without mutating refs or policy."""
import argparse
import json
import re
import subprocess
from urllib.parse import urlencode

from deployment_source import pull_request_merge_oid
from mvp_decision import _date, _id
from promotion_plan import REFS, SHA, issue_reference
from selective_promotion_merge import _validated_manifest


class ObservationError(ValueError):
    pass


def _require(condition, reason):
    if not condition:
        raise ObservationError(reason)


def _pages(fetch, path, params=None):
    for page in range(1, 9):
        args = urlencode({**(params or {}), "per_page": 100, "page": page})
        batch = fetch(f"{path}?{args}")
        _require(isinstance(batch, list) and len(batch) <= 100, "malformed-page")
        yield from batch
        if len(batch) < 100:
            return
    raise ObservationError("pagination-limit")


def _cycle(fetch, project_status, issue, expected_cycle):
    row = fetch(f"issues/{issue}")
    _require(row["number"] == issue and "pull_request" not in row and row["state"] == "closed"
             and row["state_reason"] == "completed" and project_status(issue) == "done",
             "issue-not-completed")
    opened = _date(row["created_at"])
    closed_at = _date(row["closed_at"])
    events = [entry for entry in _pages(fetch, f"issues/{issue}/events")
              if entry["event"] in ("closed", "reopened")]
    _require(bool(events) and len({event["id"] for event in events}) == len(events),
             "closure-history-missing")
    events.sort(key=lambda event: (_date(event["created_at"]), event["id"]))
    last = events[-1]
    _require(last["event"] == "closed" and last["id"] == expected_cycle, "closure-cycle-changed")
    reopened = next((event for event in reversed(events[:-1]) if event["event"] == "reopened"), None)
    start = _date(reopened["created_at"]) if reopened is not None else opened
    _require(start <= closed_at and start <= _date(last["created_at"]), "closure-history-inconsistent")
    return start, min(closed_at, _date(last["created_at"]))


def _verified_sources(fetch, project_status, manifest, heads):
    groups = {}
    for source in manifest["sources"]:
        groups.setdefault(source["issue"], []).append(source)
    cycles = {}
    for issue, group in groups.items():
        _require(all(source["cycle"] == group[0]["cycle"] for source in group), "mixed-closure-cycle")
        cycles[issue] = _cycle(fetch, project_status, issue, group[0]["cycle"])

    found, seen = {}, set()
    for pr in _pages(fetch, "pulls", {"state": "all", "base": "smoke", "sort": "created", "direction": "asc"}):
        number = pr["number"]
        _require(number not in seen, "duplicate-pr-in-inventory")
        seen.add(number)
        body = pr.get("body") or ""
        claimed = {int(n) for n in REFS.findall(body)} & groups.keys()
        if not claimed:
            continue
        if pr["state"] == "closed" and pr["merged_at"] is None:
            continue
        issue = issue_reference(body)
        _require(issue in cycles and len(claimed) == 1, "ambiguous-source-link")
        _require(pr["state"] == "closed", "open-source-pr")
        start, end = cycles[issue]
        when = _date(pr["merged_at"])
        if when < start:
            continue
        _require(when < end and pr["base"]["ref"] == "smoke"
                 and pr["base"]["repo"]["id"] == manifest["repository_id"],
                 "source-outside-closed-cycle")
        found[number] = (issue, pr["merge_commit_sha"])

    expected = {source["pr"]: (source["issue"], source["sha"]) for source in manifest["sources"]}
    _require(found == expected, "source-set-changed")
    for source in manifest["sources"]:
        commit = fetch(f"git/commits/{source['sha']}")
        _require(source["method"] == "merge" and commit["sha"] == source["sha"]
                 and len(commit["parents"]) == 2, "unverified-source-method")
        main, smoke = heads
        sha = source["sha"]
        on_smoke = fetch(f"compare/{sha}...{smoke}?per_page=1")
        on_main = fetch(f"compare/{sha}...{main}?per_page=1")
        _require(on_smoke["merge_base_commit"]["sha"] == sha, "source-not-on-smoke")
        main_base = on_main["merge_base_commit"]["sha"]
        _require(SHA.fullmatch(main_base) and main_base != sha, "source-on-main-or-unverified")


def _main_protected(fetch, app_id):
    protection = fetch("branches/main/protection")
    checks = protection.get("required_status_checks") or {}
    return (checks.get("strict") is True and (protection.get("enforce_admins") or {}).get("enabled") is True
            and [(item["context"], item["app_id"]) for item in checks.get("checks", [])]
            == [("verify", app_id)] and fetch("rules/branches/main") == [])


def _observe_squash_result(fetch, candidate, row, manifest, pr, resolve_merge_oid):
    """Verify the exact merged PR and immutable commit against the trusted manifest."""

    def merged_oid(pull):
        _require(pull["state"] == "closed" and pull["merged"] is True, "candidate-not-merged")
        oid = pull.get("merge_commit_sha")
        if oid is None and resolve_merge_oid is not None:
            oid = resolve_merge_oid(pr)
        _require(isinstance(oid, str) and SHA.fullmatch(oid), "merge-commit-unavailable")
        return oid

    def main_head():
        sha = fetch("git/ref/heads/main")["object"]["sha"]
        _require(isinstance(sha, str) and SHA.fullmatch(sha), "invalid-observed-ref")
        return sha

    oid = merged_oid(row)
    main = main_head()
    commit = fetch(f"git/commits/{oid}")
    _require(commit["sha"] == oid, "merge-commit-changed")
    parents = [parent["sha"] for parent in commit["parents"]]
    tree = commit["tree"]["sha"]
    _require(parents == [manifest["main"]], "unexpected-squash-parent")
    _require(tree == manifest["tree"], "unexpected-squash-tree")
    if oid != main:
        comparison = fetch(f"compare/{oid}...{main}?per_page=1")
        _require(comparison["merge_base_commit"]["sha"] == oid, "squash-not-on-main")
    _require(merged_oid(candidate()) == oid and main_head() == main, "observation-changed")
    return {"kind": "observed", "blockers": [],
            "snapshot": {"state": "closed", "merged": True, "repository_id": manifest["repository_id"],
                         "pr": pr, "head": manifest["candidate"], "merge_commit": oid,
                         "result_parents": parents, "result_tree": tree, "reachable_from_main": True}}


def observe_candidate(read, project_status, repository, manifest, pr, app_id, *, resolve_merge_oid=None):
    """Inspect one promotion PR before a write or during result reconciliation."""
    try:
        _require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository)
                 and _id(app_id) and _validated_manifest(manifest, pr), "invalid-input")

        def fetch(path):
            return read(f"repos/{repository}/{path}")

        def refs():
            return tuple(fetch(f"git/ref/heads/{name}")["object"]["sha"] for name in ("main", "smoke"))

        def candidate():
            row = fetch(f"pulls/{pr}")
            _require(row["number"] == pr and row["base"]["ref"] == "main"
                     and row["base"]["repo"]["id"] == row["head"]["repo"]["id"] == manifest["repository_id"]
                     and row["head"]["sha"] == manifest["candidate"], "candidate-identity-changed")
            return row

        row = candidate()
        if row["state"] == "closed":
            return _observe_squash_result(fetch, candidate, row, manifest, pr, resolve_merge_oid)

        before = refs()
        _require(all(SHA.fullmatch(sha) for sha in before), "invalid-observed-ref")
        _require(row["state"] == "open", "candidate-not-open")
        _require(row["base"]["sha"] == manifest["main"], "candidate-identity-changed")
        _verified_sources(fetch, project_status, manifest, before)
        protected = _main_protected(fetch, app_id)
        updated = candidate()
        _require(all(row[k] == updated[k] for k in ("state", "draft", "mergeable_state"))
                 and updated["base"]["sha"] == manifest["main"] and refs() == before,
                 "observation-changed")
        snapshot = {"repository_id": manifest["repository_id"], "pr": pr, "state": row["state"],
                    "draft": row["draft"], "head": row["head"]["sha"], "base": row["base"]["sha"],
                    "main": before[0], "smoke": before[1], "sources": manifest["sources"],
                    "protection_verified": protected, "clean": row["mergeable_state"] == "clean"}
        blockers = [reason for condition, reason in (
            (snapshot["draft"] is not False, "draft"),
            (before != (manifest["main"], manifest["smoke"]), "refs-do-not-match-manifest"),
            (not protected, "main-protection-insufficient"),
            (not snapshot["clean"], "not-clean"),
        ) if condition]
        return {"kind": "observed", "snapshot": snapshot, "blockers": blockers}
    except ObservationError as error:
        return {"kind": "blocked", "reason": str(error)}
    except (KeyError, TypeError, AttributeError, ValueError, OverflowError, OSError, subprocess.SubprocessError):
        return {"kind": "blocked", "reason": "observation-unavailable"}


_STATUS_QUERY = """
query($owner:String!, $name:String!, $issue:Int!) {
  repository(owner:$owner, name:$name) {
    issue(number:$issue) {
      projectItems(first:100,includeArchived:true) {
        pageInfo { hasNextPage }
        nodes {
          isArchived
          project { id }
          fieldValueByName(name:"Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=argparse.FileType(encoding="utf-8"),
                        help="Operator-trusted repository, project_id, manifest, pr and app_id")
    with parser.parse_args().input as source:
        data = json.load(source)
    owner, name = data["repository"].split("/")

    def gh(*args, input_text=None):
        result = subprocess.run(["gh", "api", *args], check=True, timeout=30,
                                input=input_text, capture_output=True, encoding="utf-8")
        return json.loads(result.stdout)

    def project_status(issue):
        result = gh("graphql", "-f", f"query={_STATUS_QUERY}", "-f", f"owner={owner}",
                    "-f", f"name={name}", "-F", f"issue={issue}")
        items = result["data"]["repository"]["issue"]["projectItems"]
        _require(not result.get("errors") and items["pageInfo"]["hasNextPage"] is False,
                 "project-items-incomplete")
        matches = [node for node in items["nodes"] if node["project"]["id"] == data["project_id"]]
        _require(len(matches) == 1 and matches[0]["isArchived"] is False, "project-card-unavailable")
        return matches[0]["fieldValueByName"]["name"]

    def resolve_merge_oid(pr):
        def graphql(_path, _token, *, body):
            return gh("graphql", "--input", "-", input_text=json.dumps(body)), None

        return pull_request_merge_oid(graphql, None, owner, name, pr)

    result = observe_candidate(lambda path: gh("--method", "GET", path), project_status,
                               data["repository"], data["manifest"], data["pr"], data["app_id"],
                               resolve_merge_oid=resolve_merge_oid)
    print(json.dumps(result, indent=2))
    return int(result["kind"] != "observed" or bool(result["blockers"]))


if __name__ == "__main__":
    raise SystemExit(main())
