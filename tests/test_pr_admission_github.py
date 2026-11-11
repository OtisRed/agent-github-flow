import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pr_admission_github import AdmissionReader


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 40
        self.pr = {"number": 4, "state": "open", "draft": False, "body": "Refs #42", "auto_merge": None,
                   "node_id": "PR_node", "mergeable_state": "clean",
                   "head": {"sha": self.sha, "repo": {"id": 20}},
                   "base": {"ref": "smoke", "sha": "b" * 40, "repo": {"id": 20}}}
        self.rows = {"": {"id": 20, "full_name": "owner/repo"}, "/pulls/4": self.pr,
                     "/issues/42": {"number": 42, "state": "open", "body": "Wymagane review: 1"},
                     "/issues/4/comments?per_page=100&page=1": [{"id": 1, "user": {"id": 7}, "body": "test"}]}
        self.calls = []
        self.reader = AdmissionReader(owner="owner", repository="repo", repository_id=20,
                                      token=lambda: "test-token", transport=self.transport)

    def transport(self, path, _token, *, body=None):
        self.assertIsNone(body)
        self.calls.append(path)
        return copy.deepcopy(self.rows[path.removeprefix("/repos/owner/repo")]), None

    def test_reads_pr_issue_and_comments_without_using_pr_as_issue(self):
        snapshot = self.reader.read_snapshot(4)
        self.assertEqual(snapshot["issue"]["number"], 42)
        self.assertEqual(snapshot["comments"][0]["author_id"], 7)
        self.assertTrue(snapshot["pr"]["same_repository"])
        self.assertEqual(self.calls.count("/repos/owner/repo/pulls/4"), 2)

    def test_lists_only_ready_prs_and_rejects_bad_pagination(self):
        path = "/pulls?state=open&base=smoke&per_page=100&page=1"
        self.rows[path] = [{"number": 4, "draft": False}, {"number": 5, "draft": True}]
        self.assertEqual(self.reader.open_pr_numbers(), [4])
        original = self.reader.transport
        def poisoned(path, token, *, body=None):
            result, _ = original(path, token, body=body)
            return result, '<https://elsewhere.invalid/pulls?page=2>; rel="next"'
        self.reader.transport = poisoned
        with self.assertRaises(ValueError):
            self.reader.open_pr_numbers()

    def test_fork_is_not_same_repository(self):
        self.pr["head"]["repo"]["id"] = 99
        self.assertFalse(self.reader.read_snapshot(4)["pr"]["same_repository"])

    def test_forward_sync_requires_same_bot_and_exact_current_main_parents(self):
        self.reader.sync_bot_id = 10
        main = "c" * 40
        snapshot = {"protection": True, "pr": {"head_ref": "sync-main/" + main, "author_id": 10,
            "auto_merge_enabled": True, "auto_merge_actor_id": 10, "state": "open", "draft": False,
            "same_repository": True, "base_ref": "smoke", "base_sha": "b" * 40, "head_sha": self.sha}}
        self.rows["/git/ref/heads/main"] = {"object": {"sha": main}}
        self.rows["/git/commits/" + self.sha] = {"parents": [{"sha": "b" * 40}, {"sha": main}]}
        self.assertEqual(self.reader.sync_status(snapshot), "sync-verified")
        snapshot["pr"]["auto_merge_actor_id"] = 11
        self.assertEqual(self.reader.sync_status(snapshot), "sync-invalid")
        snapshot["pr"]["auto_merge_actor_id"] = 10
        self.rows["/git/ref/heads/main"]["object"]["sha"] = "d" * 40
        self.assertEqual(self.reader.sync_status(snapshot), "sync-invalid")
        self.rows["/git/ref/heads/main"]["object"]["sha"] = main
        self.rows["/git/commits/" + self.sha]["parents"][0]["sha"] = "d" * 40
        self.assertEqual(self.reader.sync_status(snapshot), "sync-invalid")
        snapshot["pr"]["auto_merge_enabled"] = False
        self.assertEqual(self.reader.sync_status(snapshot), "sync-wait")
        snapshot["pr"]["author_id"] = 11
        self.assertIsNone(self.reader.sync_status(snapshot))

    def test_wrong_repo_or_issue_that_is_a_pr_are_rejected(self):
        self.rows[""]["id"] = 99
        with self.assertRaises(ValueError):
            self.reader.read_snapshot(4)
        self.rows[""]["id"] = 20
        self.rows["/issues/42"]["pull_request"] = {}
        with self.assertRaises(ValueError):
            self.reader.read_snapshot(4)

    def test_no_auto_merge_field_is_not_inferred_as_disabled(self):
        del self.pr["auto_merge"]
        with self.assertRaises(ValueError):
            self.reader.read_snapshot(4)

    def test_ruleset_listing_rejects_incomplete_page(self):
        self.rows["/rulesets?per_page=100&page=1&includes_parents=true"] = []
        original = self.reader.transport
        def partial(path, token, *, body=None):
            result, _ = original(path, token, body=body)
            return result, '<https://api.github.com/next>; rel="next"'
        self.reader.transport = partial
        with self.assertRaises(ValueError):
            self.reader._rulesets("test-token")

    def test_detects_pr_changed_during_read(self):
        original = self.reader.transport
        count = 0
        def changed(path, token, *, body=None):
            nonlocal count
            result = original(path, token, body=body)
            if path.endswith("/pulls/4"):
                count += 1
                if count == 2:
                    result[0]["head"]["sha"] = "b" * 40
            return result
        self.reader.transport = changed
        with self.assertRaises(ValueError):
            self.reader.read_snapshot(4)

    def test_check_protection_and_green_ci_are_read_from_expected_apps(self):
        self.reader.admission, self.reader.required_tests = ("flow-admission", 10), (("verify", 15368),)
        self.rows["/branches/smoke/protection"] = {"enforce_admins": {"enabled": True},
            "required_status_checks": {"checks": [{"context": "flow-admission", "app_id": 10},
                                                 {"context": "verify", "app_id": 15368}]}}
        self.rows["/rulesets?per_page=100&page=1&includes_parents=true"] = []
        self.rows[f"/commits/{self.sha}/check-runs?per_page=100&page=1"] = {"total_count": 1, "check_runs": [
            {"id": 5, "name": "verify", "app": {"id": 15368}, "head_sha": self.sha,
             "status": "completed", "conclusion": "success"}]}
        snapshot = self.reader.read_snapshot(4)
        self.assertTrue(snapshot["protection"])
        self.assertEqual(snapshot["checks"], "success")

    def test_merge_sends_only_one_expected_head_mutation(self):
        writes = []
        class Journal:
            def begin(self, number, sha):
                writes.append(("begin", number, sha))
            def confirm_merged(self, number):
                writes.append(("confirmed", number))
        self.reader.journal = Journal()
        def transport(path, token, *, body=None):
            if path == "/graphql":
                writes.append(body)
                self.pr["state"] = "closed"
                self.pr["merged"] = True
                return {"data": {"mergePullRequest": {"pullRequest": {"merged": True}}}}, None
            return self.transport(path, token, body=body)
        self.reader.transport = transport
        self.reader.merge(4, self.sha, "b" * 40)
        self.assertEqual(len(writes), 3)
        self.assertEqual(writes[0], ("begin", 4, self.sha))
        self.assertEqual(writes[1]["variables"], {"id": "PR_node", "sha": self.sha})
        self.assertEqual(writes[2], ("confirmed", 4))

    def test_merge_refuses_changed_head(self):
        with self.assertRaises(ValueError):
            self.reader.merge(4, "b" * 40, "b" * 40)

    def test_publishes_only_bounded_check_verdict_and_avoids_duplicate(self):
        self.reader.admission = ("flow-admission", 10)
        path = f"/commits/{self.sha}/check-runs?per_page=100&page=1"
        self.rows[path] = {"total_count": 0, "check_runs": []}
        writes = []
        def transport(path, token, *, body=None):
            if path == "/repos/owner/repo/check-runs":
                writes.append(body)
                return {"id": 21, "name": "flow-admission", "head_sha": self.sha, "app": {"id": 10}}, None
            return self.transport(path, token, body=body)
        self.reader.transport = transport
        self.assertEqual(self.reader.publish(self.sha, "missing-review-subagent"), "published")
        self.assertEqual(writes[0]["conclusion"], "failure")
        self.assertIn("Brakuje aktualnego review wykonanego przez subagenta", writes[0]["output"]["summary"])
        self.rows[path] = {"total_count": 1, "check_runs": [{"id": 21, "name": "flow-admission",
            "head_sha": self.sha, "app": {"id": 10}, "status": "completed", "conclusion": "failure",
            "output": {"summary": writes[0]["output"]["summary"]}}]}
        self.assertEqual(self.reader.publish(self.sha, "missing-review-subagent"), "unchanged")
        self.assertEqual(len(writes), 1)

    def test_reruns_only_ci_failure_caused_by_admission_wait(self):
        query = f"/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.sha}&per_page=100"
        self.rows[query] = {"total_count": 1, "workflow_runs": [{"id": 19, "run_attempt": 1,
            "status": "completed", "conclusion": "failure", "event": "pull_request", "head_sha": self.sha,
            "head_repository": {"id": 20}, "pull_requests": [{"number": 4}]}]}
        jobs_path = "/actions/runs/19/attempts/1/jobs?per_page=100"
        self.rows[jobs_path] = {"total_count": 1, "jobs": [{"name": "verify", "conclusion": "failure",
            "steps": [{"name": "Wait for flow admission", "conclusion": "failure"}]}]}
        writes = []
        def transport(path, token, *, body=None):
            if path.endswith("/actions/runs/19/rerun-failed-jobs"):
                writes.append(body)
                return None, None
            return self.transport(path, token, body=body)
        self.reader.transport = transport
        self.assertEqual(self.reader.rerun_blocked_ci(4), "rerun-requested")
        self.assertEqual(self.reader.rerun_blocked_ci(4), "already-requested")
        self.assertEqual(writes, [{}])

    def test_failed_product_tests_are_not_automatically_rerun(self):
        query = f"/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.sha}&per_page=100"
        self.rows[query] = {"total_count": 1, "workflow_runs": [{"id": 19, "run_attempt": 1,
            "status": "completed", "conclusion": "failure", "event": "pull_request", "head_sha": self.sha,
            "head_repository": {"id": 20}, "pull_requests": [{"number": 4}]}]}
        self.rows["/actions/runs/19/attempts/1/jobs?per_page=100"] = {"total_count": 1, "jobs": [
            {"name": "verify", "conclusion": "failure", "steps": [
                {"name": "Wait for flow admission", "conclusion": "success"},
                {"name": "Verify Node tests", "conclusion": "failure"}]}]}
        self.assertEqual(self.reader.rerun_blocked_ci(4), "not-gate-failure")

    def test_reruns_verified_pull_request_target_for_same_pr_and_head(self):
        self.reader.workflow_event = "pull_request_target"
        query = f"/actions/workflows/ci.yml/runs?event=pull_request_target&head_sha={self.sha}&per_page=100"
        run = {"id": 19, "run_attempt": 1, "status": "completed", "conclusion": "failure",
               "event": "pull_request_target", "head_sha": self.sha, "head_repository": {"id": 20},
               "pull_requests": [{"number": 4}]}
        self.rows[query] = {"total_count": 1, "workflow_runs": [run]}
        self.rows["/actions/runs/19/attempts/1/jobs?per_page=100"] = {"total_count": 1, "jobs": [{
            "name": "verify", "conclusion": "failure",
            "steps": [{"name": "Wait for flow admission", "conclusion": "failure"}]}]}
        writes = []
        def transport(path, token, *, body=None):
            if path.endswith("/actions/runs/19/rerun-failed-jobs"):
                writes.append(body)
                return None, None
            return self.transport(path, token, body=body)
        self.reader.transport = transport
        run["pull_requests"] = []
        self.assertEqual(self.reader.rerun_blocked_ci(4), "no-workflow")
        run["pull_requests"] = [{"number": 4}]
        self.assertEqual(self.reader.rerun_blocked_ci(4), "rerun-requested")
        self.assertEqual(writes, [{}])

    def test_target_without_pr_metadata_requires_one_matching_branch_pr(self):
        self.reader.workflow_event = "pull_request_target"
        self.pr["created_at"] = "2026-11-07T09:00:00Z"
        self.pr["head"]["ref"] = "codex/4-agent"
        query = f"/actions/workflows/ci.yml/runs?event=pull_request_target&head_sha={self.sha}&per_page=100"
        run = {"id": 19, "run_attempt": 1, "status": "completed", "conclusion": "failure",
               "event": "pull_request_target", "head_sha": self.sha, "head_repository": {"id": 20},
               "head_branch": "codex/4-agent", "created_at": "2026-11-07T09:01:00Z", "pull_requests": []}
        self.rows[query] = {"total_count": 1, "workflow_runs": [run]}
        lookup = "/pulls?state=all&head=owner%3Acodex%2F4-agent&per_page=100"
        self.rows[lookup] = [copy.deepcopy(self.pr), copy.deepcopy(self.pr)]
        self.rows["/actions/runs/19/attempts/1/jobs?per_page=100"] = {"total_count": 1, "jobs": [{
            "name": "verify", "conclusion": "failure",
            "steps": [{"name": "Wait for flow admission", "conclusion": "failure"}]}]}
        writes = []
        def transport(path, token, *, body=None):
            if path.endswith("/actions/runs/19/rerun-failed-jobs"):
                writes.append(body)
                return None, None
            return self.transport(path, token, body=body)
        self.reader.transport = transport
        self.assertEqual(self.reader.rerun_blocked_ci(4), "no-workflow")
        self.rows[lookup].pop()
        run["created_at"] = "2026-11-07T08:59:00Z"
        self.assertEqual(self.reader.rerun_blocked_ci(4), "no-workflow")
        run["created_at"] = "2026-11-07T09:01:00Z"
        self.assertEqual(self.reader.rerun_blocked_ci(4), "rerun-requested")
        self.assertEqual(writes, [{}])

    def prepare_shadowed_ci(self):
        """A newer skipped draft check hides an older successful ready run."""
        self.reader.required_tests = (("verify", 15368),)
        self.pr["created_at"] = "2026-11-07T09:00:00Z"
        self.pr["head"]["ref"] = "codex/4-agent"
        query = f"/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.sha}&per_page=100"
        def workflow(run_id, outcome):
            return {"id": run_id, "run_attempt": 1, "status": "completed", "conclusion": outcome,
                    "event": "pull_request", "head_sha": self.sha, "head_repository": {"id": 20},
                    "head_branch": "codex/4-agent", "created_at": "2026-11-07T09:01:00Z", "pull_requests": []}
        self.rows[query] = {"total_count": 2, "workflow_runs": [workflow(19, "success"), workflow(20, "skipped")]}
        lookup = "/pulls?state=all&head=owner%3Acodex%2F4-agent&per_page=100"
        self.rows[lookup] = [copy.deepcopy(self.pr)]
        def check(check_id, run_id, outcome):
            return {"id": check_id, "name": "verify", "app": {"id": 15368}, "head_sha": self.sha,
                    "status": "completed", "conclusion": outcome,
                    "details_url": f"https://github.com/owner/repo/actions/runs/{run_id}/job/{check_id}"}
        path = f"/commits/{self.sha}/check-runs?per_page=100&page=1"
        self.rows[path] = {"total_count": 2, "check_runs": [check(101, 20, "skipped"), check(100, 19, "success")]}
        for run_id, check_id, outcome in ((19, 100, "success"), (20, 101, "skipped")):
            self.rows[f"/actions/runs/{run_id}/attempts/1/jobs?per_page=100"] = {"total_count": 1, "jobs": [{
                "id": check_id, "name": "verify", "status": "completed", "conclusion": outcome,
                "steps": [{"name": "Verify", "conclusion": "success"}] if outcome == "success" else []}]}
        class Journal:
            def __init__(self): self.keys = set()
            def reserve(self, repo, number, run, attempt):
                key = (repo, run, attempt)
                if key in self.keys: return False
                self.keys.add(key)
                return True
        self.reader.ci_retry_journal = Journal()
        writes = []
        def transport(path, token, *, body=None):
            if path.endswith("/actions/runs/19/rerun"):
                writes.append(body)
                return None, None
            return self.transport(path, token, body=body)
        self.reader.transport = transport
        return writes

    def test_reruns_verified_green_run_shadowed_by_skipped_draft(self):
        writes = self.prepare_shadowed_ci()
        self.assertEqual(self.reader.rerun_blocked_ci(4), "rerun-requested")
        self.assertEqual(writes, [{}])
        # A restarted reader shares the durable journal and must not repeat an
        # uncertain POST for the same workflow attempt.
        self.reader._requested_ci_attempts.clear()
        self.assertEqual(self.reader.rerun_blocked_ci(4), "already-requested")
        self.assertEqual(writes, [{}])

    def test_shadowed_ci_handles_two_required_jobs_in_the_same_workflows(self):
        writes = self.prepare_shadowed_ci()
        self.reader.required_tests += (("canary", 15368),)
        path = f"/commits/{self.sha}/check-runs?per_page=100&page=1"
        for check_id, run_id, result in ((99, 19, "success"), (102, 20, "skipped")):
            self.rows[path]["check_runs"].append({"id": check_id, "name": "canary", "app": {"id": 15368},
                "head_sha": self.sha, "status": "completed", "conclusion": result,
                "details_url": f"https://github.com/owner/repo/actions/runs/{run_id}/job/{check_id}"})
            jobs = self.rows[f"/actions/runs/{run_id}/attempts/1/jobs?per_page=100"]
            jobs["jobs"].append({"id": check_id, "name": "canary", "status": "completed", "conclusion": result,
                                 "steps": [{"name": "Run tests", "conclusion": "success"}] if result == "success" else []})
            jobs["total_count"] += 1
        self.rows[path]["total_count"] += 2
        self.assertEqual(self.reader.rerun_blocked_ci(4), "rerun-requested")
        self.assertEqual(writes, [{}])

    def test_shadowed_ci_also_handles_explicit_single_pr_metadata(self):
        writes = self.prepare_shadowed_ci()
        query = f"/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.sha}&per_page=100"
        for run in self.rows[query]["workflow_runs"]:
            run["pull_requests"] = [{"number": 4}]
        self.assertEqual(self.reader.rerun_blocked_ci(4), "rerun-requested")
        self.assertEqual(writes, [{}])

    def test_late_skipped_attempt_of_older_workflow_is_still_recognized(self):
        writes = self.prepare_shadowed_ci()
        query = f"/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.sha}&per_page=100"
        skipped = self.rows[query]["workflow_runs"][1]
        skipped["id"] = 18  # An older workflow can create a newer check on rerun.
        checks = self.rows[f"/commits/{self.sha}/check-runs?per_page=100&page=1"]["check_runs"]
        checks[0]["details_url"] = "https://github.com/owner/repo/actions/runs/18/job/101"
        self.rows["/actions/runs/18/attempts/1/jobs?per_page=100"] = self.rows.pop(
            "/actions/runs/20/attempts/1/jobs?per_page=100")
        self.assertEqual(self.reader.rerun_blocked_ci(4), "rerun-requested")
        self.assertEqual(writes, [{}])

    def test_newer_failed_workflow_is_not_hidden_by_skipped_check(self):
        writes = self.prepare_shadowed_ci()
        query = f"/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.sha}&per_page=100"
        runs = self.rows[query]["workflow_runs"]
        failed = dict(runs[0], id=21, conclusion="failure")
        runs.append(failed)
        self.rows[query]["total_count"] += 1
        self.rows["/actions/runs/21/attempts/1/jobs?per_page=100"] = {"total_count": 1, "jobs": [{
            "name": "verify", "conclusion": "failure",
            "steps": [{"name": "Verify Node tests", "conclusion": "failure"}]}]}
        self.assertNotEqual(self.reader.rerun_blocked_ci(4), "rerun-requested")
        self.assertEqual(writes, [])

    def test_shadowed_ci_rejects_multiple_explicit_pr_associations(self):
        writes = self.prepare_shadowed_ci()
        query = f"/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.sha}&per_page=100"
        for run in self.rows[query]["workflow_runs"]:
            run["pull_requests"] = [{"number": 4}, {"number": 5}]
        self.assertEqual(self.reader.rerun_blocked_ci(4), "no-workflow")
        self.assertEqual(writes, [])

    def test_shadowed_ci_does_not_retry_after_lost_response_or_pr_change(self):
        self.prepare_shadowed_ci()
        calls = []
        previous = self.reader.transport
        def lost(path, token, *, body=None):
            if path.endswith("/actions/runs/19/rerun"):
                calls.append(path)
                raise TimeoutError("uncertain response")
            return previous(path, token, body=body)
        self.reader.transport = lost
        with self.assertRaises(TimeoutError):
            self.reader.rerun_blocked_ci(4)
        self.reader._requested_ci_attempts.clear()
        self.assertEqual(self.reader.rerun_blocked_ci(4), "already-requested")
        self.assertEqual(len(calls), 1)

        self.setUp()
        writes = self.prepare_shadowed_ci()
        previous = self.reader.transport
        count = 0
        def changed(path, token, *, body=None):
            nonlocal count
            result, link = previous(path, token, body=body)
            if path.endswith("/pulls/4"):
                count += 1
                if count == 2:
                    result["head"]["sha"] = "b" * 40
            return result, link
        self.reader.transport = changed
        self.assertEqual(self.reader.rerun_blocked_ci(4), "pr-changed")
        self.assertEqual(writes, [])

    def test_shadowed_ci_rejects_unverified_or_ambiguous_evidence(self):
        cases = ("wrong-sha", "wrong-app", "bad-url", "failed-tests", "wrong-job",
                 "empty-green-steps", "multiple-prs", "other-red-check", "in-progress", "no-journal")
        for case in cases:
            with self.subTest(case=case):
                self.setUp()
                writes = self.prepare_shadowed_ci()
                checks = self.rows[f"/commits/{self.sha}/check-runs?per_page=100&page=1"]["check_runs"]
                workflows = self.rows[f"/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.sha}&per_page=100"]["workflow_runs"]
                if case == "wrong-sha": checks[0]["head_sha"] = "b" * 40
                if case == "wrong-app": checks[0]["app"]["id"] = 999
                if case == "bad-url": checks[0]["details_url"] = "https://elsewhere.invalid/runs/20/job/101"
                if case == "failed-tests": checks[1]["conclusion"] = "failure"
                if case == "wrong-job": self.rows["/actions/runs/20/attempts/1/jobs?per_page=100"]["jobs"][0]["id"] = 102
                if case == "empty-green-steps": self.rows["/actions/runs/19/attempts/1/jobs?per_page=100"]["jobs"][0]["steps"] = []
                if case == "multiple-prs": self.rows["/pulls?state=all&head=owner%3Acodex%2F4-agent&per_page=100"].append(copy.deepcopy(self.pr))
                if case == "other-red-check":
                    self.reader.required_tests += (("other", 15368),)
                    checks.append({"id": 102, "name": "other", "app": {"id": 15368}, "head_sha": self.sha,
                                   "status": "completed", "conclusion": "failure"})
                    self.rows[f"/commits/{self.sha}/check-runs?per_page=100&page=1"]["total_count"] += 1
                if case == "in-progress": workflows[0]["status"] = "in_progress"
                if case == "no-journal": self.reader.ci_retry_journal = None
                self.assertNotEqual(self.reader.rerun_blocked_ci(4), "rerun-requested")
                self.assertEqual(writes, [])


if __name__ == "__main__":
    unittest.main()
