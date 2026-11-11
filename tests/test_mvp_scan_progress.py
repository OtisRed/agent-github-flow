import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


@unittest.skipUnless(os.name == "posix" and importlib.util.find_spec("cryptography"), "POSIX and cryptography required")
class ScanProgressTests(unittest.TestCase):
    def test_existing_and_new_work_progress_during_collection_and_after_restart(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from mvp_service import initialize
        from mvp_store import Store

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            sock.close()
            key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption())
            for name, value in (("webhook", b"synthetic-webhook-secret"), ("pat", b"synthetic-token"), ("app.pem", pem)):
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
            path = root / "config.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            path.chmod(0o600)
            started, release, processed = (root / name for name in ("started", "release", "processed"))
            script = '''
import sys,time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import mvp_service
started, release, processed = map(Path, sys.argv[2:5])
def scan(*args):
    started.touch()
    deadline=time.monotonic()+15
    while not release.exists() and time.monotonic()<deadline: time.sleep(.05)
    if not release.exists(): raise RuntimeError('scan timeout')
    return []
def process(store, client, *, row, **kwargs):
    with processed.open('a') as f: f.write(str(row['issue_number'])+'\\n')
    store.complete(row['repository_id'], row['issue_number'], row['generation'])
    return {'kind':'completed'}
mvp_service.GitHub.reconciliation_candidates=scan
mvp_service.process_one=process
sys.argv=['mvp_service','run',sys.argv[5]]
mvp_service.main()
'''
            command = [sys.executable, "-c", script, str(ROOT / "src"), str(started), str(release),
                       str(processed), str(path)]
            store = Store(root / "state.sqlite")

            def wait_for(predicate, seconds=5):
                until = time.monotonic() + seconds
                while time.monotonic() < until:
                    if predicate():
                        return True
                    time.sleep(.05)
                return False

            def observed(number):
                return processed.exists() and str(number) in processed.read_text().splitlines()

            for first, second in ((1, 2), (3, 4)):
                started.unlink(missing_ok=True)
                release.unlink(missing_ok=True)
                store.enqueue(20, first)
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    self.assertTrue(wait_for(started.exists), "scan did not start")
                    self.assertTrue(wait_for(lambda: observed(first)), "existing work blocked by collection")
                    store.enqueue(20, second)
                    self.assertTrue(wait_for(lambda: observed(second)), "new work blocked by collection")
                    self.assertFalse(release.exists(), "work must progress before collection is released")
                finally:
                    release.touch()
                    if process.poll() is None:
                        process.send_signal(signal.SIGTERM)
                    process.communicate(timeout=20)


if __name__ == "__main__":
    unittest.main()
