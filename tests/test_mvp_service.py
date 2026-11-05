import hashlib
import hmac
import http.client
import importlib.util
import json
import os
import select
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


@unittest.skipUnless(os.name == "posix" and importlib.util.find_spec("cryptography"), "POSIX and cryptography required")
class ServiceTests(unittest.TestCase):
    def test_migration_requires_stopped_service_lock(self):
        from mvp_service import _lock, initialize, migrate_v1
        from mvp_store import Store
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state.sqlite'
            config = {'state_path': str(state)}
            initialize(config)
            Store(state).enqueue(20, 7)
            with sqlite3.connect(state) as db:
                db.execute('DROP TABLE work_queue')
                db.execute('PRAGMA user_version=1')
            fd = _lock(str(state) + '.lock')
            try:
                with self.assertRaises(BlockingIOError):
                    migrate_v1(config)
                with sqlite3.connect(state) as db:
                    self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            finally:
                os.close(fd)
            migrate_v1(config)
            self.assertEqual(Store(state).next_pending()['issue_number'], 7)

    def test_private_service_single_owner_restart_and_signed_ping(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from mvp_service import initialize
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            sock.close()
            key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
            secret = b"synthetic-service-webhook-secret-value"
            for name, value in (("webhook", secret), ("pat", b"synthetic-project-token"), ("app.pem", pem)):
                path = root / name
                path.write_bytes(value)
                path.chmod(0o600)
            config = {"app_id": 9, "installation_id": 10, "port": port, "state_path": str(root / "state.sqlite"),
                      "webhook_secret_path": str(root / "webhook"), "project_token_path": str(root / "pat"),
                      "app_key_path": str(root / "app.pem"),
                      "projects": [{"repository_id": 20, "owner": "Owner", "repository": "Project",
                                    "project_owner": "Owner", "project_number": 3,
                                    "enrolled_at": "2026-11-01T00:00:00Z", "trusted_author_ids": [10]}]}
            initialize(config)
            config_path = root / "config.json"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            config_path.chmod(0o600)
            # Keep this test completely offline: the production service has
            # no test switch, and the synthetic client scans no remote repos.
            script = ("import sys; sys.path.insert(0, " + repr(str(ROOT / "src")) + "); "
                      "import mvp_service; mvp_service.GitHub.reconciliation_candidates=lambda *a: []; "
                      "mvp_service.main()")
            command = [sys.executable, "-c", script, "run", str(config_path)]
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 10
                connected = False
                while time.monotonic() < deadline and process.poll() is None:
                    try:
                        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                        signature = "sha256=" + hmac.new(secret, b"{}", hashlib.sha256).hexdigest()
                        connection.request("POST", "/agent-github-flow/webhook", body=b"{}",
                                           headers={"X-GitHub-Event": "ping", "X-Hub-Signature-256": signature})
                        response = connection.getresponse()
                        connected = response.status == 204
                        response.read()
                        connection.close()
                        break
                    except OSError:
                        time.sleep(0.1)
                self.assertTrue(connected, "service did not start")
                self.assertTrue(select.select([process.stdout], [], [], 10)[0], "startup reconciliation not logged")
                self.assertEqual(process.stdout.readline().strip(), b"FLOW scan: startup candidates queued")
                duplicate = subprocess.run(command, capture_output=True, timeout=10)
                self.assertNotEqual(duplicate.returncode, 0)
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0)
            self.assertNotIn(secret, stdout + stderr)
            restarted = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                time.sleep(0.5)
                self.assertIsNone(restarted.poll())
            finally:
                if restarted.poll() is None:
                    restarted.send_signal(signal.SIGTERM)
                restarted.communicate(timeout=10)
