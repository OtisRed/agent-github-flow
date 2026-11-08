"""Bounded GitHub adapter for a repository-scoped admission App token.

No private GitHub bodies or token values are logged or written to disk.
The adapter is not connected to the production controller by itself.
"""

import re
from datetime import datetime
from urllib.parse import parse_qs, urlencode, urlparse

from pr_admission import SHA, pr_issue_number
from pr_admission_checks import protected_checks, rulesets_do_not_bypass_smoke, tests_state

MAX_PAGES = 10
MERGE_PR = '''mutation($id:ID!,$sha:GitObjectID!){
 mergePullRequest(input:{pullRequestId:$id,mergeMethod:MERGE,expectedHeadOid:$sha}){pullRequest{merged}}}'''
MESSAGES = {
    "ready": "Wymagane review odpowiadają aktualnej wersji PR.",
    "missing-review-agent-prowadzacy": "Brakuje aktualnego review agenta prowadzącego.",
    "missing-review-subagent": "Brakuje aktualnego review wykonanego przez subagenta.",
    "review-requires-changes-agent-prowadzacy": "Review prowadzącego wymaga poprawek.",
    "review-requires-changes-subagent": "Review subagenta wymaga poprawek.",
    "ambiguous-review-agent-prowadzacy": "Wyniki review prowadzącego mają niejednoznaczną kolejność.",
    "ambiguous-review-subagent": "Wyniki review subagenta mają niejednoznaczną kolejność.",
    "invalid-review": "Komentarz review jest niepełny lub ma niepoprawny format, SHA albo DA.",
    "invalid-review-requirement": "Liczba wymaganych review w issue jest niejednoznaczna.",
    "invalid-issue-link": "PR musi wskazywać jedno otwarte issue przez samodzielne Refs #numer.",
    "review-input-changed": "Kontrakt lub review zmieniły się podczas sprawdzania; nastąpi ponowna ocena.",
    "unsupported-pr": "PR musi dotyczyć tego repozytorium i gałęzi smoke, bez uzbrojonego auto-merge.",
    "pr-not-ready": "PR nadal jest draftem lub nie jest otwarty.",
}


