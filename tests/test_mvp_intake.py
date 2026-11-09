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

    def test_check_suite_is_acknowledged_only_after_signature_verification(self):
        payload = {"action": "requested", "repository": {"id": 20}, "installation": {"id": 10}}
        self.assertEqual(self.send(payload, event="check_suite"), "ignored")
        self.assertEqual(self.send(payload, event="check_suite", signature="sha256=" + "0" * 64), "bad_signature")
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

    def test_pr_comment_wakes_only_optional_admission_worker(self):
        payload = self.payload()
        payload["issue"]["pull_request"] = {}
        body = json.dumps(payload).encode()
        signature = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        signals = []
        result = mvp_intake.receive(self.store, self.secret, self.registry, "issue_comment", signature, body,
                                    wake_admission=lambda: signals.append(True))
        self.assertEqual(result, "accepted")
        self.assertEqual(signals, [True])
        self.assertIsNone(self.store.next_pending())

    def test_pr_event_is_only_a_wakeup_for_enrolled_installation(self):
        payload = {"action": "ready_for_review", "repository": {"id": 20}, "installation": {"id": 10}}
        body = json.dumps(payload).encode()
        signature = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        signals = []
        wake = lambda: signals.append(True)
        self.assertEqual(mvp_intake.receive(self.store, self.secret, self.registry, "pull_request", signature,
                                            body, wake_admission=wake), "accepted")
        self.assertEqual(signals, [True])
        self.assertIsNone(self.store.next_pending())

    def test_pr_event_queues_linked_issue_for_enabled_status_project(self):
        payload = {"action": "closed", "repository": {"id": 20}, "installation": {"id": 10},
                   "pull_request": {"body": "Opis\n\nRefs #7"}}
        body = json.dumps(payload).encode()
        signature = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        signals = []
        result = mvp_intake.receive(self.store, self.secret, self.registry, "pull_request", signature, body,
                                    wake_admission=lambda: signals.append(True), status_repositories=frozenset({20}))
        self.assertEqual(result, "accepted")
        self.assertEqual(signals, [True])
        self.assertEqual(self.store.next_pending()["issue_number"], 7)

    def test_pr_hint_does_not_queue_disabled_or_ambiguous_project(self):
        payload = {"action": "opened", "repository": {"id": 20}, "installation": {"id": 10},
                   "pull_request": {"body": "Refs #7"}}
        for repositories, body_text in ((frozenset(), "Refs #7"), (frozenset({20}), "Refs #7\nRefs #8"),
                                        (frozenset({20}), "Refs #" + "9" * 5000)):
            payload["pull_request"]["body"] = body_text
            body = json.dumps(payload).encode()
            signature = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
            self.assertEqual(mvp_intake.receive(self.store, self.secret, self.registry, "pull_request", signature, body,
                             wake_admission=lambda: None, status_repositories=repositories), "accepted")
            self.assertIsNone(self.store.next_pending())

    def test_pr_hint_reports_failed_queue_write(self):
        payload = {"action": "closed", "repository": {"id": 20}, "installation": {"id": 10},
                   "pull_request": {"body": "Refs #7"}}
        body = json.dumps(payload).encode()
        signature = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        missing = Store(Path(self.directory.name) / "missing.sqlite")
        self.assertEqual(mvp_intake.receive(missing, self.secret, self.registry, "pull_request", signature, body,
                         wake_admission=lambda: None, status_repositories=frozenset({20})), "storage_unavailable")

    def test_status_project_receives_pr_without_admission_worker(self):
        payload = {"action": "opened", "repository": {"id": 20}, "installation": {"id": 10},
                   "pull_request": {"body": "Refs #7"}}
        body = json.dumps(payload).encode()
        signature = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        self.assertEqual(mvp_intake.receive(self.store, self.secret, self.registry, "pull_request", signature, body,
                         status_repositories=frozenset({20})), "accepted")
        self.assertEqual(self.store.next_pending()["issue_number"], 7)

    def test_admission_only_repository_never_queues_issue_status(self):
        signals = []
        payload = self.payload()
        body = json.dumps(payload).encode()
        signature = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        result = mvp_intake.receive(self.store, self.secret, self.registry, "issue_comment", signature, body,
                                    wake_admission=lambda: signals.append(True), status_repositories=frozenset())
        self.assertEqual(result, "ignored")
        self.assertEqual(signals, [True])
        self.assertIsNone(self.store.next_pending())

    def test_status_enabled_repository_still_queues_issue(self):
        payload = self.payload()
        body = json.dumps(payload).encode()
        signature = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        result = mvp_intake.receive(self.store, self.secret, self.registry, "issue_comment", signature, body,
                                    status_repositories=frozenset({20}))
        self.assertEqual(result, "accepted")
        self.assertEqual(self.store.next_pending()["repository_id"], 20)


if __name__ == "__main__":
    unittest.main()
