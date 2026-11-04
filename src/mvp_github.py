"""GitHub adapter for one configured project; tokens are never logged.

The App token reads the repository; the user PAT reads and changes the personal
Project. Each call has a fixed GitHub host, bounded response and no redirects.
The caller provides the tokens and must protect their storage and access.
"""
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from mvp_decision import STATUSES, _date

API = "https://api.github.com"
MAX_RESPONSE = 8_000_000
MAX_PAGES = 1000
PROJECT_QUERY = """query($owner:String!,$number:Int!,$item:ID!){
 user(login:$owner){projectV2(number:$number){id}}
 node(id:$item){... on ProjectV2Item{id isArchived project{id
   statusField:field(name:"Status"){... on ProjectV2SingleSelectField{id name dataType options{id name}}}}
   status:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name optionId field{... on ProjectV2SingleSelectField{id}}}}}}
}"""
PROJECT_ID_QUERY = "query($owner:String!,$number:Int!){user(login:$owner){projectV2(number:$number){id}}}"
STATUS_MUTATION = """mutation($project:ID!,$item:ID!,$field:ID!,$value:ProjectV2FieldValue!){
 updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:$value}){projectV2Item{id}}}
"""
ADD_MUTATION = """mutation($project:ID!,$content:ID!){
 addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}
"""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def request(path, token, *, body=None):
    """Perform one bounded request without retries or exposing failures."""
    if (not isinstance(path, str) or not path.startswith("/") or path.startswith("//")
            or not isinstance(token, str) or not token or re.search(r"[\s\x00-\x1f\x7f]", token)):
        raise ValueError("Invalid GitHub request")
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = Request(API + path, data=data, headers={"Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token, "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10"}, method="GET" if data is None else "POST")
    try:
        with build_opener(_NoRedirect()).open(req, timeout=10) as response:
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise ValueError("GitHub response too large")
            return json.loads(raw), response.headers.get("Link")
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, UnicodeError) as exc:
        raise RuntimeError("GitHub request failed") from None


def _node(value):
    return isinstance(value, str) and 0 < len(value) <= 256 and re.fullmatch(r"[^\s\x00-\x1f\x7f]+", value)


class GitHub:
    def __init__(self, *, repository_id, owner, repository, project_owner, project_number,
                 app_token, project_token, transport=request):
        if (type(repository_id) is not int or repository_id <= 0
                or not re.fullmatch(r"[A-Za-z0-9-]{1,39}", owner or "")
                or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", repository or "")
                or repository in (".", "..")
                or not re.fullmatch(r"[A-Za-z0-9-]{1,39}", project_owner or "")
                or type(project_number) is not int or project_number <= 0
                or not callable(app_token) or not isinstance(project_token, str) or not callable(transport)):
            raise ValueError("Invalid project configuration")
        self.repository_id, self.owner, self.repository = repository_id, owner, repository
        self.project_owner, self.project_number = project_owner, project_number
        self.app_token, self.project_token, self.transport = app_token, project_token, transport
        self._last = None

    def _graphql(self, query, variables):
        result, _ = self.transport("/graphql", self.project_token, body={"query": query, "variables": variables})
        if not isinstance(result, dict) or result.get("errors") or not isinstance(result.get("data"), dict):
            raise ValueError("Invalid GraphQL response")
        return result["data"]

    def _rest_pages(self, path, token, *, params=None):
        result = []
        for page in range(1, MAX_PAGES + 1):
            query = {**(params or {}), "per_page": 100, "page": page}
            rows, link = self.transport(path + "?" + urlencode(query), token)
            if not isinstance(rows, list) or len(rows) > 100:
                raise ValueError("Invalid GitHub page")
            result.extend(rows)
            if not link and len(rows) < 100:
                return result
            if link:
                if not isinstance(link, str):
                    raise ValueError("Invalid GitHub pagination")
                links = []
                for part in re.split(r",\s*(?=<)", link):
                    match = re.fullmatch(r'<([^>]+)>;\s*rel="([^"]+)"', part.strip())
                    if not match:
                        raise ValueError("Invalid GitHub pagination")
                    links.append(match.groups())
                next_links = [url for url, rel in links if rel == "next"]
                if not next_links:
                    return result
                if len(next_links) != 1:
                    raise ValueError("Invalid GitHub pagination")
                parsed = urlparse(next_links[0])
                pages = parse_qs(parsed.query).get("page", [])
                canonical = re.sub(r"^/repos/[^/]+/[^/]+/", f"/repositories/{self.repository_id}/", path)
                if (parsed.scheme != "https" or parsed.netloc != "api.github.com"
                        or parsed.path not in (path, canonical) or parsed.fragment
                        or pages != [str(page + 1)]):
                    raise ValueError("Invalid GitHub pagination")
        raise ValueError("GitHub page limit")

    def _project_items(self):
        path = f"/users/{self.project_owner}/projectsV2/{self.project_number}/items"
        items, cursor, seen = [], None, set()
        for _ in range(MAX_PAGES):
            params = {"per_page": 100}
            if cursor is not None:
                params["after"] = cursor
            page, link = self.transport(path + "?" + urlencode(params), self.project_token)
            if not isinstance(page, list) or len(page) > 100:
                raise ValueError("Invalid Project page")
            items.extend(page)
            links = []
            if link:
                if not isinstance(link, str):
                    raise ValueError("Invalid Project cursor")
                for part in re.split(r",\s*(?=<)", link):
                    match = re.fullmatch(r'<([^>]+)>;\s*rel="([^"]+)"', part.strip())
                    if not match:
                        raise ValueError("Invalid Project cursor")
                    links.append(match.groups())
            next_links = [url for url, rel in links if rel == "next"]
            if not next_links:
                return items
            if len(next_links) != 1:
                raise ValueError("Invalid Project cursor")
            parsed = urlparse(next_links[0])
            allowed_path = parsed.path == path or re.fullmatch(rf"/user/[0-9]+/projectsV2/{self.project_number}/items", parsed.path)
            values = parse_qs(parsed.query).get("after", [])
            if (parsed.scheme != "https" or parsed.netloc != "api.github.com" or not allowed_path
                    or parsed.fragment or len(values) != 1 or not values[0] or len(values[0]) > 2048
                    or values[0] in seen):
                raise ValueError("Invalid Project cursor")
            cursor = values[0]
            seen.add(cursor)
        raise ValueError("Project page limit")

    def reconciliation_candidates(self, enrolled_at):
        """Collect existing cards and issues created after enrollment, without writes."""
        boundary = _date(enrolled_at)
        token = self.app_token()
        repo_path = f"/repos/{self.owner}/{self.repository}"
        repo, _ = self.transport(repo_path, token)
        if (not isinstance(repo, dict) or repo.get("id") != self.repository_id
                or not isinstance(repo.get("full_name"), str)
                or repo["full_name"].casefold() != f"{self.owner}/{self.repository}".casefold()):
            raise ValueError("Repository identity changed")
        candidates, card_numbers = set(), set()
        for item in self._project_items():
            if (not isinstance(item, dict) or item.get("content_type") not in ("Issue", "PullRequest", "DraftIssue")
                    or "archived_at" not in item):
                raise ValueError("Invalid Project item")
            if item["content_type"] != "Issue" or item["archived_at"] is not None:
                continue
            content = item.get("content")
            if (not isinstance(content, dict) or not isinstance(content.get("repository_url"), str)
                    or type(content.get("number")) is not int or content["number"] <= 0):
                raise ValueError("Project issue identity unavailable")
            if content["repository_url"].casefold() == (API + repo_path).casefold():
                number = content["number"]
                if number in card_numbers:
                    raise ValueError("Ambiguous Project cards")
                card_numbers.add(number)
                candidates.add(number)
        issues = self._rest_pages(repo_path + "/issues", token, params={"state": "all", "since": enrolled_at})
        for issue in issues:
            if not isinstance(issue, dict):
                raise ValueError("Invalid issue listing")
            if "pull_request" in issue:
                continue
            if type(issue.get("number")) is not int or issue["number"] <= 0:
                raise ValueError("Invalid issue listing")
            if _date(issue.get("created_at")) > boundary:
                candidates.add(issue["number"])
        return sorted(candidates)

    def read(self, repository_id, issue_number):
        self._last = None
        if repository_id != self.repository_id or type(issue_number) is not int or issue_number <= 0:
            raise ValueError("Unknown issue")
        token = self.app_token()
        repo_path = f"/repos/{self.owner}/{self.repository}"
        repo, _ = self.transport(repo_path, token)
        if (not isinstance(repo, dict) or repo.get("id") != self.repository_id
                or not isinstance(repo.get("full_name"), str)
                or repo["full_name"].casefold() != f"{self.owner}/{self.repository}".casefold()):
            raise ValueError("Repository identity changed")
        path = f"/repos/{self.owner}/{self.repository}/issues/{issue_number}"
        issue, _ = self.transport(path, token)
        if (not isinstance(issue, dict) or issue.get("number") != issue_number or not _node(issue.get("node_id"))
                or issue.get("state") not in ("open", "closed") or "pull_request" in issue):
            raise ValueError("Invalid issue")
        comments = self._rest_pages(path + "/comments", token)
        events = self._rest_pages(path + "/events", token)
        records = []
        for item in comments:
            user = item.get("user") if isinstance(item, dict) else None
            if not isinstance(user, dict):
                raise ValueError("Invalid comment author")
            records.append({"id": item.get("id"), "author_id": user.get("id"),
                            "body": item.get("body"), "created_at": item.get("created_at"),
                            "updated_at": item.get("updated_at")})
        reopens = [{"id": event.get("id"), "created_at": event.get("created_at")}
                   for event in events if isinstance(event, dict) and event.get("event") == "reopened"]
        if any(not isinstance(item["created_at"], str) or type(item["id"]) is not int for item in reopens):
            raise ValueError("Invalid reopen event")
        reopens.sort(key=lambda item: (item["created_at"], item["id"]))
        items = self._project_items()
        matches = []
        for item in items:
            if (not isinstance(item, dict) or not _node(item.get("node_id"))
                    or item.get("content_type") not in ("Issue", "PullRequest", "DraftIssue")
                    or "archived_at" not in item):
                raise ValueError("Invalid Project item")
            content = item.get("content")
            if item["content_type"] == "Issue" and (not isinstance(content, dict) or not _node(content.get("node_id"))):
                raise ValueError("Project issue identity unavailable")
            if item["content_type"] == "Issue" and content["node_id"] == issue["node_id"]:
                if item["archived_at"] is not None:
                    raise ValueError("Project card is archived")
                matches.append(item)
        if len(matches) > 1:
            raise ValueError("Ambiguous Project card")
        variables = {"owner": self.project_owner, "number": self.project_number}
        if not matches:
            data = self._graphql(PROJECT_ID_QUERY, variables)
            project = (data.get("user") or {}).get("projectV2") or {}
            if not _node(project.get("id")):
                raise ValueError("Unknown Project")
            self._last = {"repo": repository_id, "number": issue_number, "project": project["id"],
                          "content": issue["node_id"], "missing": True}
            return {"complete": True, "missing_card": True, "state": issue["state"].upper(),
                    "created_at": issue.get("created_at"), "updated_at": issue.get("updated_at")}
        item_id = matches[0].get("node_id")
        if not _node(item_id):
            raise ValueError("Invalid Project card")
        data = self._graphql(PROJECT_QUERY, {**variables, "item": item_id})
        project = (data.get("user") or {}).get("projectV2") or {}
        item = data.get("node") or {}
        field = (item.get("project") or {}).get("statusField") or {}
        value = item.get("status")
        options = field.get("options")
        if (not _node(project.get("id")) or item.get("id") != item_id or item.get("isArchived") is not False
                or (item.get("project") or {}).get("id") != project["id"] or not _node(field.get("id"))
                or field.get("name") != "Status" or field.get("dataType") != "SINGLE_SELECT"
                or not isinstance(options, list)):
            raise ValueError("Invalid Project field")
        mapping = {option.get("name"): option.get("id") for option in options if isinstance(option, dict)}
        if (len(mapping) != len(options) or not STATUSES.issubset(mapping) or any(not _node(x) for x in mapping.values())
                or (value is not None and (not isinstance(value, dict) or value.get("name") not in mapping
                    or value.get("optionId") != mapping[value["name"]]
                    or (value.get("field") or {}).get("id") != field["id"]))):
            raise ValueError("Invalid Project status")
        # Re-read the issue header after paginated reads. The worker also reads
        # the complete snapshot twice before it attempts a status change.
        again, _ = self.transport(path, token)
        if any(issue.get(key) != again.get(key) for key in ("node_id", "state", "created_at", "updated_at")):
            raise ValueError("Issue changed during read")
        self._last = {"repo": repository_id, "number": issue_number, "project": project["id"], "item": item_id,
                      "field": field["id"], "options": mapping, "missing": False}
        return {"complete": True, "state": issue["state"].upper(), "status": value["name"] if value else None,
                "created_at": issue.get("created_at"), "updated_at": issue.get("updated_at"),
                "comments": records, "latest_reopen": reopens[-1] if reopens else None,
                "project_id": project["id"], "item_id": item_id}

    def set_status(self, repository_id, issue_number, status):
        last = self._last
        if (not last or last.get("missing") or last["repo"] != repository_id or last["number"] != issue_number
                or status not in STATUSES):
            raise ValueError("Unverified write target")
        result = self._graphql(STATUS_MUTATION, {"project": last["project"], "item": last["item"],
            "field": last["field"], "value": {"singleSelectOptionId": last["options"][status]}})
        if ((result.get("updateProjectV2ItemFieldValue") or {}).get("projectV2Item") or {}).get("id") != last["item"]:
            raise ValueError("Unconfirmed Project write")
        self._last = None

    def add_item(self, repository_id, issue_number):
        last = self._last
        if not last or not last.get("missing") or last["repo"] != repository_id or last["number"] != issue_number:
            raise ValueError("Unverified Project target")
        result = self._graphql(ADD_MUTATION, {"project": last["project"], "content": last["content"]})
        if not _node(((result.get("addProjectV2ItemById") or {}).get("item") or {}).get("id")):
            raise ValueError("Unconfirmed Project item")
        self._last = None
