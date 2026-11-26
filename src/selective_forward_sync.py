"""Publish a tree-preserving forward sync through a protected GitHub PR."""
import base64
import os
import re
import subprocess
import tempfile
from urllib.parse import urlencode

from mvp_errors import GitHubRequestError
from promotion_plan import SHA
from selective_promotion_flow import prepare_forward_sync

ENABLE_AUTO_MERGE = """mutation($id:ID!) {
  enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:MERGE}) {
    pullRequest { id }
  }
}"""


def fetch_refs(path, repository, token):
    """Fetch only the two branch histories. Keep authorization out of argv and Git config."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")
    url = f"https://github.com/{repository}.git"
    options = ["git", "-c", f"core.hooksPath={os.devnull}", "-C", str(path)]
    subprocess.run([*options, "init", "--bare", "--quiet"], env=env, check=True,
                   capture_output=True, timeout=20)
    authorization = base64.b64encode(("x-access-token:" + token).encode("ascii")).decode("ascii")
    env.update(GIT_CONFIG_COUNT="2", GIT_CONFIG_KEY_0=f"http.{url}.extraHeader",
               GIT_CONFIG_VALUE_0="Authorization: Basic " + authorization,
               GIT_CONFIG_KEY_1="http.followRedirects", GIT_CONFIG_VALUE_1="false")
    subprocess.run([*options, "fetch", "--quiet", "--no-tags", url,
                    "refs/heads/main:refs/remotes/origin/main", "refs/heads/smoke:refs/remotes/origin/smoke"],
                   env=env, check=True, capture_output=True, timeout=120)


def publish_forward_sync(transport, token, project, journal, pr, main, verify_app_id, *, fetch=fetch_refs):
    owner, name = project["owner"], project["repository"]
    repository = f"{owner}/{name}"
    repository_id, bot_id = project["repository_id"], project.get("admission_sync_bot_id")
    if (not SHA.fullmatch(main) or not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9][A-Za-z0-9_.-]*", repository)
            or type(bot_id) is not int or bot_id <= 0 or type(verify_app_id) is not int or verify_app_id <= 0):
        return "forward-sync-blocked"

    root = f"/repos/{repository}"
    branch = f"sync-main/{main}"

    def get(path):
        return transport(root + path, token)[0]

    def post(path, body):
        return transport(root + path, token, body=body)[0]

    def ref(name):
        sha = get(f"/git/ref/heads/{name}")["object"]["sha"]
        if not SHA.fullmatch(sha):
            raise ValueError("Invalid ref")
        return sha

    def stable(smoke):
        policy = get("/branches/smoke/protection")
        checks = policy.get("required_status_checks") or {}
        return (checks.get("strict") is True and (policy.get("enforce_admins") or {}).get("enabled") is True
                and {"context": "verify", "app_id": verify_app_id} in checks.get("checks", [])
                and get("/rules/branches/smoke") == [] and ref("main") == main and ref("smoke") == smoke)

    def read_commit(head, smoke, tree):
        commit = get(f"/git/commits/{head}")
        return (commit["sha"] == head and [item["sha"] for item in commit["parents"]] == [smoke, main]
                and commit["tree"]["sha"] == tree)

    try:
        details = get("")
        if (details["id"] != repository_id or details.get("allow_merge_commit") is not True
                or details.get("allow_auto_merge") is not True):
            return "forward-sync-blocked"
        smoke = ref("smoke")
        comparison = get(f"/compare/{main}...{smoke}?per_page=1")
        if (comparison.get("status") in ("ahead", "identical")
                and (comparison.get("merge_base_commit") or {}).get("sha") == main
                and ref("smoke") == smoke):
            return "merged"
        if not stable(smoke):
            return "forward-sync-blocked"

        with tempfile.TemporaryDirectory(prefix="agf-sync-") as path:
            fetch(path, repository, token)
            candidate = prepare_forward_sync(path, journal, repository_id, pr, smoke)
        if candidate["kind"] != "sync-ready" or candidate["main"] != main:
            return "forward-sync-blocked"
        tree = candidate["tree"]

        try:
            head = ref(branch)
        except GitHubRequestError as error:
            if error.category != "http-404":
                raise
            if not stable(smoke):
                return "forward-sync-blocked"
            head = post("/git/commits", {"message": f"Sync main {main} into smoke",
                                         "tree": tree, "parents": [smoke, main]})["sha"]
            if not SHA.fullmatch(head) or not read_commit(head, smoke, tree) or not stable(smoke):
                return "forward-sync-blocked"
            post("/git/refs", {"ref": f"refs/heads/{branch}", "sha": head})
        if not read_commit(head, smoke, tree) or ref(branch) != head or not stable(smoke):
            return "forward-sync-blocked"

        query = urlencode({"state": "all", "head": f"{owner}:{branch}", "base": "smoke", "per_page": 100})
        rows = get(f"/pulls?{query}")
        if len(rows) >= 100:
            return "forward-sync-blocked"
        rows = [row for row in rows if row["state"] == "open" or row["head"]["sha"] == head]
        if len(rows) > 1:
            return "forward-sync-blocked"
        if not rows:
            created = post("/pulls", {"base": "smoke", "head": branch, "draft": False,
                                      "title": "Synchronize main into smoke after selective promotion"})
            number = created["number"]
        else:
            number = rows[0]["number"]
        pull = get(f"/pulls/{number}")
        if (pull["number"] != number or pull["state"] != "open" or pull["draft"] is not False
                or pull["user"]["id"] != bot_id or pull["base"]["ref"] != "smoke"
                or pull["head"]["ref"] != branch or pull["base"]["sha"] != smoke or pull["head"]["sha"] != head
                or pull["base"]["repo"]["id"] != repository_id or pull["head"]["repo"]["id"] != repository_id
                or not stable(smoke) or ref(branch) != head):
            return "forward-sync-blocked"
        auto = pull["auto_merge"]
        if auto is not None:
            return ("waiting-checks" if auto["enabled_by"]["id"] == bot_id and auto["merge_method"] == "merge"
                    else "forward-sync-blocked")
        result, _ = transport("/graphql", token, body={"query": ENABLE_AUTO_MERGE,
                                                      "variables": {"id": pull["node_id"]}})
        if result.get("errors") or result["data"]["enablePullRequestAutoMerge"]["pullRequest"]["id"] != pull["node_id"]:
            return "forward-sync-blocked"
        return "waiting-checks"
    except (GitHubRequestError, KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError):
        return "forward-sync-blocked"
