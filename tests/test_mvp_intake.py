import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import mvp_intake
from mvp_store import Store
from webhook_ingress import validate_registry


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / "state.sqlite")
        self.store.initialize()
        self.secret = b"synthetic-test-secret-not-for-any-real-use"
        self.registry = validate_registry([(10, 20)])

    def send(self, payload, *, signature=None, event="issue_comment", store=None):
        body = json.dumps(payload).encode()
        signature = signature or ("sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest())
        return mvp_intake.receive(store or self.store, self.secret, self.registry, event, signature, body)

    def payload(self):
        return {"action": "created", "repository": {"id": 20}, "installation": {"id": 10},
                "issue": {"number": 7, "body": "private synthetic body"}, "comment": {"id": 42}}

    def test_signed_event_is_committed_and_duplicate_coalesces(self):
        self.assertEqual(self.send(self.payload()), "accepted")
        self.assertEqual(self.send(self.payload()), "accepted")
        item = Store(self.store.path).next_pending()
        self.assertEqual((item["repository_id"], item["issue_number"], item["generation"]), (20, 7, 2))
        self.assertNotIn("private synthetic body", str(item))

    def test_invalid_signature_or_project_never_enqueues(self):
        self.assertEqual(self.send(self.payload(), signature="sha256=" + "0" * 64), "bad_signature")
        other = self.payload()
        other["repository"]["id"] = 21
        self.assertEqual(self.send(other), "ignored")
        other["installation"]["id"] = 11
        self.assertEqual(self.send(other), "unknown_project")
        self.assertIsNone(self.store.next_pending())

    def test_missing_database_is_not_acknowledged(self):
        missing = Store(Path(self.directory.name) / "missing.sqlite")
        self.assertEqual(self.send(self.payload(), store=missing), "storage_unavailable")
        self.assertFalse(missing.path.exists())

    def test_pull_request_comment_is_ignored(self):
        payload = self.payload()
        payload["issue"]["pull_request"] = {}
        self.assertEqual(self.send(payload), "ignored")
        self.assertIsNone(self.store.next_pending())


if __name__ == "__main__":
    unittest.main()
