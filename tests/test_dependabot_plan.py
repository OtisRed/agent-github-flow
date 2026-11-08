import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from dependabot_plan import BOT_ID, find_managed, inspect_pr, issue_body, marker


class DependabotPlanTests(unittest.TestCase):
    def setUp(self):
        self.pr = {"number": 12, "state": "open", "draft": False, "body": "Aktualizacja zależności",
                   "node_id": "PR_test", "user": {"id": BOT_ID, "login": "dependabot[bot]", "type": "Bot"},
                   "head": {"repo": {"id": 20}}, "base": {"ref": "main", "repo": {"id": 20}}}

    def test_accepts_only_real_same_repo_dependabot(self):
        self.assertEqual(inspect_pr(self.pr, 20, 12), "unlinked")
        self.pr["user"]["id"] = 999
        self.assertEqual(inspect_pr(self.pr, 20, 12), "unsupported")
        self.pr["user"]["id"] = BOT_ID
        self.pr["head"]["repo"]["id"] = 99
        self.assertEqual(inspect_pr(self.pr, 20, 12), "unsupported")

    def test_existing_and_ambiguous_refs_never_create_new_issue(self):
        self.pr["body"] += "\n\nRefs #13"
        self.assertEqual(inspect_pr(self.pr, 20, 12), "linked")
        self.pr["body"] += "\nRefs #14"
        self.assertEqual(inspect_pr(self.pr, 20, 12), "ambiguous")

    def test_finds_existing_vsone_or_common_marker(self):
        for legacy in (False, True):
            issues = [{"number": 13, "state": "open", "body": marker("OtisRed/VSonenote-plugin", 12, legacy=legacy)}]
            self.assertEqual(find_managed(issues, "OtisRed/VSonenote-plugin", 12), 13)
        self.assertIn("Wymagane review: 1", issue_body("OtisRed/VSonenote-plugin", 12))

    def test_duplicate_or_closed_marker_is_not_guessed(self):
        body = marker("OtisRed/repo", 12)
        with self.assertRaises(ValueError):
            find_managed([{"number": 13, "state": "closed", "body": body}], "OtisRed/repo", 12)
        with self.assertRaises(ValueError):
            find_managed([{"number": 13, "state": "open", "body": body},
                          {"number": 14, "state": "open", "body": body}], "OtisRed/repo", 12)


if __name__ == "__main__":
    unittest.main()
