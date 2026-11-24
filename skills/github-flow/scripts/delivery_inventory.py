"""Live read-only delivery diagnostic for the registered AGF fleet."""
import datetime
import json
import subprocess
import sys
from pathlib import Path

QUERY = """query($owner:String!, $name:String!) {
  repository(owner:$owner,name:$name) {
    databaseId
    defaultBranchRef {name target {... on Commit {oid tree {oid}}}}
    smoke:ref(qualifiedName:"refs/heads/smoke"){target {... on Commit {oid}}}
    main:ref(qualifiedName:"refs/heads/main"){target {... on Commit {oid}}}
  }
}"""


def read(args, *, stdin=None):
    result = subprocess.run(args, input=stdin, capture_output=True, encoding="utf-8", timeout=45)
    if result.returncode:
        raise ValueError("metadata unavailable")
    return json.loads(result.stdout)


def source(project):
    owner, name = project["repository"].split("/")
    data = read(["gh", "api", "graphql", "-f", "query=" + QUERY, "-f", "owner=" + owner, "-f", "name=" + name])
    repo = data["data"]["repository"]
    if data.get("errors") or repo["databaseId"] != project["repository_id"]:
        raise ValueError("repository identity unverified")
    default = repo["defaultBranchRef"]["target"]
    heads = {k: (repo[k] or {}).get("target", {}).get("oid") for k in ("smoke", "main")}
    templates = None
    try:
        tree = read(["gh", "api", "repos/" + project["repository"] + "/git/trees/" + default["tree"]["oid"] + "?recursive=1"])
        if not tree["truncated"]:
            templates = [e["path"] for e in tree["tree"] if e["type"] == "blob" and
                         e["path"].lower().startswith(".github/issue_template/") and
                         e["path"].lower().endswith((".md", ".yaml", ".yml")) and
                         e["path"].lower().split("/")[-1] not in ("config.yml", "config.yaml")]
    except (ValueError, OSError, subprocess.TimeoutExpired, KeyError):
        pass
    return heads, templates


def assess(enabled, ledger, head):
    success = (ledger or {}).get("last_success")
    if not enabled:
        state = "outside-central-deployment"
    elif ledger is None:
        state = "ledger-unavailable"
    elif ledger.get("latest") not in (None, "succeeded"):
        state = "latest-" + ledger["latest"]
    elif not success:
        state = "no-recorded-success"
    elif not head:
        state = "branch-unverified"
    elif success == head:
        state = "recorded-success-at-head"
    else:
        state = "head-without-confirmation"
    return {"state": state, "head": head, "last_success": success,
            "latest_attempt": ledger, "owner": "AGF + project executor" if enabled else "outside AGF; consult project"}


def main():
    collector = Path(__file__).with_name("controller_inventory.py").read_text(encoding="utf-8")
    projects = read(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "mikrus",
                     "sudo", "-n", "-u", "agent-flow", "python3", "-"], stdin=collector)
    for p in projects:
        try:
            heads, templates = source(p)
        except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
            heads, templates = {}, None
        ledger = p.pop("ledger")
        p["issue_templates_on_default"] = templates
        p["owners"] = {"contract_review": "project agent", "board": "AGF",
                       "pr_transitions": "AGF" if p["pr_flow"] else "unverified",
                       "admission": "AGF" if p["admission"] else "unverified",
                       "ci": "project", "smoke": "owner + agent", "closure": "owner",
                       "promotion": "AGF" if p["promotion"] else "outside AGF; consult project"}
        p["deployment"] = {k: assess(k in p["targets"], None if ledger is None else ledger.get(k, {}),
                                     heads.get(k)) for k in ("smoke", "main")}
    print(json.dumps({"read_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "projects": projects}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.TimeoutExpired):
        sys.exit("Controller inventory unavailable; no fleet assessment.")
