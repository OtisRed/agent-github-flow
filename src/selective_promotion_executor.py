"""Run one operator-staged selective promotion through the controller."""
import json
import re
from contextlib import nullcontext
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, build_opener

from deployment_source import pull_request_merge_oid
from mvp_credentials import read_private_file
from mvp_decision import _id
from mvp_errors import GitHubRequestError
from mvp_github import API, MAX_RESPONSE, PROJECT_QUERY, GitHub, _NoRedirect
from selective_promotion_flow import verify_and_squash
from selective_promotion_github import observe_candidate
from selective_forward_sync import publish_forward_sync
from promotion_notice import publish_promotion_notices
from selective_promotion_merge import SelectiveMergeJournal, _validated_manifest, request_github_squash


def read_job_log(path, token, *, opener=None):
    """Follow GitHub's signed log redirect without forwarding credentials."""
    if not re.fullmatch(r"/repos/[\w.-]+/[\w.-]+/actions/jobs/[1-9][0-9]*/logs", path):
        raise ValueError("Invalid job log path")
    open_url = opener or build_opener(_NoRedirect()).open
    try:
        try:
            response = open_url(Request(API + path, headers={"Authorization": "Bearer " + token}), timeout=10)
        except HTTPError as error:
            with error:
                if error.code != 302:
                    raise
                redirect = error.headers.get("Location", "")
            url = urlparse(redirect)
            if (url.scheme != "https" or not url.hostname
                    or not re.fullmatch(r"productionresultssa[0-9]+\.blob\.core\.windows\.net", url.hostname)
                    or url.username is not None or url.password is not None
                    or url.port not in (None, 443) or url.fragment or not url.query):
                raise ValueError("Untrusted job log redirect")
            response = open_url(Request(redirect), timeout=10)
        with response:
            raw = response.read(MAX_RESPONSE + 1)
            if response.status != 200 or len(raw) > MAX_RESPONSE:
                raise ValueError("Invalid job log")
            return raw.decode("utf-8")
    except (URLError, OSError, ValueError):
        raise GitHubRequestError("invalid-data") from None


def run_prepared_promotion(transport, token, project, *, project_token, journal_path, journal_in_state=False,
                           notice_token=None, deployment_guard=None):
    """Read the private request and bind every API operation to its configured repository."""
    path = project.get("selective_request_path")
    if not path:
        return "selective-unavailable"
    try:
        staged = json.loads(read_private_file(path))
    except FileNotFoundError:
        return "idle"
    except (OSError, ValueError):
        return "blocked"
    fields = {"manifest", "pr", "policy", "run_id", "job_id"}
    if not isinstance(staged, dict) or set(staged) != fields:
        return "blocked"
    manifest, number, policy = staged["manifest"], staged["pr"], staged["policy"]
    repository_id = project["repository_id"]
    if (not _validated_manifest(manifest, number) or manifest["repository_id"] != repository_id
            or not isinstance(policy, dict)):
        return "blocked"

    owner, name = project["owner"], project["repository"]
    repository = f"{owner}/{name}"
    root = f"/repos/{repository}"
    workflow_change = policy.get("workflow_change")
    trusted_job = workflow_change.get("job_id") if isinstance(workflow_change, dict) else None
    log_paths = {f"{root}/actions/jobs/{job_id}/logs"
                 for job_id in (staged["job_id"], trusted_job) if _id(job_id)}

    def read(endpoint):
        api_path = "/" + endpoint
        if api_path in log_paths:
            return read_job_log(api_path, token)
        return transport(api_path, token)[0]

    board = GitHub(repository_id=repository_id, owner=owner, repository=name,
                   project_owner=project["project_owner"], project_number=project["project_number"],
                   app_token=lambda: token, project_token=project_token, transport=transport)

    def project_status(issue):
        row = read(f"{root[1:]}/issues/{issue}")
        issue_id = row["node_id"]
        matches = [item for item in board._project_items() if item.get("content_type") == "Issue"
                   and (item.get("content") or {}).get("node_id") == issue_id]
        if len(matches) != 1 or "archived_at" not in matches[0] or matches[0]["archived_at"] is not None:
            raise ValueError("Project card unavailable")
        item_id = matches[0]["node_id"]
        data = board._graphql(PROJECT_QUERY, {"owner": board.project_owner, "number": board.project_number,
                                             "item": item_id})
        project_id = data["user"]["projectV2"]["id"]
        node = data["node"]
        field = node["project"]["statusField"]
        value = node["status"]
        if (not project_id or node["id"] != item_id or node["project"]["id"] != project_id
                or node["isArchived"] is not False or field["name"] != "Status"
                or field["dataType"] != "SINGLE_SELECT" or field["id"] != value["field"]["id"]
                or {"name": value["name"], "id": value["optionId"]} not in field["options"]):
            raise ValueError("Invalid Project status")
        return value["name"]

    def observe(_repository_id, pr):
        return observe_candidate(read, project_status, repository, manifest, pr, policy.get("app_id"),
                                 resolve_merge_oid=lambda n: pull_request_merge_oid(transport, token, owner, name, n))

    def squash(_repository_id, pr, head):
        row, _ = transport(f"{root}/pulls/{pr}", token)
        if (row["number"] != pr or row["base"]["ref"] != "main" or row["base"]["sha"] != manifest["main"]
                or row["base"]["repo"]["id"] != repository_id or row["head"]["repo"]["id"] != repository_id
                or row["head"]["sha"] != head or row["state"] != "open" or row["draft"] is not False):
            raise ValueError("Promotion PR changed")
        request_github_squash(transport, token, row["node_id"], head)

    journal = SelectiveMergeJournal(Path(journal_path), require_existing=journal_in_state)
    new_attempt = journal.read(repository_id, number) is None
    if new_attempt:
        previous = journal.latest_confirmed(repository_id)
        if previous:
            comparison, _ = transport(f"{root}/compare/{previous}...{manifest['smoke']}", token)
            if (comparison.get("status") not in ("ahead", "identical")
                    or (comparison.get("merge_base_commit") or {}).get("sha") != previous):
                return "forward-sync-required"
    try:
        guard = deployment_guard() if deployment_guard is not None and new_attempt else nullcontext()
        with guard as ready:
            if ready is not None and not ready(manifest["main"]):
                return "deployment-blocked"
            result = verify_and_squash(journal, manifest, number, enabled=True, observe=observe, squash=squash,
                                       repository=repository, read_ci=read, policy=policy,
                                       run_id=staged["run_id"], job_id=staged["job_id"])
    except (GitHubRequestError, ValueError, KeyError, TypeError):
        attempt = journal.read(repository_id, number)
        return "unknown" if attempt and attempt[1] is None else "failed"
    if result == "merged":
        confirmed = journal.read(repository_id, number)[1]
        notice_done = project.get("promotion_notice_since") is None
        if not notice_done and notice_token is not None:
            try:
                notice_done = publish_promotion_notices(transport, notice_token(), project, journal, manifest,
                                                        number, confirmed, project_status)
            except (GitHubRequestError, OSError, ValueError):
                notice_done = False
        if project.get("selective_sync_enabled") is True:
            result = publish_forward_sync(transport, token, project, journal, number, confirmed, policy.get("app_id"))
        if not notice_done and result in ("merged", "waiting-checks"):
            return "notice-pending"
    return {"waiting-or-stale": "waiting-checks", "already-reserved": "blocked",
            "invalid-manifest": "blocked", "manifest-mismatch": "blocked",
            "invalid-checks": "blocked"}.get(result, result)
