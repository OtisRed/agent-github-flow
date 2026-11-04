import hashlib
import hmac
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_http import PATH, make_server
from mvp_store import Store
from webhook_ingress import validate_registry


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / "state.sqlite")
        self.store.initialize()
        self.secret = b"synthetic-secret-only-for-local-test-purposes"
        self.server = make_server(self.store, self.secret, validate_registry([(10, 20)]))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    def request(self, *, valid=True, path=PATH):
        body = json.dumps({"action": "created", "repository": {"id": 20},
                           "installation": {"id": 10}, "issue": {"number": 7},
                           "comment": {"id": 42}}).encode()
        signature = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest() if valid else "sha256=" + "0" * 64
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request("POST", path, body=body, headers={"X-GitHub-Event": "issue_comment",
                                "X-Hub-Signature-256": signature})
            response = connection.getresponse()
            response.read()
            return response.status
        finally:
            connection.close()

    def test_only_signed_event_is_acknowledged_and_persisted(self):
        self.assertEqual(self.request(valid=False), 401)
        self.assertIsNone(self.store.next_pending())
        self.assertEqual(self.request(), 202)
        self.assertEqual(Store(self.store.path).next_pending()["issue_number"], 7)
        self.assertEqual(self.request(path="/unexpected"), 404)

    def test_missing_database_returns_unavailable(self):
        self.store.path.unlink()
        self.assertEqual(self.request(), 503)
        self.assertFalse(self.store.path.exists())


if __name__ == "__main__":
    unittest.main()
