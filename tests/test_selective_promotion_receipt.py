import copy
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_store import Store
from selective_promotion_merge import SelectiveMergeJournal
from selective_promotion_receipt import read_receipt


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "state.sqlite"
        Store(self.path).initialize()
        self.journal = SelectiveMergeJournal(self.path, require_existing=True)
        self.manifest = {"repository_id": 1, "main": "a" * 40, "smoke": "b" * 40,
                         "candidate": "c" * 40, "tree": "d" * 40,
                         "sources": [{"issue": 264, "cycle": 6, "pr": 265,
                                      "sha": "b" * 40, "method": "merge"}]}
        self.squash, self.main = "e" * 40, "f" * 40
        self.compare = f"/compare/{self.squash}...{self.main}?per_page=1"
        self.commit = f"/git/commits/{self.squash}"
        self.responses = {
            "": {"id": 1, "full_name": "Owner/repo"},
            "/git/ref/heads/main": {"object": {"sha": self.main}},
            self.commit: {"sha": self.squash, "tree": {"sha": "d" * 40}, "parents": [{"sha": "a" * 40}]},
            self.compare: {"merge_base_commit": {"sha": self.squash}},
        }

    def read(self, path):
        self.assertTrue(path.startswith("/repos/Owner/repo"))
        return self.responses[path.removeprefix("/repos/Owner/repo")]

    def report(self, issue=264, read=None):
        return read_receipt(self.path, "Owner/repo", 1, issue, read or self.read)

    def confirm(self):
        self.assertTrue(self.journal.reserve(1, 267, self.manifest))
        self.assertTrue(self.journal.confirm(1, 267, self.squash))

    def test_reports_exact_confirmed_receipt_without_touching_state(self):
        self.confirm()
        other = copy.deepcopy(self.manifest)
        other["repository_id"] = 2
        self.assertTrue(self.journal.reserve(2, 267, other))
        before = self.path.read_bytes()
        self.assertEqual(self.report()["receipts"], [{
            "promotion_pr": 267, "cycle": 6, "source_prs": [{"pr": 265, "sha": "b" * 40}],
            "status": "confirmed", "squash": self.squash,
        }])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.report(265)["status"], "not-recorded")

    def test_separates_pending_and_off_main_from_confirmation(self):
        self.assertTrue(self.journal.reserve(1, 267, self.manifest))
        pending, = self.report()["receipts"]
        self.assertEqual(pending["status"], "pending")
        self.assertNotIn("squash", pending)
        self.assertTrue(self.journal.confirm(1, 267, self.squash))
        self.responses[self.compare]["merge_base_commit"]["sha"] = self.manifest["main"]
        outside, = self.report()["receipts"]
        self.assertEqual(outside["status"], "not-on-main")
        self.assertNotIn("squash", outside)

    def test_rejects_a_moving_main_and_incorrect_immutable_tree(self):
        self.confirm()
        original = self.read
        def moving(path):
            value = original(path)
            if path.endswith(self.compare):
                self.responses["/git/ref/heads/main"] = {"object": {"sha": "9" * 40}}
            return value
        with self.assertRaisesRegex(ValueError, "Main changed"):
            self.report(read=moving)
        self.responses["/git/ref/heads/main"] = {"object": {"sha": self.main}}
        self.responses[self.commit]["tree"]["sha"] = "0" * 40
        with self.assertRaisesRegex(ValueError, "does not match"):
            self.report()
