import concurrent.futures
import hashlib
import hmac
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "src" / "webhook_ingress.py"
spec = importlib.util.spec_from_file_location("webhook_ingress", MODULE_PATH)
ingress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingress)
SECRET = b"synthetic-only-secret-do-not-use-in-production"
FINGERPRINT_KEY = b"different-synthetic-fingerprint-key-for-tests-only"


@unittest.skipUnless(os.name == "posix", "Queue requires POSIX ownership and modes")
class WebhookIngressTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="agf-queue-#-test-")
        self.path = Path(self.directory.name) / "queue.sqlite"
        self.registry = ingress.validate_registry([(101, 201), (101, 202), (102, 203)])
        ingress.initialize(self.path, FINGERPRINT_KEY)

    def tearDown(self):
        self.directory.cleanup()

    def payload(self, repository=201, installation=101):
        return {"action": "created", "repository": {"id": repository}, "installation": {"id": installation},
                "issue": {"number": 8, "body": "synthetic private issue"},
                "comment": {"id": 77, "body": "synthetic private comment"}}

    def send(self, payload=None, delivery=None, event="issue_comment", secret=SECRET, signature=None, registry=None):
        payload = self.payload() if payload is None else payload
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        signature = signature or "sha256=" + hmac.new(secret, raw, hashlib.sha256).hexdigest()
        return ingress.receive(self.path, SECRET, FINGERPRINT_KEY, self.registry if registry is None else registry,
                               delivery or str(uuid.uuid4()), event, signature, raw)

    def rows(self):
        with sqlite3.connect(self.path) as db:
            return db.execute("""SELECT delivery_id, installation_id, repository_id, event, action,
                                        issue_number, comment_id FROM ingress_deliveries ORDER BY rowid""").fetchall()

    def test_distinct_projects_and_installations_are_recorded(self):
        first, second, third = (str(uuid.uuid4()) for _ in range(3))
        self.assertEqual(self.send(self.payload(201, 101), first), "accepted")
        self.assertEqual(self.send(self.payload(202, 101), second), "accepted")
        self.assertEqual(self.send(self.payload(203, 102), third), "accepted")
        self.assertEqual([x[:3] for x in self.rows()], [(first, 101, 201), (second, 101, 202), (third, 102, 203)])

    def test_observe_delivery_keeps_ids_exact_and_does_not_acknowledge(self):
        delivery = str(uuid.uuid4())
        registry = ingress.validate_registry([(9007199254740993, 9007199254740995)])
        payload = self.payload(9007199254740995, 9007199254740993)
        payload["comment"]["id"] = 9007199254740997
        self.assertEqual(self.send(payload, delivery, registry=registry), "accepted")
        expected = {"kind": "delivery", "deliveryId": delivery, "installationId": "9007199254740993",
                    "repositoryId": "9007199254740995", "event": "issue_comment", "action": "created",
                    "issueNumber": "8", "commentId": "9007199254740997"}
        self.assertEqual(ingress.read_delivery(self.path, FINGERPRINT_KEY, delivery), expected)
        self.assertEqual(ingress.read_delivery(self.path, FINGERPRINT_KEY, delivery), expected)
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(ingress.read_delivery(self.path, b"wrong-key-" * 4, delivery), {"kind": "storage_unavailable"})
        self.assertEqual(ingress.read_delivery(self.path, FINGERPRINT_KEY, str(uuid.uuid4())), {"kind": "missing"})
        self.assertEqual(ingress.read_delivery(self.path, FINGERPRINT_KEY, "bad"), {"kind": "invalid"})

    def test_scan_pages_restart_finds_insert_before_current_marker(self):
        first = "10000000-0000-4000-8000-000000000000"
        middle = "80000000-0000-4000-8000-000000000000"
        last = "f0000000-0000-4000-8000-000000000000"
        self.assertEqual(self.send(delivery=middle), "accepted")
        self.assertEqual(self.send(delivery=last), "accepted")
        self.assertEqual(ingress.scan_delivery_ids(self.path, FINGERPRINT_KEY, limit=1),
                         {"kind": "page", "deliveryIds": [middle], "more": True})
        self.assertEqual(self.send(delivery=first), "accepted")
        self.assertEqual(ingress.scan_delivery_ids(self.path, FINGERPRINT_KEY, after=middle, limit=1),
                         {"kind": "page", "deliveryIds": [last], "more": False})
        self.assertEqual(ingress.scan_delivery_ids(self.path, FINGERPRINT_KEY, limit=2),
                         {"kind": "page", "deliveryIds": [first, middle], "more": True})
        self.assertEqual(ingress.scan_delivery_ids(self.path, FINGERPRINT_KEY, after=last),
                         {"kind": "page", "deliveryIds": [], "more": False})
        self.assertEqual(ingress.scan_delivery_ids(self.path, FINGERPRINT_KEY, limit=True), {"kind": "invalid"})
        self.assertEqual(ingress.scan_delivery_ids(self.path, b"wrong-key-" * 4), {"kind": "storage_unavailable"})

    @unittest.skipUnless(os.environ.get("AGF_CONTROLLER_ROOT") and os.environ.get("AGF_NODE"),
                         "Actual controller checkout and Node not supplied")
    def test_real_controller_resolver_on_two_synthetic_queue_entries(self):
        delivery_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        registry = ingress.validate_registry([(101, 201), (102, 202)])
        for delivery, installation, repository in zip(delivery_ids, (101, 102), (201, 202)):
            self.assertEqual(self.send(self.payload(repository, installation), delivery, registry=registry), "accepted")
        entries = [ingress.read_delivery(self.path, FINGERPRINT_KEY, value) for value in delivery_ids]
        script = Path(__file__).with_name("ingress-resolver-integration.mjs")
        result = subprocess.run([os.environ["AGF_NODE"], str(script)], input=json.dumps(entries), text=True,
                                capture_output=True, check=True,
                                env={"AGF_CONTROLLER_ROOT": os.environ["AGF_CONTROLLER_ROOT"]})
        self.assertEqual(result.stdout.strip(), "synthetic queue-to-real-resolver passed")
        self.assertEqual(len(self.rows()), 2)

    def test_same_delivery_deduplicates_and_changed_body_conflicts(self):
        delivery = str(uuid.uuid4())
        self.assertEqual(self.send(delivery=delivery), "accepted")
        self.assertEqual(self.send(delivery=delivery), "duplicate")
        changed = self.payload(); changed["comment"]["body"] = "different private text"
        self.assertEqual(self.send(changed, delivery), "conflict")
        self.assertEqual(len(self.rows()), 1)

    def test_identical_signed_body_with_new_delivery_is_not_silently_dropped(self):
        self.assertEqual(self.send(delivery=str(uuid.uuid4())), "accepted")
        self.assertEqual(self.send(delivery=str(uuid.uuid4())), "accepted")
        self.assertEqual(len(self.rows()), 2)

    def test_rejects_unknown_project_invalid_signature_and_ambiguous_identity(self):
        self.assertEqual(self.send(self.payload(999, 101)), "unknown_project")
        self.assertEqual(self.send(self.payload(201, 102)), "unknown_project")
        self.assertEqual(self.send(secret=b"wrong synthetic secret"), "bad_signature")
        bad = self.payload(); bad["repository"]["id"] = True
        self.assertEqual(self.send(bad), "invalid")
        bad = self.payload(); bad["installation"]["id"] = True
        self.assertEqual(self.send(bad), "invalid")
        bad = self.payload(); bad["issue"]["pull_request"] = {}
        self.assertEqual(self.send(bad), "ignored")
        bad = self.payload(); bad["comment"]["id"] = False
        self.assertEqual(self.send(bad), "invalid")
        self.assertEqual(self.send(event="push"), "unsupported")
        self.assertEqual(self.rows(), [])

    def test_issue_events_require_known_actions_and_issue_id(self):
        item = self.payload(); item.pop("comment"); item["action"] = "reopened"
        self.assertEqual(self.send(item, event="issues"), "accepted")
        self.assertEqual(self.rows()[0][3:7], ("issues", "reopened", 8, None))
        item["action"] = "not_a_known_action"
        self.assertEqual(self.send(item, event="issues"), "unsupported")

    def test_persistence_and_private_payload_absent_after_separate_process(self):
        delivery = str(uuid.uuid4())
        self.assertEqual(self.send(delivery=delivery), "accepted")
        probe = ("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
                 "print(c.execute('select count(*) from ingress_deliveries').fetchone()[0])")
        result = subprocess.run([sys.executable, "-c", probe, str(self.path)], check=True, capture_output=True, text=True)
        self.assertEqual(result.stdout.strip(), "1")
        ingress.initialize(self.path, FINGERPRINT_KEY)
        self.assertEqual(self.send(delivery=delivery), "duplicate")
        for item in Path(self.directory.name).glob("queue.sqlite*"):
            self.assertNotIn(b"synthetic private", item.read_bytes())

    def test_storage_failures_never_report_success(self):
        with sqlite3.connect(self.path) as db:
            db.execute("DROP TABLE ingress_deliveries")
        self.assertEqual(self.send(), "storage_unavailable")

    def test_existing_unrelated_database_is_not_migrated(self):
        other = Path(self.directory.name) / "other.sqlite"
        with sqlite3.connect(other) as db:
            db.execute("CREATE TABLE existing (value TEXT)")
            db.execute("INSERT INTO existing VALUES ('keep')")
        os.chmod(other, 0o600)
        before = other.read_bytes()
        with self.assertRaises(ValueError):
            ingress.initialize(other, FINGERPRINT_KEY)
        self.assertEqual(before, other.read_bytes())

    def test_insecure_database_and_symlink_are_refused(self):
        os.chmod(self.path, 0o644)
        with self.assertRaises(ValueError):
            ingress.initialize(self.path, FINGERPRINT_KEY)
        self.assertEqual(self.send(), "storage_unavailable")
        os.chmod(self.path, 0o600)
        target = Path(self.directory.name) / "link.sqlite"
        target.symlink_to(self.path)
        with self.assertRaises(ValueError):
            ingress.initialize(target, FINGERPRINT_KEY)

    def test_signed_ping_irrelevant_actions_and_installation_attention(self):
        self.assertEqual(self.send(event="ping"), "ignored")
        self.assertEqual(self.send(event="installation"), "attention")
        self.assertEqual(self.send(event="installation_repositories"), "attention")
        item = self.payload(); item["action"] = "labeled"
        self.assertEqual(self.send(item, event="issues"), "ignored")
        item["repository"]["id"] = 999
        self.assertEqual(self.send(item, event="issues"), "unknown_project")
        self.assertEqual(self.rows(), [])

    def test_redelivery_after_webhook_secret_rotation_deduplicates(self):
        delivery = str(uuid.uuid4()); raw = json.dumps(self.payload(), separators=(",", ":")).encode()
        self.assertEqual(self.send(delivery=delivery), "accepted")
        rotated = b"new-synthetic-webhook-secret-long-enough"
        sig = "sha256=" + hmac.new(rotated, raw, hashlib.sha256).hexdigest()
        self.assertEqual(ingress.receive(self.path, rotated, FINGERPRINT_KEY, self.registry,
                                         delivery, "issue_comment", sig, raw), "duplicate")
        another_key = b"different-synthetic-key-without-approved-rotation"
        self.assertEqual(ingress.receive(self.path, rotated, another_key, self.registry,
                                         delivery, "issue_comment", sig, raw), "storage_unavailable")
        with self.assertRaises(ValueError):
            ingress.initialize(self.path, another_key)
        self.assertEqual(len(self.rows()), 1)

    def test_tampered_schema_trigger_is_rejected_without_accepting(self):
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TRIGGER remove_receipt AFTER INSERT ON ingress_deliveries BEGIN DELETE FROM ingress_deliveries; END")
        with self.assertRaises(ValueError):
            ingress.initialize(self.path, FINGERPRINT_KEY)
        self.assertEqual(self.send(), "storage_unavailable")
        self.assertEqual(self.rows(), [])

    def test_trigger_named_like_sqlite_wildcard_is_rejected(self):
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TRIGGER sqliteXerase AFTER INSERT ON ingress_deliveries BEGIN DELETE FROM ingress_deliveries; END")
        self.assertEqual(self.send(), "storage_unavailable")
        self.assertEqual(self.rows(), [])

    def test_non_ascii_key_marker_fails_closed(self):
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE ingress_meta SET value=? WHERE name='fingerprint_key'", ("ż",))
        self.assertEqual(self.send(), "storage_unavailable")
        with self.assertRaises(ValueError):
            ingress.initialize(self.path, FINGERPRINT_KEY)
        self.assertEqual(self.rows(), [])

    def test_changed_journal_mode_is_not_accepted_or_silently_changed(self):
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        self.assertEqual(self.send(), "storage_unavailable")
        with self.assertRaises(ValueError):
            ingress.initialize(self.path, FINGERPRINT_KEY)
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")

    def test_concurrent_same_delivery_has_one_winner(self):
        delivery = str(uuid.uuid4()); barrier = threading.Barrier(4)
        def run(_):
            barrier.wait(timeout=5)
            return self.send(delivery=delivery)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            outcomes = list(pool.map(run, range(4)))
        self.assertEqual(outcomes.count("accepted"), 1)
        self.assertEqual(outcomes.count("duplicate"), 3)
        self.assertEqual(len(self.rows()), 1)

    def test_busy_queue_does_not_acknowledge(self):
        connection = sqlite3.connect(self.path)
        try:
            connection.execute("BEGIN IMMEDIATE")
            self.assertEqual(self.send(), "storage_unavailable")
        finally:
            connection.rollback(); connection.close()
        self.assertEqual(self.rows(), [])

    def test_oversized_json_integer_is_a_safe_rejection(self):
        raw = b'{"number":' + b'9' * 5000 + b'}'
        signature = "sha256=" + hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
        self.assertEqual(ingress.receive(self.path, SECRET, FINGERPRINT_KEY, self.registry,
                                         str(uuid.uuid4()), "issues", signature, raw), "invalid")
        self.assertEqual(self.rows(), [])

    def test_registry_requires_unambiguous_positive_identifiers(self):
        for registry in ([], [(101, 201), (101, 201)], [(101, 201), (102, 201)], [(True, 201)], [(101,) ]):
            with self.subTest(registry=registry):
                with self.assertRaises(ValueError):
                    ingress.validate_registry(registry)


if __name__ == "__main__":
    unittest.main()
