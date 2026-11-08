"""Repository-scoped GitHub adapter for Dependabot intake."""

from dependabot_plan import BOT_ID, inspect_pr
from mvp_github import request

TO_DRAFT = "mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id isDraft}}}"
UPDATE = "mutation($id:ID!,$base:String!,$body:String!){updatePullRequest(input:{pullRequestId:$id,baseRefName:$base,body:$body}){pullRequest{id}}}"


class DependabotGitHub:
    def __init__(self, client, token, transport=request):
        self.client, self.token, self.transport = client, token, transport
        self.path = f"/repos/{client.owner}/{client.repository}"
        self.repository_id = client.repository_id

    def candidates(self):
        rows = self.client._rest_pages(self.path + "/pulls", self.token(), params={"state": "open"})
        numbers = []
        for pr in rows:
            if (not isinstance(pr, dict) or not isinstance(pr.get("user"), dict)
                    or pr["user"].get("id") != BOT_ID):
                continue
            number = pr.get("number")
            if type(number) is not int or number <= 0:
                raise ValueError("Invalid PR number")
            state = inspect_pr(pr, self.repository_id, number)
            if state in ("unlinked", "ambiguous") or (state == "linked" and (not pr["draft"] or pr["base"]["ref"] != "smoke")):
                numbers.append(number)
        return sorted(numbers)

    def read_pr(self, number):
        value, _ = self.transport(f"{self.path}/pulls/{number}", self.token())
        return value

    def list_issues(self):
        return self.client._rest_pages(self.path + "/issues", self.token(), params={"state": "all"})

    def create_issue(self, number, body):
        self.transport(self.path + "/issues", self.token(),
                       body={"title": f"Przeanalizować aktualizację zależności z PR #{number}", "body": body})

    def _mutation(self, query, variables, name):
        result, _ = self.transport("/graphql", self.token(), body={"query": query, "variables": variables})
        if (not isinstance(result, dict) or result.get("errors") or not isinstance(result.get("data"), dict)
                or not isinstance(result["data"].get(name), dict)
                or not isinstance(result["data"][name].get("pullRequest"), dict)):
            raise ValueError("Unconfirmed PR mutation")

    def normalize(self, pr, issue):
        number = pr["number"]
        if not pr["draft"]:
            self._mutation(TO_DRAFT, {"id": pr["node_id"]}, "convertPullRequestToDraft")
        fresh = self.read_pr(number)
        # Draft conversion is the only expected difference before we edit.
        expected = dict(pr, draft=True)
        if fresh != expected:
            # GitHub can update timestamp and derived metadata during conversion;
            # only the input-bearing fields are compared before the write.
            keys = ("number", "state", "node_id", "body", "user", "head", "base")
            if (not isinstance(fresh, dict) or fresh.get("draft") is not True
                    or any(fresh.get(k) != pr.get(k) for k in keys)):
                raise ValueError("PR changed during intake")
        state = inspect_pr(fresh, self.repository_id, number)
        body = fresh["body"]
        if state == "unlinked":
            body = body.rstrip() + f"\n\nRefs #{issue}\n"
        elif state != "linked":
            raise ValueError("PR link changed during intake")
        self._mutation(UPDATE, {"id": pr["node_id"], "base": "smoke", "body": body}, "updatePullRequest")
        confirmed = self.read_pr(number)
        if (inspect_pr(confirmed, self.repository_id, number) != "linked" or not confirmed["draft"]
                or confirmed["base"]["ref"] != "smoke" or confirmed["body"] != body):
            raise ValueError("Unconfirmed PR normalization")
