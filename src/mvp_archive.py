"""Nightly Project-card archiving; never changes an issue or its history."""
from datetime import datetime, timedelta, timezone

from mvp_decision import _date
from mvp_github import API, PROJECT_QUERY, UNARCHIVE_MUTATION, _node

ARCHIVE_MUTATION = """mutation($project:ID!,$item:ID!){
 archiveProjectV2Item(input:{projectId:$project,itemId:$item}){item{id}}}
"""


def archive_candidates(github, now):
    """Return an inventory only; each candidate is rechecked before writing."""
    if not isinstance(now, datetime) or now.tzinfo is None:
        raise ValueError("Timezone required")
    cutoff = now.astimezone(timezone.utc) - timedelta(days=14)
    done = github._batch_done_items()
    items = github._project_items()
    result, seen = [], set()
    repo_url = (API + f"/repos/{github.owner}/{github.repository}").casefold()
    for item in items:
        if not isinstance(item, dict) or "archived_at" not in item:
            raise ValueError("Invalid Project item")
        if item.get("content_type") != "Issue" or item["archived_at"] is not None:
            continue
        content = item.get("content") or {}
        if not isinstance(content, dict):
            raise ValueError("Invalid Project issue")
        if str(content.get("repository_url", "")).casefold() != repo_url:
            continue
        number, node, item_id = content.get("number"), item.get("node_id"), item.get("id")
        if type(number) is not int or number <= 0 or not _node(node) or type(item_id) is not int or item_id <= 0:
            raise ValueError("Invalid Project item identity")
        if number in seen:
            raise ValueError("Ambiguous Project item")
        seen.add(number)
        if node not in done or content.get("state") != "closed":
            continue
        if _date(content.get("closed_at")) <= cutoff:
            result.append((number, item_id, node))
    return result


def _snapshot(github, candidate):
    number, item_id, item_node = candidate
    token = github.app_token()
    path = f"/repos/{github.owner}/{github.repository}/issues/{number}"
    issue, _ = github.transport(path, token)
    item, _ = github.transport(f"/users/{github.project_owner}/projectsV2/{github.project_number}/items/{item_id}",
                               github.project_token)
    if not isinstance(item, dict):
        raise ValueError("Invalid archive target")
    content = item.get("content") or {}
    if (not isinstance(issue, dict) or issue.get("number") != number or not _node(issue.get("node_id"))
            or issue.get("state") not in ("open", "closed") or "pull_request" in issue
            or not isinstance(item, dict) or item.get("node_id") != item_node or item.get("id") != item_id
            or item.get("content_type") != "Issue" or content.get("node_id") != issue["node_id"]
            or content.get("number") != number or str(content.get("repository_url", "")).casefold()
                != (API + f"/repos/{github.owner}/{github.repository}").casefold()):
        raise ValueError("Invalid archive target")
    data = github._graphql(PROJECT_QUERY, {"owner": github.project_owner, "number": github.project_number,
                                           "item": item_node})
    project = (data.get("user") or {}).get("projectV2") or {}
    node = data.get("node") or {}
    field = (node.get("project") or {}).get("statusField") or {}
    value = node.get("status") or {}
    options = field.get("options")
    if (not _node(project.get("id")) or node.get("id") != item_node
            or (node.get("project") or {}).get("id") != project["id"] or not _node(field.get("id"))
            or field.get("name") != "Status" or field.get("dataType") != "SINGLE_SELECT"
            or not isinstance(options, list) or not isinstance(value, dict)):
        raise ValueError("Invalid archive Project status")
    mapping = {x.get("name"): x.get("id") for x in options if isinstance(x, dict)}
    if (len(mapping) != len(options) or value.get("name") not in mapping
            or value.get("optionId") != mapping[value["name"]]
            or (value.get("field") or {}).get("id") != field["id"]):
        raise ValueError("Invalid archive Project value")
    archived = item.get("archived_at") is not None
    if node.get("isArchived") is not archived:
        raise ValueError("Archive state changed")
    return {"state": issue["state"], "issue": issue["node_id"], "closed_at": issue.get("closed_at"), "status": value["name"],
            "project": project["id"], "item": item_node, "archived": archived}


def archive_one(github, candidate, now):
    """One attempt after two agreeing reads; resolve ambiguity on next scan."""
    if not isinstance(now, datetime) or now.tzinfo is None:
        raise ValueError("Timezone required")
    cutoff = now.astimezone(timezone.utc) - timedelta(days=14)
    first = _snapshot(github, candidate)
    if (first["state"] != "closed" or first["status"] != "done" or first["archived"]
            or _date(first["closed_at"]) > cutoff):
        return "skipped"
    if _snapshot(github, candidate) != first:
        return "skipped"
    data = github._graphql(ARCHIVE_MUTATION, {"project": first["project"], "item": first["item"]})
    if ((data.get("archiveProjectV2Item") or {}).get("item") or {}).get("id") != first["item"]:
        raise ValueError("Archive unconfirmed")
    # If reopen raced with the archive, restore the same item and leave its
    # status to the normal issue worker. A lost response is resolved by scans.
    path = f"/repos/{github.owner}/{github.repository}/issues/{candidate[0]}"
    issue, _ = github.transport(path, github.app_token())
    if (not isinstance(issue, dict) or issue.get("node_id") != first["issue"]
            or issue.get("state") not in ("open", "closed")):
        raise ValueError("Issue state unavailable")
    if issue["state"] == "open" or issue.get("closed_at") != first["closed_at"]:
        result = github._graphql(UNARCHIVE_MUTATION, {"project": first["project"], "item": first["item"]})
        if ((result.get("unarchiveProjectV2Item") or {}).get("item") or {}).get("id") != first["item"]:
            raise ValueError("Unarchive unconfirmed")
        data = github._graphql(PROJECT_QUERY, {"owner": github.project_owner, "number": github.project_number,
                                               "item": first["item"]})
        node = data.get("node") or {}
        if node.get("id") != first["item"] or node.get("isArchived") is not False:
            raise ValueError("Unarchive readback unconfirmed")
        return "changed"
    data = github._graphql(PROJECT_QUERY, {"owner": github.project_owner, "number": github.project_number,
                                           "item": first["item"]})
    node = data.get("node") or {}
    if node.get("id") != first["item"] or node.get("isArchived") is not True:
        raise ValueError("Archive readback unconfirmed")
    return "archived"
