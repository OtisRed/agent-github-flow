import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pr_admission_checks import protected_checks, rulesets_do_not_bypass_smoke, tests_state


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.admission = ("flow-admission", 10)
        self.tests = (("verify", 15368),)
        self.protection = {"enforce_admins": {"enabled": True}, "required_status_checks": {"checks": [
            {"context": "flow-admission", "app_id": 10}, {"context": "verify", "app_id": 15368}]}}
        self.sha = "a" * 40
        self.run = {"id": 1, "name": "verify", "app": {"id": 15368}, "head_sha": self.sha,
                    "status": "completed", "conclusion": "success"}

    def test_requires_both_checks_bound_to_the_correct_apps(self):
        self.assertTrue(protected_checks(self.protection, self.admission, self.tests))
        self.protection["required_status_checks"]["checks"][0]["app_id"] = 11
        self.assertFalse(protected_checks(self.protection, self.admission, self.tests))

    def test_missing_app_binding_or_admin_enforcement_is_not_verified(self):
        self.protection["enforce_admins"]["enabled"] = False
        self.assertFalse(protected_checks(self.protection, self.admission, self.tests))
        self.protection["enforce_admins"]["enabled"] = True
        self.protection["required_status_checks"]["checks"][1]["app_id"] = None
        self.assertFalse(protected_checks(self.protection, self.admission, self.tests))

    def test_latest_test_failure_replaces_older_success(self):
        failed = dict(self.run, id=2, conclusion="failure")
        self.assertEqual(tests_state([failed, self.run], self.sha, self.tests), "failure")
        self.assertEqual(tests_state([self.run], self.sha, self.tests), "success")

    def test_wrong_app_sha_or_missing_check_is_not_success(self):
        self.assertEqual(tests_state([dict(self.run, app={"id": 999})], self.sha, self.tests), "pending")
        self.assertEqual(tests_state([dict(self.run, head_sha="b" * 40)], self.sha, self.tests), "unknown")
        self.assertEqual(tests_state([], self.sha, self.tests), "pending")

    def test_other_branch_ruleset_does_not_block_but_potential_bypass_does(self):
        other = {"enforcement": "active", "target": "branch", "conditions": {"ref_name": {
            "include": ["refs/heads/agent-github-flow/registry-anchor"], "exclude": []}},
            "bypass_actors": [{"actor_type": "Integration", "actor_id": 10}]}
        self.assertTrue(rulesets_do_not_bypass_smoke([other]))
        other["conditions"]["ref_name"]["include"] = ["refs/heads/*"]
        self.assertFalse(rulesets_do_not_bypass_smoke([other]))
        other["bypass_actors"] = []
        self.assertTrue(rulesets_do_not_bypass_smoke([other]))
        other["conditions"]["ref_name"]["include"] = ["unknown-ref-format"]
        other["bypass_actors"] = [{"actor_id": 10}]
        self.assertFalse(rulesets_do_not_bypass_smoke([other]))


if __name__ == "__main__":
    unittest.main()
