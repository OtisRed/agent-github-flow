import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from dependabot_intake import intake_step
from dependabot_journal import DependabotJournal
from dependabot_plan import BOT_ID, marker
from mvp_store import Store


class Gateway:
    def __init__(self):
        self.pr = {"number": 12, "state": "open", "draft": False, "body": "Dependabot notes",
                   "node_id": "PR_test", "user": {"id": BOT_ID, "login": "dependabot[bot]", "type": "Bot"},
                   "head": {"repo": {"id": 20}}, "base": {"ref": "main", "repo": {"id": 20}}}
        self.issues, self.created, self.normalized, self.lose_response = [], 0, [], False

    def read_pr(self, number):
        return self.pr

    def list_issues(self):
        return self.issues

    def create_issue(self, number, body):
        self.created += 1
        self.issues.append({"number": 13, "state": "open", "body": body})
        if self.lose_response:
            raise TimeoutError()

    def normalize(self, pr, issue):
        self.normalized.append(issue)


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        store = Store(Path(self.temp.name) / "state.sqlite")
        store.initialize()
        self.journal = DependabotJournal(store)
        self.journal.initialize()
        self.gateway = Gateway()

    def run_step(self):
        return intake_step(self.gateway, self.journal, "OtisRed/repo", 20, 12)

    def test_creation_then_recovery_after_lost_response(self):
        self.gateway.lose_response = True
        self.assertEqual(self.run_step(), "creation-unconfirmed")
        self.assertEqual(self.run_step(), "normalized")
        self.assertEqual(self.gateway.created, 1)
        self.assertEqual(self.gateway.normalized, [13])

    def test_existing_legacy_issue_is_reused(self):
        self.gateway.issues = [{"number": 22, "state": "open", "body": marker("OtisRed/repo", 12, legacy=True)}]
        self.assertEqual(self.run_step(), "normalized")
        self.assertEqual(self.gateway.created, 0)
        self.assertEqual(self.gateway.normalized, [22])

    def test_missing_issue_after_intent_stops_retry(self):
        self.journal.begin(20, 12)
        self.assertEqual(self.run_step(), "creation-unconfirmed")
        self.assertEqual(self.gateway.created, 0)

    def test_unrelated_link_or_invalid_bot_never_mutates(self):
        self.gateway.pr["body"] += "\nRefs #42"
        self.assertEqual(self.run_step(), "already-linked")
        self.gateway.pr["user"]["id"] = 1
        self.assertEqual(self.run_step(), "unsupported")
        self.assertEqual(self.gateway.created, 0)
        self.assertEqual(self.gateway.normalized, [])
