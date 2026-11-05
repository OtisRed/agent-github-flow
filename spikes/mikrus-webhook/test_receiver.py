import hashlib
import hmac
import http.client
import importlib.util
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
SECRET = b"synthetic-secret-for-tests-only-123456789"


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = str(Path(self.temp.name) / "queue.sqlite")
        secret = Path(self.temp.name) / "secret"
        secret.write_bytes(SECRET)
        self.secret_path = str(secret)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.process = None
        self.start_receiver()

    def tearDown(self):
        self.stop_receiver()
        self.temp.cleanup()

    def start_receiver(self):
        self.process = subprocess.Popen([sys.executable, str(HERE / "receiver.py"), "--database", self.database,
            "--secret-file", self.secret_path, "--repository-id", "12", "--installation-id", "34", "--port", str(self.port)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=0.5)
                connection.request("GET", "/agf-spike/health")
                response = connection.getresponse(); response.read(); connection.close()
                if response.status == 200:
                    return
            except OSError:
                time.sleep(0.05)
        self.fail("receiver did not become ready")

    def stop_receiver(self):
        if self.process:
            self.process.terminate()
            self.process.wait(timeout=5)
            self.process = None

    def send(self, body, delivery_id, event="issue_comment", secret=SECRET):
        raw = json.dumps(body, separators=(",", ":")).encode()
        signature = "sha256=" + hmac.new(secret, raw, hashlib.sha256).hexdigest()
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("POST", "/agf-spike/webhook", raw, {"Content-Type": "application/json",
            "X-Hub-Signature-256": signature, "X-GitHub-Event": event, "X-GitHub-Delivery": delivery_id})
        response = connection.getresponse(); response.read(); status = response.status; connection.close()
        return status

    def rows(self):
        with sqlite3.connect(self.database) as db:
            return db.execute("SELECT delivery_id,event,action,issue_number,comment_id FROM deliveries").fetchall()

    def event(self):
        return {"action": "created", "repository": {"id": 12}, "installation": {"id": 34},
            "issue": {"number": 8, "body": "synthetic private issue text"},
            "comment": {"id": 77, "body": "synthetic private comment text"}}

    def test_signed_event_is_durable_across_real_process_restart_and_deduplicated(self):
        delivery = str(uuid.uuid4()); event = self.event()
        self.assertEqual(self.send(event, delivery), 202)
        for path in Path(self.temp.name).glob("queue.sqlite*"):
            self.assertNotIn(b"synthetic private", path.read_bytes())
        self.stop_receiver(); self.start_receiver()
        self.assertEqual(self.send(event, delivery), 202)
        self.assertEqual(self.rows(), [(delivery, "issue_comment", "created", 8, 77)])
        self.stop_receiver()
        self.assertNotIn(b"synthetic private", Path(self.database).read_bytes())

    def test_invalid_signature_other_project_and_unsubscribed_event_do_not_create_rows(self):
        self.assertEqual(self.send(self.event(), str(uuid.uuid4()), secret=b"wrong"), 403)
        other = self.event(); other["repository"]["id"] = 99
        self.assertEqual(self.send(other, str(uuid.uuid4())), 202)
        self.assertEqual(self.send(self.event(), str(uuid.uuid4()), event="push"), 202)
        invalid = self.event(); invalid["repository"]["id"] = True
        self.assertEqual(self.send(invalid, str(uuid.uuid4())), 400)
        invalid = self.event(); invalid["installation"]["id"] = True
        self.assertEqual(self.send(invalid, str(uuid.uuid4())), 400)
        self.assertEqual(self.rows(), [])

    def test_conflicting_redelivery_and_unavailable_storage_are_not_acknowledged(self):
        delivery = str(uuid.uuid4()); event = self.event()
        self.assertEqual(self.send(event, delivery), 202)
        event["comment"]["body"] = "changed content"
        self.assertEqual(self.send(event, delivery), 409)
        with sqlite3.connect(self.database) as db:
            db.execute("DROP TABLE deliveries")
        self.assertEqual(self.send(self.event(), str(uuid.uuid4())), 503)

    def test_app_repository_dispatch_is_recorded_without_payload(self):
        delivery = str(uuid.uuid4()); body = {"action": "agf_webhook_spike_v1", "repository": {"id": 12},
            "installation": {"id": 34}, "client_payload": {"marker": "synthetic private marker"}}
        self.assertEqual(self.send(body, delivery, event="repository_dispatch"), 202)
        self.assertEqual(self.rows(), [(delivery, "repository_dispatch", "agf_webhook_spike_v1", None, None)])

    def test_same_signed_body_replayed_with_different_delivery_id_is_rejected(self):
        body = self.event()
        self.assertEqual(self.send(body, str(uuid.uuid4())), 202)
        self.assertEqual(self.send(body, str(uuid.uuid4())), 409)
        self.assertEqual(len(self.rows()), 1)

    def test_oversized_or_duplicate_length_headers_are_refused(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.putrequest("POST", "/agf-spike/webhook")
        for key, value in {"Content-Length": "262145", "X-Hub-Signature-256": "sha256=" + "0" * 64,
            "X-GitHub-Event": "issues", "X-GitHub-Delivery": str(uuid.uuid4())}.items():
            connection.putheader(key, value)
        connection.endheaders(); response = connection.getresponse(); response.read()
        self.assertEqual(response.status, 413); connection.close()
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.putrequest("POST", "/agf-spike/webhook")
        connection.putheader("Content-Length", "1"); connection.putheader("Content-Length", "1")
        connection.putheader("X-Hub-Signature-256", "sha256=" + "0" * 64)
        connection.putheader("X-GitHub-Event", "issues"); connection.putheader("X-GitHub-Delivery", str(uuid.uuid4()))
        connection.endheaders(b"x"); response = connection.getresponse(); response.read()
        self.assertEqual(response.status, 400); connection.close(); self.assertEqual(self.rows(), [])

    def test_partial_client_does_not_block_another_request(self):
        slow = socket.create_connection(("127.0.0.1", self.port), timeout=2)
        try:
            slow.sendall(b"POST /agf-spike/webhook HTTP/1.1\r\nHost: localhost\r\n")
            connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
            connection.request("GET", "/agf-spike/health"); response = connection.getresponse(); response.read()
            self.assertEqual(response.status, 200); connection.close()
        finally:
            slow.close()

    @unittest.skipUnless(os.name == "posix", "POSIX permission check")
    def test_existing_world_readable_database_is_refused(self):
        self.stop_receiver()
        os.chmod(self.database, 0o644)
        spec = importlib.util.spec_from_file_location("spike_receiver", HERE / "receiver.py")
        receiver = importlib.util.module_from_spec(spec); spec.loader.exec_module(receiver)
        with self.assertRaises(ValueError):
            receiver.initialize(self.database)


if __name__ == "__main__":
    unittest.main()
