"""Read-only verification of the exact revision tested by the AGF pilot workflow."""
import argparse
import json
import re
import subprocess
from datetime import timedelta
from pathlib import Path

from mvp_decision import _date, _id
from promotion_plan import SHA


class EvidenceError(ValueError):
    pass


def _require(condition, reason):
    if not condition:
        raise EvidenceError(reason)


def _checkout_commit(log, step, checkout_sha):
    """Read the first pinned checkout before any candidate-controlled test steps."""
    _require(isinstance(log, str) and len(log) <= 4_000_000, "checkout-log-unavailable")
    start = _date(step["started_at"])
    end = _date(step["completed_at"]) + timedelta(seconds=1)
    lines = [line.split(" ", 1) for line in log.splitlines()]
    for i, entry in enumerate(lines):
        if len(entry) == 2 and entry[1].startswith("##[group]Run actions/checkout@"):
            _require(entry[1] == f"##[group]Run actions/checkout@{checkout_sha}"
                     and start <= _date(entry[0]) < end, "unexpected-first-checkout")
            for j in range(i + 1, len(lines) - 1):
                row = lines[j]
                if len(row) != 2 or _date(row[0]) >= end:
                    break
                if row[1].startswith("##[group]Run "):
                    break
                if row[1] == "[command]/usr/bin/git log -1 --format=%H":
                    proof = lines[j + 1]
                    _require(len(proof) == 2 and _date(row[0]) <= _date(proof[0]) < end
                             and SHA.fullmatch(proof[1]), "checkout-revision-missing")
                    return proof[1]
            break
    raise EvidenceError("checkout-revision-missing")


def verify_candidate_ci(read, repository, expected, policy, run_id, job_id):
    """Return verified evidence or a fail-closed reason, without altering GitHub."""
    try:
        _require(isinstance(repository, str)
                 and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository)
                 and all(_id(x) for x in (expected["repository_id"], expected["pr"], run_id, job_id,
                                          policy["workflow_id"], policy["app_id"]))
                 and all(SHA.fullmatch(expected[k]) for k in ("main", "candidate", "tree"))
                 and all(SHA.fullmatch(policy[k]) for k in ("workflow_blob", "checkout_sha"))
                 and policy["workflow_path"] == ".github/workflows/ci.yml", "invalid-input")
        repo, pr = expected["repository_id"], expected["pr"]
        base, head = expected["main"], expected["candidate"]
        root = f"repos/{repository}"

        def fetch(path):
            return read(f"{root}/{path}")

        def current_pr():
            return fetch(f"pulls/{pr}")

        def current_main():
            return fetch("git/ref/heads/main")["object"]["sha"]

        def pr_matches(item):
            return (item["number"] == pr and item["base"]["ref"] == "main"
                    and item["base"]["repo"]["id"] == repo and item["head"]["repo"]["id"] == repo
                    and item["base"]["sha"] == base and item["head"]["sha"] == head)

        live = current_pr()
        _require(current_main() == base, "main-changed")
        _require(live["state"] == "open" and pr_matches(live), "pr-changed")
        run = fetch(f"actions/runs/{run_id}")
        links = run["pull_requests"]
        _require(run["id"] == run_id and run["repository"]["id"] == repo
                 and run["workflow_id"] == policy["workflow_id"] and run["path"] == policy["workflow_path"]
                 and run["event"] == "pull_request" and run["head_sha"] == head
                 and run["status"] == "completed" and run["conclusion"] == "success"
                 and _id(run["run_attempt"]) and _id(run["check_suite_id"])
                 and len(links) == 1 and pr_matches(links[0]), "run-mismatch")
        job = fetch(f"actions/jobs/{job_id}")
        _require(job["id"] == job_id and job["run_id"] == run_id and job["run_attempt"] == run["run_attempt"]
                 and job["head_sha"] == head and job["name"] == "verify" and job["status"] == "completed"
                 and job["conclusion"] == "success"
                 and job["check_run_url"] == f"https://api.github.com/{root}/check-runs/{job_id}",
                 "job-mismatch")
        steps = [step for step in job["steps"] if step["name"] == "Check out event revision"]
        _require(len(steps) == 1 and steps[0]["status"] == "completed"
                 and steps[0]["conclusion"] == "success", "checkout-step-unverified")

        def verify_latest_check():
            response = fetch(f"commits/{head}/check-runs?check_name=verify&filter=latest&per_page=100")
            checks = response["check_runs"]
            _require(response["total_count"] == len(checks) and len(checks) < 100,
                     "checks-incomplete")
            matching = [check for check in checks if check["name"] == "verify"
                        and check["app"]["id"] == policy["app_id"]]
            # GitHub can retain separate draft and ready suites for the same head.
            # Parallel success does not substitute for evidence from the requested suite.
            by_suite = {check["check_suite"]["id"]: check for check in matching}
            item = by_suite.get(run["check_suite_id"])
            _require(item is not None and item["id"] == job_id
                     and len(by_suite) == len(matching) == len({check["id"] for check in matching})
                     and all(_id(suite) and _id(check["id"]) and check["head_sha"] == head
                             and check["status"] == "completed" and check["conclusion"] == "success"
                             for suite, check in by_suite.items()), "check-mismatch")
            return {**{key: item[key] for key in ("id", "name", "head_sha", "status", "conclusion")},
                    "app": {"id": item["app"]["id"]}}

        check = verify_latest_check()
        _require(fetch(f"contents/{policy['workflow_path']}?ref={base}")["sha"] == policy["workflow_blob"],
                 "unapproved-workflow")
        tested = _checkout_commit(fetch(f"actions/jobs/{job_id}/logs"), steps[0], policy["checkout_sha"])
        obj = fetch(f"git/commits/{tested}")
        _require(obj["sha"] == tested and [x["sha"] for x in obj["parents"]] == [base, head]
                 and obj["tree"]["sha"] == expected["tree"], "tested-tree-or-parents-mismatch")
        _require(fetch(f"contents/{policy['workflow_path']}?ref={tested}")["sha"] == policy["workflow_blob"],
                 "unapproved-tested-workflow")
        verify_latest_check()
        updated = current_pr()
        _require(current_main() == base, "main-changed")
        _require(updated["state"] == "open" and pr_matches(updated), "pr-changed")
        return {"kind": "verified", "repo": repo, "pr": pr, "main": base, "head": head,
                "run": run_id, "job": job_id, "test_commit": tested, "test_tree": obj["tree"]["sha"],
                "test_parents": [base, head], "tested_revision_verified": True, "checks": [check]}
    except EvidenceError as error:
        return {"kind": "blocked", "reason": str(error)}
    except (KeyError, TypeError, AttributeError, ValueError, OverflowError, OSError, subprocess.SubprocessError):
        return {"kind": "blocked", "reason": "evidence-unavailable"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Trusted candidate and policy JSON")
    args = parser.parse_args()
    with args.input.open(encoding="utf-8") as source:
        data = json.load(source)

    def read(path):
        result = subprocess.run(["gh", "api", "--method", "GET", path], check=True, timeout=30,
                                capture_output=True, encoding="utf-8")
        return result.stdout if path.endswith("/logs") else json.loads(result.stdout)

    result = verify_candidate_ci(read, data["repository"], data["expected"], data["policy"],
                                 data["run_id"], data["job_id"])
    print(json.dumps(result, indent=2))
    return int(result["kind"] != "verified")


if __name__ == "__main__":
    raise SystemExit(main())
