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
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import worker_ledger
import webhook_ingress as ingress

TEST_COMMITMENT = {"kind":"worker-status-commitment", "keyId":1, "mac":"a" * 64}


def synthetic_transition(delivery_id):
    return {"kind":"worker-ref-transition", "operation":"reservation", "deliveryId":delivery_id, "keyId":1,
            "oldMac":"a"*64, "nextMac":"b"*64, "oldOid":"c"*40, "newOid":"d"*40,
            "treeOid":"e"*40, "reservedAt":"2026-01-01T10:03:00Z", "mac":"f"*64}


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

    def test_verified_noop_stays_finished_after_rescan_and_restart(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first, self.second])
            self.assertEqual(work.claim_next(), {"kind": "claimed", "deliveryId": self.first})
            work._record_verified_noop(self.first)
            work.import_ids([self.first])
            self.assertEqual(work.claim_next(), {"kind": "claimed", "deliveryId": self.second})
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.states_preview(), [(self.first, "completed", 0, 0), (self.second, "uncertain", 0, 0)])
            self.assertEqual(work.blocking_preview(), [(self.second, "uncertain", 0, 0)])
            work.import_ids([self.first])
            self.assertEqual(work.pending_preview(), [])

    def test_noop_completion_refuses_pending_uncertain_and_intent(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first, self.second])
            with self.assertRaises(ValueError):
                work._record_verified_noop(self.first)
            work.claim_next()
            work.record_intent(self.first, "ref")
            with self.assertRaises(ValueError):
                work._record_verified_noop(self.first)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            with self.assertRaises(ValueError):
                work._record_verified_noop(self.first)
            self.assertEqual(work.claim_next(), {"kind": "blocked"})

    def test_noop_process_death_before_and_after_commit(self):
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = """import os,sys
sys.path.insert(0,sys.argv[1])
import worker_ledger
w=worker_ledger.Ledger(sys.argv[2],sys.argv[3],allow_create=True); w.__enter__()
w.import_ids([sys.argv[4]]); w.claim_next()
if sys.argv[5]=='before':
    class KillAfterUpdate:
        def __init__(self,db): self.db=db
        def execute(self,sql,*args):
            result=self.db.execute(sql,*args)
            if sql.strip().startswith("UPDATE pending_deliveries SET state='completed'"): os._exit(73)
            return result
        def __getattr__(self,name): return getattr(self.db,name)
    w.db=KillAfterUpdate(w.db)
w._record_verified_noop(sys.argv[4])
os._exit(73)
"""
        for mode in ("before", "after"):
            with self.subTest(mode=mode):
                path = Path(self.directory.name) / (mode + "-noop.sqlite")
                process = subprocess.run([sys.executable, "-c", script, src, str(path), str(self.lock_path), self.first, mode],
                                         capture_output=True, text=True)
                self.assertEqual(process.returncode, 73, process.stderr)
                with worker_ledger.Ledger(path, self.lock_path) as work:
                    expected = "uncertain" if mode == "before" else "completed"
                    self.assertEqual(work.states_preview(), [(self.first, expected, 0, 0)])
                    work.import_ids([self.first])
                    self.assertEqual(work.pending_preview(), [])
                    self.assertEqual(work.claim_next(), {"kind": "blocked" if mode == "before" else "empty"})
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

    def test_recovery_ref_intent_requires_matching_old_commitment_and_plan(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first])
            work.claim_next()
            work.record_intent(self.first, "status", TEST_COMMITMENT)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            work.begin_status_recovery(self.first, TEST_COMMITMENT)
            plan = synthetic_transition(self.first)
            for changed in ({**plan, "oldMac":"1"*64}, {**plan, "keyId":2},
                            {**plan, "deliveryId":self.second}, {**plan, "newOid":plan["oldOid"]},
                            {**plan, "reservedAt":"2026-99-99T99:99:99Z"}, {**plan, "reservedAt":"0000-01-01T00:00:00Z"},
                            {**plan, "operation":"commit"}):
                with self.assertRaises(ValueError):
                    work.record_recovery_ref_intent(self.first, changed)
                self.assertEqual(work.blocking_preview(), [(self.first, "recovering", 0, 1)])
            work.record_recovery_ref_intent(self.first, plan)
            self.assertEqual(work.recovery_ref_transition(self.first), plan)
            self.assertEqual(work.blocking_preview(), [(self.first, "recovering", 1, 1)])

    def test_internal_ref_plan_update_retains_status_uncertainty(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first])
            work.claim_next()
            work.record_intent(self.first, "status", TEST_COMMITMENT)
        plan = synthetic_transition(self.first)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            work.begin_status_recovery(self.first, TEST_COMMITMENT)
            work.record_recovery_ref_intent(self.first, plan)
            for wrong in ({**plan, "treeOid":"1"*40}, {**plan, "nextMac":"1"*64}, {**plan, "mac":"1"*64}):
                with self.assertRaises(ValueError):
                    work._record_verified_recovery_ref(self.first, wrong)
                self.assertEqual(work.blocking_preview(), [(self.first, "recovering", 1, 1)])
            work._record_verified_recovery_ref(self.first, plan)
            self.assertEqual(work.blocking_preview(), [(self.first, "recovering", 0, 1)])
            self.assertIsNone(work.recovery_ref_transition(self.first))
            with self.assertRaises(ValueError):
                work._record_verified_recovery_ref(self.first, plan)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", 0, 1)])
            with self.assertRaises(ValueError):
                work.begin_status_recovery(self.first, TEST_COMMITMENT)
            next_commitment = {**TEST_COMMITMENT, "mac":plan["nextMac"]}
            work.begin_status_recovery(self.first, next_commitment)

    def test_process_death_before_and_after_ref_update_commit(self):
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = """import json,os,sys
sys.path.insert(0,sys.argv[1])
import worker_ledger
p,lock,delivery,plan,mode=sys.argv[2],sys.argv[3],sys.argv[4],json.loads(sys.argv[5]),sys.argv[6]
c={'kind':'worker-status-commitment','keyId':1,'mac':'a'*64}
with worker_ledger.Ledger(p,lock,allow_create=True) as w:
    w.import_ids([delivery]); w.claim_next(); w.record_intent(delivery,'status',c)
w=worker_ledger.Ledger(p,lock); w.__enter__()
w.begin_status_recovery(delivery,c); w.record_recovery_ref_intent(delivery,plan)
if mode=='before':
    class KillAfterUpdate:
        def __init__(self, db): self.db=db
        def execute(self, sql, *args):
            result=self.db.execute(sql,*args)
            if sql.strip().startswith('UPDATE pending_deliveries SET status_mac='): os._exit(73)
            return result
        def __getattr__(self, name): return getattr(self.db,name)
    w.db=KillAfterUpdate(w.db)
w._record_verified_recovery_ref(delivery,plan)
os._exit(73)
"""
        for mode in ("before", "after"):
            with self.subTest(mode=mode):
                path = Path(self.directory.name) / (mode + "-update.sqlite")
                plan = synthetic_transition(self.first)
                process = subprocess.run([sys.executable, "-c", script, src, str(path), str(self.lock_path),
                                          self.first, json.dumps(plan), mode], capture_output=True, text=True, timeout=30)
                self.assertEqual(process.returncode, 73, process.stderr)
                with worker_ledger.Ledger(path, self.lock_path) as work:
                    expected_ref = 1 if mode == "before" else 0
                    self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", expected_ref, 1)])
                    if mode == "before":
                        self.assertEqual(work.recovery_ref_transition(self.first), plan)
                    else:
                        self.assertIsNone(work.recovery_ref_transition(self.first))
                        work.begin_status_recovery(self.first, {**TEST_COMMITMENT, "mac":plan["nextMac"]})

    def test_interrupted_recovery_ref_preserves_both_uncertainties(self):
        with worker_ledger.Ledger(self.path, self.lock_path, allow_create=True) as work:
            work.import_ids([self.first])
            work.claim_next()
            work.record_intent(self.first, "status", TEST_COMMITMENT)
        src = str(Path(__file__).resolve().parents[1] / "src")
        script = ("import json,os,sys; sys.path.insert(0,sys.argv[1]); import worker_ledger; "
                  "w=worker_ledger.Ledger(sys.argv[2],sys.argv[3]); w.__enter__(); "
                  "c={'kind':'worker-status-commitment','keyId':1,'mac':'a'*64}; w.begin_status_recovery(sys.argv[4],c); "
                  "w.record_recovery_ref_intent(sys.argv[4],json.loads(sys.argv[5])); os._exit(73)")
        process = subprocess.run([sys.executable, "-c", script, src, str(self.path), str(self.lock_path), self.first,
                                  json.dumps(synthetic_transition(self.first))],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 73, process.stderr)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", 1, 1)])
            self.assertEqual(work.status_key_id(self.first), 1)
            with sqlite3.connect(self.path) as db:
                stored = db.execute("SELECT status_mac FROM pending_deliveries WHERE delivery_id=?", (self.first,)).fetchone()
            self.assertEqual(stored[0], TEST_COMMITMENT["mac"])
            self.assertEqual(work.recovery_ref_transition(self.first), synthetic_transition(self.first))
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
            request_read, request_write = os.pipe()
            reply_read, reply_write = os.pipe()
            env = {"AGF_CONTROLLER_ROOT":os.environ["AGF_CONTROLLER_ROOT"],
                   "AGF_TEST_REQUEST_FD":str(request_write), "AGF_TEST_REPLY_FD":str(reply_read)}
            child = subprocess.Popen([os.environ["AGF_NODE"], str(script)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     pass_fds=(request_write, reply_read), env=env)
            os.close(request_write)
            os.close(reply_read)
            actions = []
            transition = None
            try:
                child.stdin.write(json.dumps({"mode":"guarded-ipc", "state":state, "delivery":delivery,
                                              "commitment":commitment}).encode())
                child.stdin.close()
                child.stdin = None
                pending = b""
                deadline = time.monotonic() + 30
                while True:
                    ready, _, _ = select.select([request_read], [], [], max(0, deadline - time.monotonic()))
                    if not ready:
                        self.fail("synthetic journal IPC timed out")
                    chunk = os.read(request_read, 8192)
                    if not chunk:
                        break
                    pending += chunk
                    if len(pending) > 16384:
                        self.fail("synthetic journal IPC message too large")
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        request = json.loads(line)
                        self.assertEqual(request["id"], self.first)
                        actions.append(request["operation"])
                        if request["operation"] == "record":
                            transition = request["transition"]
                            work.record_recovery_ref_intent(self.first, transition)
                            response = {"kind":"recorded"}
                        elif request["operation"] == "read":
                            response = work.recovery_ref_transition(self.first)
                        elif request["operation"] == "confirm":
                            work._record_verified_recovery_ref(self.first, request["transition"])
                            response = {"kind":"confirmed"}
                        else:
                            self.fail("unexpected synthetic journal request")
                        os.write(reply_write, (json.dumps(response) + "\n").encode())
                self.assertFalse(pending)
                stdout, stderr = child.communicate(timeout=5)
                self.assertEqual(child.returncode, 0, stderr.decode())
                self.assertEqual(stdout.decode().strip(), "synthetic guarded cycle and ledger passed")
                self.assertEqual(actions, ["record", "read", "read", "confirm"])
                self.assertEqual(work.blocking_preview(), [(self.first, "recovering", 0, 1)])
                self.assertIsNone(work.recovery_ref_transition(self.first))
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                os.close(request_read)
                os.close(reply_write)
        with worker_ledger.Ledger(self.path, self.lock_path) as work:
            self.assertEqual(work.blocking_preview(), [(self.first, "uncertain", 0, 1)])
            self.assertIsNone(work.recovery_ref_transition(self.first))
            work.begin_status_recovery(self.first, {**commitment, "mac":transition["nextMac"]})

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
