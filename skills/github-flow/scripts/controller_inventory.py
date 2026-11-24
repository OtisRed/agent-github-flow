"""Read selected AGF configuration and ledger metadata as the controller account."""
import json
import sqlite3
from pathlib import Path


def inventory(config):
    projects = []
    for p in config["projects"]:
        enabled = p.get("deployment_enabled", False)
        projects.append({
            "repository": p["owner"] + "/" + p["repository"],
            "repository_id": p["repository_id"],
            "project_owner": p["project_owner"], "project": p["project_number"],
            "pr_flow": p.get("pr_flow_enabled", False),
            "admission": p.get("admission_enabled", False),
            "checks": [c["context"] for c in p.get("admission_tests", [])],
            "promotion": p.get("promotion_enabled", False),
            "targets": (["smoke"] if p.get("deployment_smoke_only") else ["smoke", "main"]) if enabled else [],
            "ledger": {},
        })
    try:
        uri = Path(config["deployment_state_path"]).as_uri() + "?mode=ro"
        db = sqlite3.connect(uri, uri=True)
        try:
            if db.execute("pragma application_id").fetchone()[0] != 0x41474450 or db.execute("pragma user_version").fetchone()[0] != 1:
                raise ValueError("unknown ledger schema")
            by_id = {p["repository_id"]: p for p in projects}
            for rid, target, commit, status in db.execute("""
                select repository_id,json_extract(request,'$.target'),json_extract(request,'$.commit'),status
                from deployment order by sequence desc
            """):
                if rid in by_id and target in ("smoke", "main"):
                    entry = by_id[rid]["ledger"].setdefault(target, {"latest": status, "requested": commit})
                    if status == "succeeded":
                        entry.setdefault("last_success", commit)
        finally:
            db.close()
    except (sqlite3.Error, KeyError, ValueError, OSError):
        for p in projects:
            p["ledger"] = None
    return projects


if __name__ == "__main__":
    with open("/etc/agent-github-flow-mvp/config.json", encoding="utf-8") as source:
        print(json.dumps(inventory(json.load(source))))
