import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pr_admission_runner import admission_step


class Gateway:
    def __init__(self, snapshots, *, fail_merge=False):
        self.snapshots = list(snapshots)
        self.merges = []
        self.published = []
        self.fail_merge = fail_merge

    def read_snapshot(self, _number):
        return self.snapshots.pop(0)

    def merge(self, number, sha):
        self.merges.append((number, sha))
        if self.fail_merge:
            raise TimeoutError()

    def publish(self, sha, verdict):
        self.published.append((sha, verdict))


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 40
        comment = "\n".join(("[REVIEW]", "Rola: agent-prowadzacy", "Commit: " + self.sha,
                             "Wynik: pozytywny", "Zakres: paths", "DA: checked missing data"))
        self.snapshot = {"complete": True, "protection": True, "checks": "success",
                         "pr": {"state": "open", "draft": False, "head_sha": self.sha,
                                "body": "Refs #42", "base_ref": "smoke", "same_repository": True,
                                "auto_merge_enabled": False},
                         "issue": {"number": 42, "state": "open", "body": "Wymagane review: 1"},
                         "comments": [{"id": 1, "author_id": 7, "body": comment}]}

    def run_step(self, first, second=None):
        gateway = Gateway([first] + ([second] if second is not None else []))
        return admission_step(gateway, 4, frozenset({7})), gateway.merges

    def test_merge_is_guarded_by_second_read_and_exact_head(self):
        result, merges = self.run_step(self.snapshot, copy.deepcopy(self.snapshot))
        self.assertEqual(result, "merge-requested")
        self.assertEqual(merges, [(4, self.sha)])

    def test_changed_or_deleted_review_between_reads_prevents_merge(self):
        later = copy.deepcopy(self.snapshot)
        later["comments"] = []
        result, merges = self.run_step(self.snapshot, later)
        self.assertEqual(result, "missing-review-agent-prowadzacy")
        self.assertEqual(merges, [])

    def test_increased_requirement_between_reads_prevents_merge(self):
        later = copy.deepcopy(self.snapshot)
        later["issue"]["body"] = "Wymagane review: 2"
        result, merges = self.run_step(self.snapshot, later)
        self.assertEqual(result, "missing-review-subagent")
        self.assertEqual(merges, [])

    def test_positive_review_edited_between_reads_is_rechecked_later(self):
        later = copy.deepcopy(self.snapshot)
        later["comments"][0]["body"] += " again"
        result, merges = self.run_step(self.snapshot, later)
        self.assertEqual(result, "review-input-changed")
        self.assertEqual(merges, [])

    def test_new_head_without_review_prevents_merge(self):
        later = copy.deepcopy(self.snapshot)
        later["pr"]["head_sha"] = "b" * 40
        result, merges = self.run_step(self.snapshot, later)
        self.assertEqual(result, "missing-review-agent-prowadzacy")
        self.assertEqual(merges, [])

    def test_unprotected_pending_failed_or_unknown_checks_never_merge(self):
        for key, value in (("protection", False), ("checks", "pending"), ("checks", "failure"), ("checks", None)):
            snapshot = copy.deepcopy(self.snapshot)
            snapshot[key] = value
            _, merges = self.run_step(snapshot)
            self.assertFalse(merges)

    def test_previously_enabled_auto_merge_is_refused(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot["pr"]["auto_merge_enabled"] = True
        result, merges = self.run_step(snapshot)
        self.assertEqual(result, "unsupported-pr")
        self.assertFalse(merges)

    def test_timeout_does_not_retry_merge(self):
        gateway = Gateway([self.snapshot, copy.deepcopy(self.snapshot)], fail_merge=True)
        with self.assertRaises(TimeoutError):
            admission_step(gateway, 4, frozenset({7}))
        self.assertEqual(gateway.merges, [(4, self.sha)])


if __name__ == "__main__":
    unittest.main()
