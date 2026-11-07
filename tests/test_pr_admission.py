import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pr_admission import evaluate, issue_requirement, pr_issue_number


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 40
        self.pr = {"state": "open", "draft": False, "head_sha": self.sha, "body": "Result\nRefs #42\n"}
        self.issue = {"number": 42, "state": "open", "body": "Wymagane review: 1\n"}
        self.trusted = frozenset({7})

    def review(self, cid, role="agent-prowadzacy", sha=None, result="pozytywny", author=7):
        return {"id": cid, "author_id": author, "updated_at": f"2026-11-07T00:00:{cid:02d}Z", "body": "\n".join([
            "[REVIEW]", "Rola: " + role, "Commit: " + (sha or self.sha), "Wynik: " + result,
            "Zakres: test", "DA: checked a failure path and found none"])}

    def decision(self, comments):
        return evaluate(self.pr, self.issue, comments, self.trusted)

    def test_one_review_and_absent_legacy_requirement(self):
        self.assertEqual(self.decision([self.review(1)]), "ready")
        self.issue["body"] = "Legacy issue"
        self.assertEqual(self.decision([self.review(1)]), "ready")

    def test_requirement_rejects_invalid_and_duplicate_values(self):
        for body in ("Wymagane review: 0", "Wymagane review: 2\nWymagane review: 1", "Wymagane review: two", "Wymagane review - 2", "Wymagane  review: 2", "**Wymagane review: 2**"):
            self.assertIsNone(issue_requirement(body))

    def test_two_reviews_require_subagent_not_duplicate(self):
        self.issue["body"] = "Wymagane review: 2"
        self.assertEqual(self.decision([self.review(1), self.review(2)]), "missing-review-subagent")
        self.assertEqual(self.decision([self.review(1), self.review(2, "subagent")]), "ready")

    def test_negative_newer_review_blocks_previous_positive(self):
        comments = [self.review(2, result="wymaga-poprawek"), self.review(1)]
        self.assertEqual(self.decision(comments), "review-requires-changes-agent-prowadzacy")

    def test_edited_older_comment_is_not_hidden_by_later_comment_id(self):
        old = self.review(1, result="wymaga-poprawek")
        old["updated_at"] = "2026-11-07T00:00:03Z"
        self.assertEqual(self.decision([old, self.review(2)]), "review-requires-changes-agent-prowadzacy")
        old["updated_at"] = "2026-11-07T00:00:02Z"
        self.assertEqual(self.decision([old, self.review(2)]), "ambiguous-review-agent-prowadzacy")

    def test_wrong_commit_untrusted_or_deleted_review_does_not_count(self):
        for comments in ([], [self.review(1, sha="b" * 40)], [self.review(1, author=8)]):
            self.assertEqual(self.decision(comments), "missing-review-agent-prowadzacy")

    def test_missing_da_and_ambiguous_format_block(self):
        review = self.review(1)
        review["body"] = review["body"].replace("DA: checked a failure path and found none", "DA: ")
        self.assertEqual(self.decision([review]), "invalid-review")
        review = self.review(1)
        review["body"] += "\nDA: duplicate"
        self.assertEqual(self.decision([review]), "invalid-review")
        review = self.review(1)
        review["body"] = review["body"].replace("checked a failure path and found none", "Nie znalazłem uwag.")
        self.assertEqual(self.decision([review]), "invalid-review")

    def test_pr_issue_link_is_one_standalone_ref(self):
        self.assertEqual(pr_issue_number("Refs #42\nRefs #42"), None)
        self.assertEqual(pr_issue_number("text Refs #42"), None)
        self.assertEqual(pr_issue_number("Refs #42"), 42)

    def test_draft_and_closed_issue_are_blocked(self):
        self.pr["draft"] = True
        self.assertEqual(self.decision([self.review(1)]), "pr-not-ready")
        self.pr["draft"] = False
        self.issue["state"] = "closed"
        self.assertEqual(self.decision([self.review(1)]), "invalid-issue-link")


if __name__ == "__main__":
    unittest.main()
