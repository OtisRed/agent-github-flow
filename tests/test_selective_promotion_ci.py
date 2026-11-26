import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from selective_promotion_ci import verify_candidate_ci


class SelectiveCiTests(unittest.TestCase):
    def setUp(self):
        self.repo = "Owner/project"
        self.expected = {"repository_id": 1, "pr": 2, "main": "a" * 40,
                         "candidate": "b" * 40, "tree": "c" * 40}
        self.policy = {"workflow_id": 3, "app_id": 4, "workflow_path": ".github/workflows/ci.yml",
                       "workflow_blob": "d" * 40, "checkout_sha": "e" * 40}
        base, head = self.expected["main"], self.expected["candidate"]
        self.tested = "f" * 40
        self.pull = {"number": 2, "state": "open", "draft": True,
                     "base": {"ref": "main", "sha": base, "repo": {"id": 1}},
                     "head": {"sha": head, "repo": {"id": 1}}}
        self.step = {"name": "Check out event revision", "status": "completed", "conclusion": "success",
                     "started_at": "2026-11-25T00:00:00Z", "completed_at": "2026-11-25T00:00:01Z"}
        self.log = (f"2026-11-25T00:00:00.5Z ##[group]Run actions/checkout@{self.policy['checkout_sha']}\n"
                    "2026-11-25T00:00:01.1Z [command]/usr/bin/git log -1 --format=%H\n"
                    f"2026-11-25T00:00:01.2Z {self.tested}\n")
        self.commit_path = f"git/commits/{self.tested}"
        self.check_path = f"commits/{head}/check-runs?check_name=verify&filter=latest&per_page=100"
        self.test_workflow = f"contents/{self.policy['workflow_path']}?ref={self.tested}"
        self.responses = {
            "git/ref/heads/main": {"object": {"sha": base}}, "pulls/2": self.pull,
            "actions/runs/5": {"id": 5, "repository": {"id": 1}, "workflow_id": 3,
                               "path": ".github/workflows/ci.yml", "event": "pull_request",
                               "head_sha": head, "status": "completed", "conclusion": "success",
                               "run_attempt": 1, "check_suite_id": 7, "pull_requests": [copy.deepcopy(self.pull)]},
            "actions/jobs/6": {"id": 6, "run_id": 5, "run_attempt": 1, "head_sha": head, "name": "verify",
                               "status": "completed", "conclusion": "success", "steps": [self.step],
                               "check_run_url": f"https://api.github.com/repos/{self.repo}/check-runs/6"},
            "actions/jobs/6/logs": self.log,
            f"contents/{self.policy['workflow_path']}?ref={base}": {"sha": self.policy["workflow_blob"]},
            self.test_workflow: {"sha": self.policy["workflow_blob"]},
            self.commit_path: {"sha": self.tested, "tree": {"sha": self.expected["tree"]},
                               "parents": [{"sha": base}, {"sha": head}]},
            self.check_path: {"total_count": 1, "check_runs": [{"id": 6, "app": {"id": 4}, "name": "verify",
                              "head_sha": head, "status": "completed", "conclusion": "success",
                              "check_suite": {"id": 7}}]},
        }

    def read(self, path):
        return self.responses[path.removeprefix(f"repos/{self.repo}/")]

    def verify(self, read=None):
        return verify_candidate_ci(read or self.read, self.repo, self.expected, self.policy, 5, 6)

    def test_verifies_draft_without_treating_check_head_as_tested_commit(self):
        result = self.verify()
        self.assertEqual(result["kind"], "verified")
        self.assertEqual(result["test_commit"], self.tested)
        self.assertNotEqual(result["test_commit"], result["checks"][0]["head_sha"])

    def test_main_changed_during_read_discards_otherwise_valid_ci(self):
        reads = 0

        def moving_main(path):
            nonlocal reads
            if path.endswith("/git/ref/heads/main"):
                reads += 1
                if reads == 2:
                    return {"object": {"sha": "9" * 40}}
            return self.read(path)

        self.assertEqual(self.verify(moving_main), {"kind": "blocked", "reason": "main-changed"})

    def test_old_ci_is_rejected_after_base_change_even_when_head_stays(self):
        self.expected["main"] = "9" * 40
        self.responses["git/ref/heads/main"]["object"]["sha"] = self.expected["main"]
        self.pull["base"]["sha"] = self.expected["main"]
        self.assertEqual(self.verify()["reason"], "run-mismatch")

    def test_green_check_without_matching_test_tree_or_approved_workflow_is_rejected(self):
        self.responses[self.commit_path]["tree"]["sha"] = "0" * 40
        self.assertEqual(self.verify()["reason"], "tested-tree-or-parents-mismatch")
        self.responses[self.commit_path]["tree"]["sha"] = self.expected["tree"]
        self.responses[self.test_workflow]["sha"] = "0" * 40
        self.assertEqual(self.verify()["reason"], "unapproved-tested-workflow")

    def test_later_log_lines_do_not_substitute_for_the_checkout(self):
        self.responses["actions/jobs/6/logs"] = self.log.replace("00:00:01.", "00:00:04.")
        self.assertEqual(self.verify()["reason"], "checkout-revision-missing")

    def test_latest_check_and_attempt_are_bound_to_the_same_run(self):
        self.responses["actions/jobs/6"]["run_attempt"] = 2
        self.assertEqual(self.verify()["reason"], "job-mismatch")
        self.responses["actions/jobs/6"]["run_attempt"] = 1
        self.responses[self.check_path]["check_runs"][0]["id"] = 8
        self.assertEqual(self.verify()["reason"], "check-mismatch")
        self.responses[self.check_path]["total_count"] = 2
        self.assertEqual(self.verify()["reason"], "checks-incomplete")
