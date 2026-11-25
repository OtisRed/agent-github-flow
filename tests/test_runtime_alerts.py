import importlib.util
import json
import socket
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_credentials import AppToken
from mvp_errors import GitHubRequestError
from runtime_alerts import handle, parse_config, report_alert


ENDPOINT = "/repos/example/monitor"
KIND = "queue-delay"
CONFIG = {"services": [{"uid": 18001, "repository_id": 123456, "repository": "example/monitor",
                        "alerts": {KIND: {"title": "Queue delay", "body": "Check the queue.",
                                          "legacy_marker": "<!-- old:queue-delay -->"}}}]}


class FixtureGitHub:
    def __init__(self):
        self.issues = {}
        self.repository_id = 123456
        self.writes = 0
        self.timeout = False
        self.denied = False
        self.hide_once = False

    def __call__(self, path, token, *, body=None):
        assert token == "synthetic-token"
        if path == ENDPOINT:
            return {"id": self.repository_id}, None
        if path == f"{ENDPOINT}/issues" and body:
            self.writes += 1
            if self.denied:
                raise GitHubRequestError("http-403")
            number = len(self.issues) + 1
            self.issues[number] = dict(body, number=number, state="open")
            if self.timeout:
                raise GitHubRequestError("timeout")
            return self.issues[number], None
        if path.startswith(f"{ENDPOINT}/issues?state="):
            if self.hide_once:
                self.hide_once = False
                return [], None
            return [issue for issue in self.issues.values()
                    if "state=all" in path or issue["state"] == "open"], None
        return self.issues[int(path.split("/")[-1])], None


class RuntimeAlertTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.database = Path(folder.name) / "state.sqlite3"
        self.peers = parse_config(json.dumps(CONFIG))
        self.github = FixtureGitHub()

    def publish(self, route, kind):
        with closing(sqlite3.connect(self.database)) as db:
            return report_alert(db, route, kind, "synthetic-token", transport=self.github)

    def submit(self, uid=18001, payload=b'{"kind":"queue-delay"}\n'):
        client, server = socket.socketpair()
        with client, server:
            client.sendall(payload)
            client.shutdown(socket.SHUT_WR)
            return handle(server, uid, self.peers, self.publish)

    def test_authorized_uid_can_create_only_its_configured_alert(self):
        self.assertEqual(self.submit(uid=0), {"status": "denied"})
        self.assertEqual(self.submit(payload=b'{"kind":"other"}\n'), {"status": "denied"})
        for payload in (b'{"kind":"queue-delay","repo":"example/other"}\n',
                        b'{"kind":"other","kind":"queue-delay"}\n',
                        b'{"kind":"queue-delay"}\n{}\n', b"x" * 257,
                        b'[["kind","queue-delay"]]\n'):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.submit(payload=payload)
        self.assertEqual(self.github.writes, 0)
        self.assertFalse(self.database.exists())
        self.assertEqual(self.submit(), {"status": "created", "issue": 1})
        self.assertEqual(self.submit(), {"status": "existing", "issue": 1})
        self.assertIn("Check the queue.", self.github.issues[1]["body"])
        self.assertEqual(self.github.writes, 1)
        self.github.issues[1]["state"] = "closed"
        self.assertEqual(self.submit(), {"status": "created", "issue": 2})

    def test_ambiguous_write_survives_restart_and_delayed_visibility(self):
        self.github.timeout = True
        with self.assertRaises(GitHubRequestError):
            self.submit()
        self.github.hide_once = True
        self.assertEqual(self.submit(), {"status": "pending"})
        self.github.issues[1]["state"] = "closed"
        self.assertEqual(self.submit(), {"status": "existing", "issue": 1})
        self.assertEqual(self.github.writes, 1)

    def test_rejected_write_can_be_retried(self):
        self.github.denied = True
        with self.assertRaises(GitHubRequestError):
            self.submit()
        self.github.denied = False
        self.assertEqual(self.submit(), {"status": "created", "issue": 1})

    def test_reused_slug_cannot_redirect_alerts(self):
        self.github.repository_id = 123457
        with self.assertRaisesRegex(ValueError, "Unexpected repository"):
            self.submit()
        self.assertEqual(self.github.writes, 0)

    def test_adopts_open_alert_from_legacy_sender(self):
        self.github.issues[1] = {"body": "<!-- old:queue-delay -->\n\nPrior alert", "number": 1, "state": "open"}
        self.assertEqual(self.submit(), {"status": "existing", "issue": 1})
        self.assertEqual(self.github.writes, 0)

    @unittest.skipUnless(importlib.util.find_spec("cryptography"), "cryptography is unavailable")
    def test_token_requests_only_one_repository_and_issue_write(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
        now = 1_800_000_000
        expiry = datetime.fromtimestamp(now + 3600, timezone.utc).isoformat()
        remote_permissions = {"issues": "write", "metadata": "read"}

        def mint(path, _jwt, *, body):
            self.assertEqual(path, "/app/installations/10/access_tokens")
            self.assertEqual(body, {"repository_ids": [123456], "permissions": {"issues": "write"}})
            return {"token": "synthetic-token", "expires_at": expiry, "permissions": remote_permissions,
                    "repositories": [{"id": 123456}]}, None

        def provider():
            return AppToken(9, 10, 123456, pem, transport=mint, clock=lambda: now, purpose="runtime_alert")

        self.assertEqual(provider()(), "synthetic-token")
        remote_permissions["contents"] = "read"
        with self.assertRaisesRegex(ValueError, "Unexpected App token permissions"):
            provider()()
