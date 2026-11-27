import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from archive_cleanup import read_cleanup
from mvp_decision import _date


class ArchiveCleanupTests(unittest.TestCase):
    def setUp(self):
        self.closed = _date("2026-11-24T02:00:00Z")
        self.body = ("[ARCHIVE-CLEANUP]\nCycle: 4\nScope: code\nWorktrees: removed\nBranches: removed"
                     "\nTemporary: not-created\nEnvironment: retained")

    def item(self, number=11, *, author=7, author_type="User", body=None, created="2026-11-24T03:00:00Z",
             edited=None):
        return {"id": number, "body": self.body if body is None else body,
                "user": {"id": author, "type": author_type}, "created_at": created, "updated_at": edited or created}

    def proof(self, comments, has_sources=True):
        return read_cleanup(iter(comments), 4, self.closed, {7, 8}, has_sources=has_sources)

    def test_complete_attestation_and_retained_environment(self):
        result = self.proof([self.item()])
        self.assertEqual((result["kind"], result["comment_id"], result["environment"]), ("confirmed", 11, "retained"))

    def test_old_cycle_untrusted_author_bot_and_before_close_do_not_supply_evidence(self):
        old = self.item(12, body=self.body.replace("Cycle: 4", "Cycle: 3"))
        before = self.item(13, created="2026-11-24T01:59:59Z")
        bot = self.item(14, author=8, author_type="Bot")
        self.assertEqual(self.proof([old, before, bot, self.item(author=42)])["reason"], "cleanup-missing")

    def test_new_blocked_attestation_replaces_positive_until_successful_retry(self):
        blocked = self.item(12, body=self.body.replace("Branches: removed", "Branches: blocked"))
        self.assertEqual(self.proof([blocked, self.item()])["reason"], "cleanup-incomplete")
        self.assertEqual(self.proof([self.item(13), self.item(), blocked])["comment_id"], 13)

    def test_edited_or_malformed_latest_attestation_does_not_fall_back(self):
        edited = self.item(12, edited="2026-11-24T03:01:00Z")
        self.assertEqual(self.proof([self.item(), edited])["reason"], "cleanup-edited")
        malformed = self.item(13, body=self.body + "\nPrivate path")
        self.assertEqual(self.proof([self.item(), malformed])["reason"], "cleanup-invalid")

    def test_no_code_must_be_explicit_and_match_inventory(self):
        no_code = self.item(body=self.body.replace("Scope: code", "Scope: no-code"))
        self.assertEqual(self.proof([no_code])["reason"], "cleanup-scope-mismatch")
        self.assertEqual(self.proof([self.item()], has_sources=False)["reason"], "cleanup-scope-mismatch")
        self.assertEqual(self.proof([no_code], has_sources=False)["kind"], "confirmed")
