"""Wait briefly for the trusted App's admission check on the exact PR head."""

import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_github import request
from pr_admission import SHA
from pr_admission_checks import tests_state


def wait(repo, sha, app_id, token, *, transport=request, clock=time.monotonic, sleep=time.sleep, timeout=180):
    if (not isinstance(repo, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,39}/[A-Za-z0-9_.-]{1,100}", repo)
            or not isinstance(sha, str) or not SHA.fullmatch(sha)
            or type(app_id) is not int or app_id <= 0 or not isinstance(token, str) or not token):
        raise ValueError("Invalid admission wait parameters")
    deadline = clock() + timeout
    while True:
        query = urlencode({"check_name": "flow-admission", "per_page": 100})
        result, _ = transport(f"/repos/{repo}/commits/{sha}/check-runs?{query}", token)
        if (not isinstance(result, dict) or type(result.get("total_count")) is not int
                or not isinstance(result.get("check_runs"), list)
                or result["total_count"] != len(result["check_runs"]) or result["total_count"] > 100):
            raise ValueError("Incomplete admission checks")
        state = tests_state(result["check_runs"], sha, (("flow-admission", app_id),))
        if state == "success":
            return "success"
        if state in ("failure", "unknown"):
            return state
        if clock() >= deadline:
            return "timeout"
        sleep(5)


def main():
    try:
        state = wait(os.environ.get("GITHUB_REPOSITORY"), os.environ.get("PR_HEAD_SHA"),
                     int(os.environ.get("FLOW_APP_ID", "0")), os.environ.get("GH_TOKEN"))
    except (ValueError, RuntimeError):
        state = "unavailable"
    print("flow admission: " + state)
    return 0 if state == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
