import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pr_flow_decision import decide_pr_handoff, draft_message, merged_message, select_pr_handoff


class PrFlowDecisionTests(unittest.TestCase):
    def setUp(self):
        self.pr = {"number": 12, "body": "Opis\n\nRefs #7", "base_ref": "smoke",
                   "head_ref": "issue/7-change", "same_repository": True, "state": "open",
                   "merged": False, "created_at": "2026-11-08T10:02:00Z", "merge_commit_sha": "a" * 40}
        self.issue = {"number": 7, "complete": True, "state": "OPEN", "status": "agent-ready",
                      "latest_reopen": None}
        self.flow = {"author_id": 4, "created_at": "2026-11-08T10:01:00Z",
                     "body": "[FLOW]\nRola: designer\nStan docelowy: agent-ready\n"
                             "Wykonano: Kontrakt.\nNastępny krok: Implementacja."}

    def decide(self):
        return decide_pr_handoff(self.pr, self.issue, self.flow,
                                 enrolled_at="2026-11-08T10:00:00Z", app_author_id=99)

    def test_current_draft_advances_and_duplicate_does_not(self):
        self.assertEqual(self.decide(), draft_message(12))
        self.issue["status"] = "review"
        self.flow.update(body=draft_message(12), author_id=99, created_at="2026-11-08T10:03:00Z")
        self.assertIsNone(self.decide())

    def test_verified_merge_advances_same_pr_once(self):
        self.issue["status"] = "review"
        self.flow.update(body=draft_message(12), author_id=99, created_at="2026-11-08T10:03:00Z")
        self.pr.update(state="closed", merged=True, merged_at="2026-11-08T10:04:00Z")
        self.assertEqual(self.decide(), merged_message(12))
        self.flow.update(body=merged_message(12), created_at="2026-11-08T10:05:00Z")
        self.issue["status"] = "smoke"
        self.assertIsNone(self.decide())

    def test_old_merge_cannot_replace_newer_cycle(self):
        self.pr.update(state="closed", merged=True, merged_at="2026-11-08T10:04:00Z")
        self.issue["status"] = "review"
        self.flow.update(body=draft_message(13), author_id=99, created_at="2026-11-08T10:03:00Z")
        self.assertIsNone(self.decide())

    def test_recovery_when_entire_pr_cycle_happened_during_outage(self):
        self.pr.update(state="closed", merged=True, merged_at="2026-11-08T10:04:00Z")
        self.assertEqual(self.decide(), merged_message(12))
        self.flow["created_at"] = "2026-11-08T10:05:00Z"
        self.assertIsNone(self.decide())

    def test_reopen_and_cutover_exclude_old_pr(self):
        self.issue["latest_reopen"] = {"created_at": "2026-11-08T10:05:00Z"}
        self.flow["created_at"] = "2026-11-08T10:06:00Z"
        self.assertIsNone(self.decide())
        self.issue["latest_reopen"] = None
        self.pr["created_at"] = "2026-11-08T09:59:00Z"
        self.assertIsNone(self.decide())

    def test_wrong_link_foreign_pr_sync_and_closed_issue_do_not_advance(self):
        for key, value in (("body", "Refs #7\nRefs #8"), ("base_ref", "main"),
                           ("same_repository", False), ("head_ref", "sync-main/123")):
            with self.subTest(key=key):
                old = self.pr[key]
                self.pr[key] = value
                self.assertIsNone(self.decide())
                self.pr[key] = old
        self.issue["state"] = "CLOSED"
        self.assertIsNone(self.decide())

    def test_untrusted_or_changed_review_handoff_does_not_advance(self):
        self.pr.update(state="closed", merged=True, merged_at="2026-11-08T10:04:00Z")
        self.issue["status"] = "review"
        self.flow.update(body=draft_message(12), author_id=4, created_at="2026-11-08T10:03:00Z")
        self.assertIsNone(self.decide())
        self.flow["author_id"] = 99
        self.flow["body"] += "\nextra"
        self.assertIsNone(self.decide())

    def test_multiple_matching_prs_are_ambiguous(self):
        other = {**self.pr, "number": 13}
        kwargs = {"enrolled_at": "2026-11-08T10:00:00Z", "app_author_id": 99}
        self.assertIsNone(select_pr_handoff([self.pr, other], self.issue, self.flow, **kwargs))
        self.assertEqual(select_pr_handoff([self.pr], self.issue, self.flow, **kwargs), draft_message(12))


if __name__ == "__main__":
    unittest.main()
