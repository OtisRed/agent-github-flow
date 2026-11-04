import os
import hashlib
import hmac
import json
import select
import signal
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import worker_ledger
import webhook_ingress as ingress

TEST_COMMITMENT = {"kind":"worker-status-commitment", "keyId":1, "mac":"a" * 64}


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
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
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
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
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
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True):
            pass
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE unrelated (x)")
        with self.assertRaises(ValueError):
            with worker_ledger.Ledger(self.path, self.lock_path):
                self.fail("tampered schema accepted")

    def test_crash_before_initial_publish_does_not_leave_empty_target(self):
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = ("import os,sys; sys.path.insert(0,sys.argv[1]); import worker_ledger; "
                  "worker_ledger.os.link=lambda *args,**kwargs: os._exit(73); "
                  "worker_ledger.Ledger(sys.argv[2],sys.argv[3],allow_create=True).__enter__()")
        process = subprocess.run([sys.executable, "-c", script, src, str(self.path), str(self.lock_path)],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 73, process.stderr)
        self.assertFalse(self.path.exists())
        self.assertTrue(list(Path(self.directory.name).glob(".agf-ledger-init-*")))
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first])
            self.assertEqual(work.pending_preview(), [self.first])

    def test_crash_after_link_keeps_readable_target_in_process_failure(self):
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = ("import os,stat,sys; sys.path.insert(0,sys.argv[1]); import worker_ledger; "
                  "old=os.fsync; worker_ledger.os.fsync=lambda fd: os._exit(73) if stat.S_ISDIR(os.fstat(fd).st_mode) else old(fd); "
                  "worker_ledger.Ledger(sys.argv[2],sys.argv[3],allow_create=True).__enter__()")
        process = subprocess.run([sys.executable, "-c", script, src, str(self.path), str(self.lock_path)],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 73, process.stderr)
        self.assertTrue(self.path.exists())
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.pending_preview(), [])

    def test_crash_after_directory_sync_keeps_readable_target(self):
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = ("import os,sys; sys.path.insert(0,sys.argv[1]); import worker_ledger; "
                  "worker_ledger.os.unlink=lambda *args,**kwargs: os._exit(73); "
                  "worker_ledger.Ledger(sys.argv[2],sys.argv[3],allow_create=True).__enter__()")
        process = subprocess.run([sys.executable, "-c", script, src, str(self.path), str(self.lock_path)],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 73, process.stderr)
        self.assertTrue(self.path.exists())
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.pending_preview(), [])

    def test_missing_target_with_orphan_sidecar_is_not_initialized(self):
        orphan = Path(str(self.path) + "-journal")
        orphan.write_bytes(b"synthetic orphan")
        orphan.chmod(0o600)
        with self.assertRaises(ValueError):
            with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True):
                self.fail("orphan sidecar accepted")
        self.assertFalse(self.path.exists())
        self.assertEqual(orphan.read_bytes(), b"synthetic orphan")

    def test_missing_established_ledger_fails_closed_without_bootstrap(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first])
            self.assertEqual(work.claim_next(), {"kind": "claimed", "deliveryId": self.first})
        self.path.unlink()
        with self.assertRaises(FileNotFoundError):
            with worker_ledger.Ledger(self.path, self.lock_path):
                self.fail("missing ledger silently recreated")
        self.assertFalse(self.path.exists())

    def test_replaced_lock_is_detected_before_further_work(self):
        lock = self.lock_path
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            lock.unlink()
            lock.touch(mode=0o600)
            with self.assertRaises(ValueError):
                work.import_ids([self.first])

    def test_claim_is_durable_and_process_death_never_silently_requeues(self):
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = ("import os,sys; sys.path.insert(0,sys.argv[1]); import worker_ledger; "
                  "w=worker_ledger.Ledger(sys.argv[2],sys.argv[3],allow_create=True); w.__enter__(); "
                  "w.import_ids([sys.argv[4]]); assert w.claim_next()['kind']=='claimed'; os._exit(0)")
        process = subprocess.run([sys.executable, "-c", script, src, str(self.path), str(self.lock_path), self.first],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.states_preview(), [(self.first, "uncertain", 0, 0)])
            work.import_ids([self.first, self.second])
            self.assertEqual(work.states_preview(), [(self.first, "uncertain", 0, 0), (self.second, "pending", 0, 0)])
            self.assertEqual(work.claim_next(), {"kind": "blocked"})

    def test_blocking_preview_finds_uncertain_after_many_earlier_pending(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.second])
            self.assertEqual(work.claim_next(), {"kind": "claimed", "deliveryId": self.second})
            earlier = [f"00000000-0000-4000-8000-{number:012x}" for number in range(100)]
            work.import_ids(earlier)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(len(work.states_preview()), 100)
            self.assertEqual(work.blocking_preview(), [(self.second, "uncertain", 0, 0)])
            self.assertEqual(work.claim_next(), {"kind": "blocked"})

    def test_interrupted_ref_and_status_intents_remain_distinct_and_blocked(self):
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = ("import os,sys; sys.path.insert(0,sys.argv[1]); import worker_ledger; "
                  "w=worker_ledger.Ledger(sys.argv[2],sys.argv[3],allow_create=True); w.__enter__(); "
                  "c={'kind':'worker-status-commitment','keyId':1,'mac':'a'*64}; "
                  "w.import_ids([sys.argv[4]]); w.claim_next(); w.record_intent(sys.argv[4],sys.argv[5],c if sys.argv[5]=='status' else None); os._exit(73)")
        for operation in ("ref", "status"):
            with self.subTest(operation=operation):
                path = Path(self.directory.name) / (operation + ".sqlite")
                process = subprocess.run([sys.executable, "-c", script, src, str(path), str(self.lock_path), self.first, operation],
                                         capture_output=True, text=True)
                self.assertEqual(process.returncode, 73, process.stderr)
                with worker_ledger.Ledger(path, self.lock_path) as work:
                    flags = (1, 0) if operation == "ref" else (0, 1)
                    self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", *flags)])
                    work.import_ids([self.first])
                    self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", *flags)])
                    self.assertEqual(work.claim_next(), {"kind": "blocked"})
                    with self.assertRaises(ValueError):
                        work.record_intent(self.first, operation, TEST_COMMITMENT if operation == 'status' else None)

    def test_intent_requires_valid_operation_and_running_claim(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first])
            for delivery, operation in ((self.first, "status"), (self.second, "ref"), (self.first, "other")):
                with self.assertRaises(ValueError):
                    work.record_intent(delivery, operation, TEST_COMMITMENT if operation == 'status' else None)
            self.assertEqual(work.claim_next(), {"kind": "claimed", "deliveryId": self.first})
            work.record_intent(self.first, "ref")
            work.import_ids([self.first])
            self.assertEqual(work.blocking_preview(), [(self.first, "running", 1, 0)])

    def test_schema_refuses_two_active_or_uncertain_entries(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first, self.second])
            self.assertEqual(work.claim_next(), {"kind": "claimed", "deliveryId": self.first})
            with sqlite3.connect(self.path) as db:
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("UPDATE pending_deliveries SET state='uncertain' WHERE delivery_id=?", (self.second,))
            self.assertEqual(work.blocking_preview(), [(self.first, "running", 0, 0)])

    def test_schema_rejects_status_intent_without_complete_commitment(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first])
            work.claim_next()
            with sqlite3.connect(self.path) as db:
                for key_id, mac in ((None, "a"*64), (1, None), (1, "z"*64), (2**53, "a"*64)):
                    with self.assertRaises(sqlite3.IntegrityError):
                        db.execute("""UPDATE pending_deliveries SET status_intent=1,status_key_id=?,status_mac=?
                                      WHERE delivery_id=?""", (key_id, mac, self.first))
                    db.rollback()
            self.assertEqual(work.blocking_preview(), [(self.first, "running", 0, 0)])

    def test_two_uncertain_intents_are_preserved_together_after_process_death(self):
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = ("import os,sys; sys.path.insert(0,sys.argv[1]); import worker_ledger; "
                  "w=worker_ledger.Ledger(sys.argv[2],sys.argv[3],allow_create=True); w.__enter__(); "
                  "c={'kind':'worker-status-commitment','keyId':1,'mac':'a'*64}; "
                  "w.import_ids([sys.argv[4]]); w.claim_next(); w.record_intent(sys.argv[4],sys.argv[5],c if sys.argv[5]=='status' else None); "
                  "w.record_intent(sys.argv[4],sys.argv[6],c if sys.argv[6]=='status' else None); os._exit(73)")
        for first, second in (("ref", "status"), ("status", "ref")):
            with self.subTest(first=first):
                path = Path(self.directory.name) / (first + "-both.sqlite")
                process = subprocess.run([sys.executable, "-c", script, src, str(path), str(self.lock_path),
                                          self.first, first, second], capture_output=True, text=True)
                self.assertEqual(process.returncode, 73, process.stderr)
                with worker_ledger.Ledger(path, self.lock_path) as work:
                    self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", 1, 1)])
                    work.import_ids([self.first])
                    self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", 1, 1)])
                    self.assertEqual(work.claim_next(), {"kind": "blocked"})

    def test_status_recovery_reserves_inspection_but_not_generic_intent(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first])
            work.claim_next()
            work.record_intent(self.first, "status", TEST_COMMITMENT)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            work.begin_status_recovery(self.first, TEST_COMMITMENT)
            self.assertEqual(work.blocking_preview(), [(self.first, "recovering", 0, 1)])
            self.assertEqual(work.claim_next(), {"kind": "blocked"})
            with self.assertRaises(ValueError):
                work.record_intent(self.first, "ref")
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", 0, 1)])

    def test_status_recovery_rejects_uncertain_ref_or_missing_status_intent(self):
        for flags in ((), ("ref",), ("ref", "status")):
            with self.subTest(flags=flags):
                path = Path(self.directory.name) / ("refusal-" + "-".join(flags) + ".sqlite")
                with worker_ledger.Ledger(path, self.lock_path, allow_create=True) as work:
                    work.import_ids([self.first])
                    work.claim_next()
                    for operation in flags:
                        work.record_intent(self.first, operation, TEST_COMMITMENT if operation == 'status' else None)
                with worker_ledger.Ledger(path, self.lock_path) as work:
                    with self.assertRaises(ValueError):
                        work.begin_status_recovery(self.first, TEST_COMMITMENT)
                    self.assertEqual(work.claim_next(), {"kind": "blocked"})

    def test_changed_binding_or_historical_key_cannot_begin_recovery(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first])
            work.claim_next()
            with self.assertRaises(ValueError):
                work.record_intent(self.first, "status")
            work.record_intent(self.first, "status", TEST_COMMITMENT)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.status_key_id(self.first), 1)
            for bad in ({**TEST_COMMITMENT, "mac":"b" * 64}, {**TEST_COMMITMENT, "keyId":2},
                        {**TEST_COMMITMENT, "keyId":True}):
                with self.assertRaises(ValueError):
                    work.begin_status_recovery(self.first, bad)
                self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", 0, 1)])
            work.begin_status_recovery(self.first, TEST_COMMITMENT)
            self.assertEqual(work.blocking_preview(), [(self.first, "recovering", 0, 1)])

    def test_process_death_during_recovery_keeps_status_uncertain(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first])
            work.claim_next()
            work.record_intent(self.first, "status", TEST_COMMITMENT)
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = ("import os,sys; sys.path.insert(0,sys.argv[1]); import worker_ledger; "
                  "w=worker_ledger.Ledger(sys.argv[2],sys.argv[3]); w.__enter__(); "
                  "c={'kind':'worker-status-commitment','keyId':1,'mac':'a'*64}; w.begin_status_recovery(sys.argv[4],c); os._exit(73)")
        process = subprocess.run([sys.executable, "-c", script, src, str(self.path), str(self.lock_path), self.first],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 73, process.stderr)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", 0, 1)])
            self.assertEqual(work.claim_next(), {"kind": "blocked"})

    def test_interrupted_recovery_ref_preserves_both_uncertainties(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first])
            work.claim_next()
            work.record_intent(self.first, "status", TEST_COMMITMENT)
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = ("import os,sys; sys.path.insert(0,sys.argv[1]); import worker_ledger; "
                  "w=worker_ledger.Ledger(sys.argv[2],sys.argv[3]); w.__enter__(); "
                  "c={'kind':'worker-status-commitment','keyId':1,'mac':'a'*64}; w.begin_status_recovery(sys.argv[4],c); w.record_recovery_ref_intent(sys.argv[4]); os._exit(73)")
        process = subprocess.run([sys.executable, "-c", script, src, str(self.path), str(self.lock_path), self.first],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 73, process.stderr)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", 1, 1)])
            self.assertEqual(work.status_key_id(self.first), 1)
            with sqlite3.connect(self.path) as db:
                stored = db.execute("SELECT status_mac FROM pending_deliveries WHERE delivery_id=?", (self.first,)).fetchone()
            self.assertEqual(stored[0], TEST_COMMITMENT["mac"])
            with self.assertRaises(ValueError):
                work.begin_status_recovery(self.first, TEST_COMMITMENT)
            self.assertEqual(work.claim_next(), {"kind": "blocked"})

    @unittest.skipUnless(os.environ.get("AGF_CONTROLLER_ROOT") and os.environ.get("AGF_NODE"),
                         "Actual controller checkout and Node not supplied")
    def test_status_recovery_observes_real_v3_cycle_without_mutation(self):
        queue = Path(self.directory.name) / "ingress.sqlite"
        key = b"synthetic-fingerprint-key-for-the-tests-only"
        secret = b"synthetic-webhook-secret-for-the-tests-only"
        ingress.initialize(queue, key)
        registry = ingress.validate_registry([(101, 201)])
        body = json.dumps({"action":"created", "installation":{"id":101}, "repository":{"id":201},
                           "issue":{"number":1}, "comment":{"id":77}}).encode()
        signature = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
        self.assertEqual(ingress.receive(queue, secret, key, registry, self.first, "issue_comment", signature, body), "accepted")
        delivery = ingress.read_delivery(queue, key, self.first)
        script = Path(__file__).with_name("recovery-cycle-integration.mjs")
        fixture = subprocess.run([os.environ["AGF_NODE"], str(script)], input=json.dumps({"mode":"commitment","delivery":delivery}),
                                 text=True, capture_output=True, timeout=30,
                                 env={"AGF_CONTROLLER_ROOT": os.environ["AGF_CONTROLLER_ROOT"]})
        self.assertEqual(fixture.returncode, 0, fixture.stderr)
        commitment = json.loads(fixture.stdout)
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_page(queue, key)
            work.claim_next()
            work.record_intent(self.first, "status", commitment)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            delivery = ingress.read_delivery(queue, key, self.first)
            self.assertEqual(delivery["kind"], "delivery")
            different = subprocess.run([os.environ["AGF_NODE"], str(script)],
                                       input=json.dumps({"mode":"commitment","delivery":delivery,"targetOptionId":"other-option"}),
                                       text=True, capture_output=True, timeout=30,
                                       env={"AGF_CONTROLLER_ROOT": os.environ["AGF_CONTROLLER_ROOT"]})
            self.assertEqual(different.returncode, 0, different.stderr)
            with self.assertRaises(ValueError):
                work.begin_status_recovery(self.first, json.loads(different.stdout))
            self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", 0, 1)])
            fresh = subprocess.run([os.environ["AGF_NODE"], str(script)], input=json.dumps({"mode":"commitment","delivery":delivery}),
                                   text=True, capture_output=True, timeout=30,
                                   env={"AGF_CONTROLLER_ROOT": os.environ["AGF_CONTROLLER_ROOT"]})
            self.assertEqual(fresh.returncode, 0, fresh.stderr)
            commitment = json.loads(fresh.stdout)
            work.begin_status_recovery(self.first, commitment)
            row = work.blocking_preview()[0]
            state = {"deliveryId": row[0], "kind": row[1], "refIntent": row[2], "statusIntent": row[3]}
            self.assertEqual(ingress.read_delivery(queue, key, row[0]), delivery)
            process = subprocess.run([os.environ["AGF_NODE"], str(script)], input=json.dumps({"state":state,"delivery":delivery,"commitment":commitment}), text=True,
                                     capture_output=True, timeout=30,
                                     env={"AGF_CONTROLLER_ROOT": os.environ["AGF_CONTROLLER_ROOT"]})
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(process.stdout.strip(), "synthetic real-v3 recovery observation passed")
            self.assertEqual(work.blocking_preview(), [(self.first, "recovering", 0, 1)])
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", 0, 1)])

    def test_killed_lock_owner_releases_lock_without_requeuing_claim(self):
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = ("import sys,time; sys.path.insert(0,sys.argv[1]); import worker_ledger; "
                  "w=worker_ledger.Ledger(sys.argv[2],sys.argv[3],allow_create=True); w.__enter__(); "
                  "w.import_ids([sys.argv[4]]); assert w.claim_next()['kind']=='claimed'; "
                  "print('ready',flush=True); time.sleep(300)")
        process = subprocess.Popen([sys.executable, "-c", script, src, str(self.path), str(self.lock_path), self.first],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(select.select([process.stdout], [], [], 10)[0], "worker did not start")
            self.assertEqual(process.stdout.readline().strip(), "ready")
            process.kill()
            process.communicate(timeout=5)
            self.assertEqual(process.returncode, -signal.SIGKILL)
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", 0, 0)])
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
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
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
