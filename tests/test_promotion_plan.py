import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from promotion_plan import closed_prefix, issue_reference


class PromotionPlanTests(unittest.TestCase):
    def setUp(self):
        self.entries = [
            {"issue": 1, "sha": "a" * 40, "merged_at": "2026-11-01T10:00:00Z"},
            {"issue": 2, "sha": "b" * 40, "merged_at": "2026-11-01T11:00:00Z"},
            {"issue": 3, "sha": "c" * 40, "merged_at": "2026-11-01T12:00:00Z"},
        ]
        self.closed = {n: {"state": "closed", "closed_at": "2026-11-02T00:00:00Z"} for n in (1, 2, 3)}

    def test_exactly_one_standalone_reference(self):
        self.assertEqual(issue_reference("Summary\n\nRefs #12\n"), 12)
        for text in ("Refs #12. text", "Refs #12\nRefs #12", "no refs", "Refs #0"):
            self.assertIsNone(issue_reference(text))

    def test_prefix_stops_at_first_open_issue(self):
        self.closed[2] = {"state": "open", "closed_at": None}
        self.assertEqual(closed_prefix(self.entries, self.closed), {"kind": "ready", "sha": "a" * 40, "count": 1})
        self.closed[1] = {"state": "open", "closed_at": None}
        self.assertEqual(closed_prefix(self.entries, self.closed), {"kind": "waiting", "reason": "open-issue"})

    def test_later_merge_for_same_issue_requires_new_closure(self):
        self.entries[2]["issue"] = 1
        self.closed[1]["closed_at"] = "2026-11-01T10:30:00Z"
        self.assertEqual(closed_prefix(self.entries, self.closed), {"kind": "waiting", "reason": "open-issue"})

    def test_missing_or_ambiguous_data_is_blocked(self):
        self.assertEqual(closed_prefix([], {}), {"kind": "idle"})
        del self.closed[3]
        self.assertEqual(closed_prefix(self.entries, self.closed)["kind"], "blocked")
        self.closed[3] = {"state": "closed", "closed_at": None}
        self.assertEqual(closed_prefix(self.entries, self.closed)["kind"], "blocked")
        self.entries[1]["sha"] = self.entries[0]["sha"]
        self.assertEqual(closed_prefix(self.entries, self.closed)["kind"], "blocked")


if __name__ == "__main__":
    unittest.main()
