import os
import hashlib
import hmac
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import worker_ledger
import webhook_ingress as ingress


@unittest.skipUnless(os.name == "posix", "Worker lock requires POSIX")
class WorkerLedgerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="agf-worker-test-")
        self.path = Path(self.directory.name) / "work.sqlite"
        self.lock_path = Path(self.directory.name) / "controller.lock"
        self.first = "10000000-0000-4000-8000-000000000000"
        self.second = "f0000000-0000-4000-8000-000000000000"

    def tearDown(self):
        self.directory.cleanup()

    def test_import_is_idempotent_and_survives_reopen(self):
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            work.import_ids([self.second, self.first])
            work.import_ids([self.first])
            self.assertEqual(work.pending_preview(), [self.first, self.second])
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.pending_preview(), [self.first, self.second])
            with self.assertRaises(ValueError):
                work.import_ids(["invalid"])
            self.assertEqual(work.pending_preview(), [self.first, self.second])

    def test_lock_excludes_second_process_and_releases_after_exit(self):
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = ("import sys; sys.path.insert(0,sys.argv[1]); import worker_ledger; "
                  "w=worker_ledger.Ledger(sys.argv[2],sys.argv[3]); "
                  "w.__enter__(); w.__exit__(None,None,None)")
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            with self.assertRaises(RuntimeError):
                work.__enter__()
            process = subprocess.run([sys.executable, "-c", script, src, str(self.path), str(self.lock_path)], capture_output=True, text=True)
            self.assertNotEqual(process.returncode, 0)
            self.assertIn("Busy", process.stderr)
            other = Path(self.directory.name) / "other-work.sqlite"
            process = subprocess.run([sys.executable, "-c", script, src, str(other), str(self.lock_path)], capture_output=True, text=True)
            self.assertNotEqual(process.returncode, 0)
            self.assertIn("Busy", process.stderr)
            self.assertFalse(other.exists())
        process = subprocess.run([sys.executable, "-c", script, src, str(self.path), str(self.lock_path)], capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stderr)

    def test_unknown_or_tampered_database_is_not_accepted(self):
        with worker_ledger.Ledger(self.path, self.lock_path):
            pass
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE unrelated (x)")
        with self.assertRaises(ValueError):
            with worker_ledger.Ledger(self.path, self.lock_path):
                self.fail("tampered schema accepted")

    def test_replaced_lock_is_detected_before_further_work(self):
        lock = self.lock_path
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            lock.unlink()
            lock.touch(mode=0o600)
            with self.assertRaises(ValueError):
                work.import_ids([self.first])

    def test_claim_is_durable_and_process_death_never_silently_requeues(self):
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = ("import os,sys; sys.path.insert(0,sys.argv[1]); import worker_ledger; "
                  "w=worker_ledger.Ledger(sys.argv[2],sys.argv[3]); w.__enter__(); "
                  "w.import_ids([sys.argv[4]]); assert w.claim_next()['kind']=='claimed'; os._exit(0)")
        process = subprocess.run([sys.executable, "-c", script, src, str(self.path), str(self.lock_path), self.first],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.states_preview(), [(self.first, "uncertain")])
            work.import_ids([self.first, self.second])
            self.assertEqual(work.states_preview(), [(self.first, "uncertain"), (self.second, "pending")])
            self.assertEqual(work.claim_next(), {"kind": "blocked"})

    def test_blocking_preview_finds_uncertain_after_many_earlier_pending(self):
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            work.import_ids([self.second])
            self.assertEqual(work.claim_next(), {"kind": "claimed", "deliveryId": self.second})
            earlier = [f"00000000-0000-4000-8000-{number:012x}" for number in range(100)]
            work.import_ids(earlier)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(len(work.states_preview()), 100)
            self.assertEqual(work.blocking_preview(), [(self.second, "uncertain")])
            self.assertEqual(work.claim_next(), {"kind": "blocked"})

    def test_scan_import_restarts_after_uncommitted_read_and_finds_earlier_id(self):
        queue = Path(self.directory.name) / "ingress.sqlite"
        key = b"synthetic-fingerprint-key-for-the-tests-only"
        secret = b"synthetic-webhook-secret-for-the-tests-only"
        ingress.initialize(queue, key)
        registry = ingress.validate_registry([(11, 22)])
        body = json.dumps({"action": "created", "installation": {"id": 11}, "repository": {"id": 22},
                           "issue": {"number": 8}, "comment": {"id": 77}}).encode()
        signature = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
        self.assertEqual(ingress.receive(queue, secret, key, registry, self.second, "issue_comment", signature, body), "accepted")
        # A process can read a page and exit before importing it: source persists.
        self.assertEqual(ingress.scan_delivery_ids(queue, key, limit=1)["deliveryIds"], [self.second])
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.import_page(queue, key, limit=1)["nextAfter"], self.second)
            self.assertEqual(ingress.receive(queue, secret, key, registry, self.first, "issue_comment", signature, body), "accepted")
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.import_page(queue, key, limit=1)["nextAfter"], self.first)
            work.import_page(queue, key, after=self.first, limit=1)
            self.assertEqual(work.pending_preview(), [self.first, self.second])
            self.assertEqual(work.import_page(queue, b"wrong-key-" * 4), {"kind": "blocked"})
            self.assertEqual(work.pending_preview(), [self.first, self.second])


if __name__ == "__main__":
    unittest.main()