class AdmissionReader:
    def __init__(self, *, owner, repository, repository_id, token, transport,
                 admission=None, required_tests=(), journal=None, workflow="ci.yml", gate_job="verify",
                 workflow_event="pull_request"):
        if (not isinstance(owner, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,39}", owner)
                or not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", repository)
                or repository in (".", "..") or type(repository_id) is not int or repository_id <= 0
                or not callable(token) or not callable(transport)
                or not isinstance(workflow, str) or not re.fullmatch(r"[A-Za-z0-9_-]+\.ya?ml", workflow)
                or not isinstance(gate_job, str) or not gate_job or len(gate_job) > 100
                or workflow_event not in ("pull_request", "pull_request_target")):
            raise ValueError("Invalid admission reader configuration")
        self.root = f"/repos/{owner}/{repository}"
        self.full_name = f"{owner}/{repository}"
        self.repository_id, self.token, self.transport = repository_id, token, transport
        self.admission, self.required_tests = admission, required_tests
        self.journal = journal
        self.workflow, self.gate_job, self.workflow_event = workflow, gate_job, workflow_event
        self._requested_ci_attempts = set()

    def _get(self, path, token):
        value, _link = self.transport(self.root + path, token)
        return value

    def _comments(self, number, token):
        comments = []
        for page in range(1, MAX_PAGES + 1):
            path = f"/issues/{number}/comments"
            rows, link = self.transport(self.root + path + "?" + urlencode({"per_page": 100, "page": page}), token)
            if not isinstance(rows, list) or len(rows) > 100:
                raise ValueError("Invalid PR comments")
            for item in rows:
                author = item.get("user") if isinstance(item, dict) else None
                if not isinstance(author, dict):
                    raise ValueError("Invalid comment author")
                comments.append({"id": item.get("id"), "author_id": author.get("id"),
                                 "body": item.get("body"), "updated_at": item.get("updated_at")})
            next_links = []
            if link:
                if not isinstance(link, str):
                    raise ValueError("Invalid comment pagination")
                for part in re.split(r",\s*(?=<)", link):
                    match = re.fullmatch(r'<([^>]+)>;\s*rel="([^"]+)"', part.strip())
                    if not match:
                        raise ValueError("Invalid comment pagination")
                    if match.group(2) == "next":
                        next_links.append(match.group(1))
                if len(next_links) > 1:
                    raise ValueError("Ambiguous comment pagination")
                if next_links:
                    parsed = urlparse(next_links[0])
                    if (parsed.scheme != "https" or parsed.netloc != "api.github.com"
                            or parsed.path not in (self.root + path, f"/repositories/{self.repository_id}" + path)
                            or parsed.fragment or parse_qs(parsed.query).get("page") != [str(page + 1)]):
                        raise ValueError("Invalid next comment page")
            if not next_links and len(rows) < 100:
                return comments
        raise ValueError("PR comment page limit")

    def _check_runs(self, sha, token):
        runs = []
        for page in range(1, MAX_PAGES + 1):
            result = self._get(f"/commits/{sha}/check-runs?" + urlencode({"per_page": 100, "page": page}), token)
            if (not isinstance(result, dict) or type(result.get("total_count")) is not int
                    or result["total_count"] < 0 or not isinstance(result.get("check_runs"), list)
                    or len(result["check_runs"]) > 100):
                raise ValueError("Invalid check run listing")
            runs.extend(result["check_runs"])
            if len(runs) >= result["total_count"]:
                if len(runs) != result["total_count"]:
                    raise ValueError("Inconsistent check run listing")
                return runs
            if len(result["check_runs"]) < 100:
                raise ValueError("Incomplete check run listing")
        raise ValueError("Check run page limit")

    def _rulesets(self, token):
        result = []
        for page in range(1, MAX_PAGES + 1):
            path = "/rulesets?" + urlencode({"per_page": 100, "page": page, "includes_parents": "true"})
            rows, link = self.transport(self.root + path, token)
            if not isinstance(rows, list) or len(rows) > 100:
                raise ValueError("Invalid ruleset listing")
            # A partial page with another page advertised cannot prove the
            # complete set of rules protecting this branch.
            if link and len(rows) < 100 and 'rel="next"' in link:
                raise ValueError("Incomplete ruleset listing")
            for row in rows:
                if not isinstance(row, dict) or type(row.get("id")) is not int or row["id"] <= 0:
                    raise ValueError("Invalid ruleset identity")
                detail = self._get(f"/rulesets/{row['id']}", token)
                if not isinstance(detail, dict) or detail.get("id") != row["id"]:
                    raise ValueError("Invalid ruleset detail")
                result.append(detail)
            if len(rows) < 100:
                return result
        raise ValueError("Ruleset page limit")

    def open_pr_numbers(self):
        token = self.token()
        numbers = []
        for page in range(1, MAX_PAGES + 1):
            rows, link = self.transport(self.root + "/pulls?" + urlencode({"state": "open", "base": "smoke", "per_page": 100, "page": page}), token)
            if not isinstance(rows, list) or len(rows) > 100:
                raise ValueError("Invalid pull request listing")
            for row in rows:
                if not isinstance(row, dict) or type(row.get("number")) is not int or row["number"] <= 0:
                    raise ValueError("Invalid pull request")
                if row.get("draft") is False:
                    numbers.append(row["number"])
                elif row.get("draft") is not True:
                    raise ValueError("Unknown pull request draft state")
            next_links = []
            if link:
                if not isinstance(link, str):
                    raise ValueError("Invalid PR pagination")
                for part in re.split(r",\s*(?=<)", link):
                    match = re.fullmatch(r'<([^>]+)>;\s*rel="([^"]+)"', part.strip())
                    if not match:
                        raise ValueError("Invalid PR pagination")
                    if match.group(2) == "next":
                        next_links.append(match.group(1))
                if len(next_links) > 1:
                    raise ValueError("Ambiguous PR pagination")
                if next_links:
                    parsed = urlparse(next_links[0])
                    if (parsed.scheme != "https" or parsed.netloc != "api.github.com"
                            or parsed.path not in (self.root + "/pulls", f"/repositories/{self.repository_id}/pulls")
                            or parsed.fragment or parse_qs(parsed.query).get("page") != [str(page + 1)]):
                        raise ValueError("Invalid next PR page")
            if not next_links and len(rows) < 100:
                if len(set(numbers)) != len(numbers):
                    raise ValueError("Duplicate pull request")
                return numbers
        raise ValueError("Pull request page limit")

    def read_snapshot(self, number):
        if type(number) is not int or number <= 0:
            raise ValueError("Invalid PR number")
        token = self.token()
        repo = self._get("", token)
        if (not isinstance(repo, dict) or repo.get("id") != self.repository_id
                or not isinstance(repo.get("full_name"), str)
                or repo["full_name"].casefold() != self.full_name.casefold()):
            raise ValueError("Repository identity changed")
        pr = self._get(f"/pulls/{number}", token)
        if not isinstance(pr, dict) or pr.get("number") != number or "auto_merge" not in pr:
            raise ValueError("Invalid PR")
        head, base = pr.get("head"), pr.get("base")
        if not isinstance(head, dict) or not isinstance(base, dict):
            raise ValueError("Invalid PR references")
        head_repo, base_repo = head.get("repo"), base.get("repo")
        sha = head.get("sha")
        base_sha = base.get("sha")
        if (not isinstance(sha, str) or not SHA.fullmatch(sha)
                or not isinstance(base_sha, str) or not SHA.fullmatch(base_sha)):
            raise ValueError("Invalid PR head or base")
        same_repo = (isinstance(head_repo, dict) and isinstance(base_repo, dict)
                     and head_repo.get("id") == self.repository_id and base_repo.get("id") == self.repository_id)
        number_in_body = pr_issue_number(pr.get("body"))
        if number_in_body is None:
            issue = {"number": None, "state": None, "body": None}
        else:
            item = self._get(f"/issues/{number_in_body}", token)
            if not isinstance(item, dict) or "pull_request" in item:
                raise ValueError("Invalid linked issue")
            issue = {"number": item.get("number"), "state": item.get("state"), "body": item.get("body")}
        comments = self._comments(number, token)
        # Re-read PR identity to detect changes during the paginated reads.
        after = self._get(f"/pulls/{number}", token)
        keys = ("number", "state", "draft", "body", "head", "base", "auto_merge")
        if not isinstance(after, dict) or any(pr.get(key) != after.get(key) for key in keys):
            raise ValueError("PR changed during snapshot")
        protection, checks = False, "unknown"
        if self.admission is not None:
            rules = self._get("/branches/smoke/protection", token)
            protection = (protected_checks(rules, self.admission, self.required_tests)
                          and rulesets_do_not_bypass_smoke(self._rulesets(token)))
            checks = tests_state(self._check_runs(sha, token), sha, self.required_tests)
            if pr.get("mergeable_state") != "clean" and checks == "success":
                checks = "pending"
        return {"complete": True, "protection": protection, "checks": checks,
                "pr": {"number": number, "state": pr.get("state"),
                "draft": pr.get("draft"), "head_sha": sha, "body": pr.get("body"),
                "base_ref": base.get("ref"), "base_sha": base_sha, "same_repository": same_repo,
                "auto_merge_enabled": pr.get("auto_merge") is not None, "node_id": pr.get("node_id")},
                "issue": issue, "comments": comments}

    def merge(self, number, expected_sha, expected_base):
        """Guard the exact head via GitHub; a caller must freshly check all inputs."""
        if (type(number) is not int or number <= 0 or not isinstance(expected_sha, str) or not SHA.fullmatch(expected_sha)
                or not isinstance(expected_base, str) or not SHA.fullmatch(expected_base)):
            raise ValueError("Invalid merge request")
        if self.journal is None:
            raise ValueError("Merge journal unavailable")
        token = self.token()
        pr = self._get(f"/pulls/{number}", token)
        if (not isinstance(pr, dict) or pr.get("number") != number or pr.get("state") != "open"
                or pr.get("draft") is not False or (pr.get("head") or {}).get("sha") != expected_sha
                or "auto_merge" not in pr or pr.get("auto_merge") is not None
                or (pr.get("base") or {}).get("ref") != "smoke"
                or (pr.get("base") or {}).get("sha") != expected_base
                or ((pr.get("base") or {}).get("repo") or {}).get("id") != self.repository_id
                or ((pr.get("head") or {}).get("repo") or {}).get("id") != self.repository_id
                or not isinstance(pr.get("node_id"), str) or not pr["node_id"]):
            raise ValueError("Merge target changed")
        self.journal.begin(number, expected_sha)
        result, _ = self.transport("/graphql", token, body={"query": MERGE_PR,
            "variables": {"id": pr["node_id"], "sha": expected_sha}})
        if (not isinstance(result, dict) or result.get("errors")
                or (((result.get("data") or {}).get("mergePullRequest") or {}).get("pullRequest") or {}).get("merged") is not True):
            raise ValueError("Unconfirmed merge")
        after = self._get(f"/pulls/{number}", token)
        if (not isinstance(after, dict) or after.get("number") != number or after.get("state") != "closed"
                or after.get("merged") is not True or (after.get("head") or {}).get("sha") != expected_sha):
            raise ValueError("Merge readback unavailable")
        self.journal.confirm_merged(number)

    def reconcile_merges(self):
        """Clear markers only after GitHub confirms the same PR head merged."""
        if self.journal is None:
            raise ValueError("Merge journal unavailable")
        pending = self.journal.pending()
        if not pending:
            return 0
        token, unresolved = self.token(), 0
        for number, sha in pending:
            pr = self._get(f"/pulls/{number}", token)
            if (isinstance(pr, dict) and pr.get("number") == number and pr.get("state") == "closed"
                    and pr.get("merged") is True and (pr.get("head") or {}).get("sha") == sha):
                self.journal.confirm_merged(number)
            else:
                unresolved += 1
        return unresolved

    def publish(self, sha, verdict):
        """Publish only a changed admission outcome; never include private data."""
        if (not isinstance(sha, str) or not SHA.fullmatch(sha)
                or not isinstance(verdict, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", verdict)
                or not isinstance(self.admission, tuple) or len(self.admission) != 2):
            raise ValueError("Invalid check decision")
        name, app_id = self.admission
        if not isinstance(name, str) or not name or type(app_id) is not int or app_id <= 0:
            raise ValueError("Invalid check identity")
        token = self.token()
        runs = self._check_runs(sha, token)
        matching = [run for run in runs if isinstance(run, dict) and run.get("name") == name
                    and isinstance(run.get("app"), dict) and run["app"].get("id") == app_id]
        if any(type(run.get("id")) is not int or run["id"] <= 0 or run.get("head_sha") != sha for run in matching):
            raise ValueError("Invalid admission check")
        latest = max(matching, key=lambda run: run["id"], default=None)
        conclusion = "success" if verdict == "ready" else "failure"
        summary = verdict + "\n" + MESSAGES.get(verdict, "Nie można potwierdzić warunków admission.")
        if verdict != "ready":
            summary += " Sprawdź instrukcję skilla github-flow."
        if (latest is not None and latest.get("status") == "completed" and latest.get("conclusion") == conclusion
                and isinstance(latest.get("output"), dict) and latest["output"].get("summary") == summary):
            return "unchanged"
        payload = {"name": name, "head_sha": sha, "status": "completed", "conclusion": conclusion,
                   "output": {"title": "Agent flow admission", "summary": summary}}
        result, _ = self.transport(self.root + "/check-runs", token, body=payload)
        if (not isinstance(result, dict) or type(result.get("id")) is not int or result["id"] <= 0
                or result.get("head_sha") != sha or result.get("name") != name
                or (result.get("app") or {}).get("id") != app_id):
            raise ValueError("Unconfirmed admission check")
        return "published"

    def rerun_blocked_ci(self, number):
        """Rerun only a verified failed admission-wait step for the current PR."""
        token = self.token()
        pr = self._get(f"/pulls/{number}", token)
        if (not isinstance(pr, dict) or pr.get("number") != number or pr.get("state") != "open"
                or pr.get("draft") is not False or (pr.get("base") or {}).get("ref") != "smoke"
                or ((pr.get("head") or {}).get("repo") or {}).get("id") != self.repository_id):
            return "not-eligible"
        sha = (pr.get("head") or {}).get("sha")
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            return "not-eligible"
        query = urlencode({"event": self.workflow_event, "head_sha": sha, "per_page": 100})
        result = self._get("/actions/workflows/" + self.workflow + "/runs?" + query, token)
        if (not isinstance(result, dict) or type(result.get("total_count")) is not int
                or not isinstance(result.get("workflow_runs"), list)
                or result["total_count"] != len(result["workflow_runs"]) or result["total_count"] > 100):
            raise ValueError("Incomplete workflow runs")
        candidates = []
        unique_branch_pr = None
        for run in result["workflow_runs"]:
            if not isinstance(run, dict):
                raise ValueError("Invalid workflow run")
            if (run.get("event") != self.workflow_event or run.get("head_sha") != sha
                    or (run.get("head_repository") or {}).get("id") != self.repository_id):
                continue
            prs = run.get("pull_requests")
            linked = isinstance(prs, list) and any(isinstance(x, dict) and x.get("number") == number for x in prs)
            head_ref = (pr.get("head") or {}).get("ref")
            if (not linked and prs == [] and self.workflow_event == "pull_request_target"
                    and isinstance(head_ref, str) and head_ref and run.get("head_branch") == head_ref):
                try:
                    run_created = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
                    pr_created = datetime.fromisoformat(pr["created_at"].replace("Z", "+00:00"))
                    after_creation = run_created.tzinfo is not None and pr_created.tzinfo is not None and run_created >= pr_created
                except (KeyError, AttributeError, TypeError, ValueError):
                    after_creation = False
                if after_creation:
                    if unique_branch_pr is None:
                        query = urlencode({"state": "all", "head": self.full_name.split("/")[0] + ":" + head_ref, "per_page": 100})
                        rows, link = self.transport(self.root + "/pulls?" + query, token)
                        unique_branch_pr = (isinstance(rows, list) and len(rows) == 1 and not link
                            and isinstance(rows[0], dict) and rows[0].get("number") == number
                            and rows[0].get("state") == "open" and (rows[0].get("head") or {}).get("sha") == sha
                            and (rows[0].get("head") or {}).get("ref") == head_ref
                            and ((rows[0].get("head") or {}).get("repo") or {}).get("id") == self.repository_id
                            and (rows[0].get("base") or {}).get("ref") == "smoke"
                            and ((rows[0].get("base") or {}).get("repo") or {}).get("id") == self.repository_id)
                    linked = unique_branch_pr
            if linked:
                if type(run.get("id")) is not int or type(run.get("run_attempt")) is not int:
                    raise ValueError("Invalid workflow identity")
                candidates.append(run)
        if not candidates:
            return "no-workflow"
        run = max(candidates, key=lambda x: (x["id"], x["run_attempt"]))
        if run.get("status") != "completed" or run.get("conclusion") != "failure":
            return "not-a-failed-run"
        run_id, attempt = run["id"], run["run_attempt"]
        key = (run_id, attempt)
        if key in self._requested_ci_attempts:
            return "already-requested"
        jobs = self._get(f"/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100", token)
        if (not isinstance(jobs, dict) or type(jobs.get("total_count")) is not int
                or not isinstance(jobs.get("jobs"), list) or jobs["total_count"] != len(jobs["jobs"])
                or jobs["total_count"] > 100):
            raise ValueError("Incomplete workflow jobs")
        verify = [job for job in jobs["jobs"] if isinstance(job, dict) and job.get("name") == self.gate_job]
        if len(verify) != 1 or verify[0].get("conclusion") != "failure":
            return "not-gate-failure"
        steps = verify[0].get("steps")
        if not isinstance(steps, list):
            raise ValueError("Missing workflow steps")
        failed = [step for step in steps if isinstance(step, dict) and step.get("conclusion") == "failure"]
        if len(failed) != 1 or failed[0].get("name") != "Wait for flow admission":
            return "not-gate-failure"
        # Reserve locally before POST; an uncertain response is never blindly
        # retried in this process. A later scan re-reads the run and attempt.
        self._requested_ci_attempts.add(key)
        self.transport(self.root + f"/actions/runs/{run_id}/rerun-failed-jobs", token, body={})
        return "rerun-requested"
