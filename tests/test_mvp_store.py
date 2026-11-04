import sqlite3
import concurrent.futures
import os
import subprocess
from contextlib import closing
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_store import Store, checkpoint_status, comment_digest


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "state.sqlite"
        self.now = 1000.0
        self.store = Store(self.path, clock=lambda: self.now)
        self.store.initialize()

    def test_coalescing_new_event_during_work_and_restart(self):
        self.store.enqueue(12, 34)
        self.store.enqueue(12, 34)
        first = self.store.next_pending()
        self.assertEqual(first["generation"], 2)
        self.store.enqueue(12, 34)
        self.store.complete(12, 34, first["generation"], comment_id=99, comment_digest="a" * 64)
        after_restart = Store(self.path).next_pending()
        self.assertEqual(after_restart["generation"], 3)
        self.assertEqual(after_restart["completed_generation"], 2)
        self.assertEqual(after_restart["comment_id"], 99)
        self.store.complete(12, 34, 3)
        self.assertIsNone(self.store.next_pending())

    def test_fifo_across_projects_and_coalesced_wakeups(self):
        self.store.enqueue(20, 5)
        self.store.enqueue(1, 1)
        self.store.enqueue(20, 5)
        first = self.store.next_pending()
        self.assertEqual((first['repository_id'], first['issue_number']), (20, 5))
        self.assertEqual(first['generation'], 2)
        self.store.complete(20, 5, first['generation'])
        self.assertEqual(self.store.next_pending()['repository_id'], 1)

    def test_wakeup_during_processing_goes_after_waiting_issues_and_survives_restart(self):
        self.store.enqueue(1, 1)
        first = self.store.next_pending()
        self.store.enqueue(2, 1)
        self.store.enqueue(1, 1)
        self.store.complete(1, 1, first['generation'])
        restarted = Store(self.path, clock=lambda: self.now)
        self.assertEqual(restarted.next_pending()['repository_id'], 2)
        restarted.complete(2, 1, restarted.next_pending()['generation'])
        self.assertEqual(restarted.next_pending()['repository_id'], 1)

    def test_fifo_does_not_starve_other_project_under_repeated_wakeups(self):
        self.store.enqueue(1, 1)
        self.store.enqueue(2, 1)
        first = self.store.next_pending()
        self.store.enqueue(1, 1)
        self.store.complete(1, 1, first['generation'])
        self.assertEqual(self.store.next_pending()['repository_id'], 2)

    def test_repeated_wakeups_do_not_cancel_transient_failure_backoff(self):
        self.store.enqueue(1, 1)
        self.store.enqueue(2, 1)
        self.store.defer(1, 1)
        self.store.enqueue(1, 1)
        self.assertEqual(self.store.next_pending()['repository_id'], 2)
        self.now += 60
        self.assertEqual(self.store.next_pending()['repository_id'], 1)

    def test_pending_work_survives_process_exit_at_enqueue_commit(self):
        src = str(Path(__file__).resolve().parents[1] / 'src')
        script = '''import os, sys
sys.path.insert(0, sys.argv[1])
from mvp_store import Store
store = Store(sys.argv[2])
connect = store._connect
class KillAtCommit:
    def __init__(self, db): self.db = db
    def __getattr__(self, name): return getattr(self.db, name)
    def __enter__(self): self.db.__enter__(); return self
    def __exit__(self, *args):
        if sys.argv[3] == 'before': os._exit(73)
        self.db.__exit__(*args)
        os._exit(73)
store._connect = lambda: KillAtCommit(connect())
store.enqueue(2, 1)
os._exit(74)
'''
        for mode in ('before', 'after'):
            with self.subTest(mode=mode):
                path = self.path.parent / (mode + '.sqlite')
                Store(path).initialize()
                process = subprocess.run([sys.executable, '-c', script, src, str(path), mode],
                                         capture_output=True, text=True)
                self.assertEqual(process.returncode, 73, process.stderr)
                row = Store(path).get(2, 1)
                self.assertEqual(row is not None, mode == 'after')
                if row is not None:
                    self.assertEqual(Store(path).next_pending()['repository_id'], 2)

    def test_pending_work_and_fifo_survive_process_exit_at_completion_commit(self):
        src = str(Path(__file__).resolve().parents[1] / 'src')
        script = '''import os, sys
sys.path.insert(0, sys.argv[1])
from mvp_store import Store
store = Store(sys.argv[2])
connect = store._connect
class KillAtCommit:
    def __init__(self, db): self.db = db
    def __getattr__(self, name): return getattr(self.db, name)
    def __enter__(self): self.db.__enter__(); return self
    def __exit__(self, *args):
        if sys.argv[3] == 'before': os._exit(73)
        self.db.__exit__(*args)
        os._exit(73)
store._connect = lambda: KillAtCommit(connect())
store.complete(1, 1, 1)
os._exit(74)
'''
        for mode in ('before', 'after'):
            with self.subTest(mode=mode):
                path = self.path.parent / (mode + '-complete.sqlite')
                store = Store(path)
                store.initialize()
                store.enqueue(1, 1)
                store.enqueue(2, 1)
                store.enqueue(1, 1)  # newer work must move behind project 2
                process = subprocess.run([sys.executable, '-c', script, src, str(path), mode],
                                         capture_output=True, text=True)
                self.assertEqual(process.returncode, 73, process.stderr)
                restarted = Store(path)
                self.assertEqual(restarted.get(1, 1)['completed_generation'], 0 if mode == 'before' else 1)
                self.assertEqual(restarted.next_pending()['repository_id'], 1 if mode == 'before' else 2)

    def test_explicit_v1_migration_preserves_state_and_seeds_pending_work(self):
        self.store.enqueue(20, 2)
        self.store.enqueue(10, 1)
        self.store.enqueue(30, 3)
        self.store.block(30, 3, 1, 'checkpoint-missing')
        self.store.begin_status_write(10, 1, 1, 'agent-ready', comment_id=9, comment_digest='a' * 64)
        before = [self.store.get(repo, number) for repo, number in ((10, 1), (20, 2), (30, 3))]
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('DROP TABLE work_queue')
            db.execute('PRAGMA user_version=1')
        with self.assertRaises(ValueError):
            Store(self.path).next_pending()
        Store(self.path).migrate_v1()
        after = [self.store.get(repo, number) for repo, number in ((10, 1), (20, 2), (30, 3))]
        self.assertEqual(after, before)
        self.assertEqual(self.store.next_pending()['repository_id'], 20)  # 10 is in the uncertainty interval
        self.now += 120
        self.assertEqual(self.store.next_pending()['repository_id'], 10)
        with self.assertRaises(ValueError):
            Store(self.path).migrate_v1()

    def test_failed_v1_migration_rolls_back_without_erasing_work(self):
        self.store.enqueue(20, 2)
        before = self.store.get(20, 2)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('DROP TABLE work_queue')
            db.execute('CREATE TABLE work_queue (foreign_data TEXT)')
            db.execute('PRAGMA user_version=1')
        with self.assertRaises(sqlite3.OperationalError):
            Store(self.path).migrate_v1()
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT generation FROM issues').fetchone()[0], before['generation'])
            self.assertEqual(db.execute('PRAGMA table_info(work_queue)').fetchone()[1], 'foreign_data')

    def test_uncertain_write_survives_restart_and_waits(self):
        self.store.enqueue(1, 2)
        self.store.begin_status_write(1, 2, 1, "agent-ready", comment_id=77, comment_digest="a" * 64)
        with self.assertRaises(ValueError):
            self.store.complete(1, 2, 1)
        restarted = Store(self.path, clock=lambda: self.now)
        self.now = 1119.9
        self.assertFalse(restarted.recovery_ready(1, 2))
        with self.assertRaises(ValueError):
            restarted.resolve_status_write(1, 2, target_observed=False)
        self.now = 1120
        self.assertTrue(restarted.recovery_ready(1, 2))
        self.now = 999
        self.assertFalse(restarted.recovery_ready(1, 2))
        self.now = 1120
        restarted.resolve_status_write(1, 2, target_observed=False)  # caller re-read GitHub
        restarted.complete(1, 2, 1)
        self.assertIsNone(restarted.next_pending())

    def test_confirmed_target_does_not_wait(self):
        self.store.enqueue(1, 2)
        self.store.begin_status_write(1, 2, 1, "agent-ready", comment_id=77, comment_digest="a" * 64)
        self.store.resolve_status_write(1, 2, target_observed=True)
        after_restart = Store(self.path).next_pending()
        self.assertEqual(after_restart["comment_id"], 77)
        self.assertEqual(after_restart["comment_digest"], "a" * 64)
        self.store.complete(1, 2, 1)
        self.assertIsNone(self.store.next_pending())

    def test_unconfirmed_attempt_keeps_original_comment_across_restart(self):
        self.store.enqueue(1, 2)
        self.store.begin_status_write(1, 2, 1, "agent-ready", comment_id=77, comment_digest="a" * 64)
        self.store.enqueue(1, 2)
        after_restart = Store(self.path).next_pending()
        self.assertEqual(after_restart["uncertain_comment_id"], 77)
        self.assertEqual(after_restart["uncertain_comment_digest"], "a" * 64)
        self.assertEqual(after_restart["uncertain_generation"], 1)
        self.assertEqual(after_restart["generation"], 2)

    def test_tracked_comment_edit_and_deletion_are_not_mistaken_for_handoff(self):
        digest = comment_digest("[FLOW]\noriginal")
        self.assertEqual(checkpoint_status(77, digest, {"id": 77, "body": "[FLOW]\noriginal"}), "unchanged")
        self.assertEqual(checkpoint_status(77, digest, {"id": 77, "body": "[FLOW]\nedited"}), "changed")
        self.assertEqual(checkpoint_status(77, digest, None), "missing")
        self.assertEqual(checkpoint_status(77, digest, {"id": 76, "body": "[FLOW]\noriginal"}), "invalid-read")

    def test_reopen_marker_and_recheck_are_committed_together(self):
        self.store.enqueue(1, 2)
        self.store.complete(1, 2, 1, reopen_id=55, recheck=True)
        after_restart = Store(self.path).next_pending()
        self.assertEqual((after_restart["reopen_id"], after_restart["generation"],
                          after_restart["completed_generation"]), (55, 2, 1))
        self.store.complete(1, 2, 2)
        self.assertIsNone(self.store.next_pending())

    def test_crash_before_completion_leaves_work_pending(self):
        self.store.enqueue(1, 1)
        self.assertEqual(Store(self.path).next_pending()["generation"], 1)
        with self.assertRaises(ValueError):
            self.store.complete(1, 1, 2)
        self.assertEqual(self.store.next_pending()["completed_generation"], 0)

    def test_missing_incomplete_and_duplicate_initialization_fail(self):
        with self.assertRaises(FileExistsError):
            self.store.initialize()
        missing = Store(self.path.parent / "missing.sqlite")
        with self.assertRaises(sqlite3.OperationalError):
            missing.next_pending()
        self.assertFalse(missing.path.exists())
        incomplete = self.path.parent / "incomplete.sqlite"
        incomplete.touch()
        with self.assertRaises(ValueError):
            Store(incomplete).next_pending()

    def test_project_boundary_cannot_be_silently_moved(self):
        self.store.register_boundary(20, "2026-11-01T00:00:00Z")
        self.store.register_boundary(20, "2026-11-01T00:00:00Z")
        with self.assertRaises(ValueError):
            self.store.register_boundary(20, "2026-11-02T00:00:00Z")

    def test_consistent_backup_survives_further_live_writes(self):
        self.store.register_boundary(1, "2026-11-01T00:00:00Z")
        self.store.enqueue(1, 2)
        self.store.backup()
        backup = Store(self.path.with_name(self.path.name + ".backup"))
        self.store.enqueue(1, 2)
        self.assertEqual(backup.next_pending()["generation"], 1)
        self.assertEqual(self.store.next_pending()["generation"], 2)
        backup.register_boundary(1, "2026-11-01T00:00:00Z")

    def test_failed_checkpoint_does_not_acknowledge_work(self):
        self.store.enqueue(1, 2)
        with self.assertRaises(ValueError):
            self.store.complete(1, 2, 1, comment_id=55, comment_digest="invalid")
        self.assertEqual(self.store.next_pending()["completed_generation"], 0)

    def test_blocked_issue_does_not_starve_others_and_new_event_wakes_it(self):
        self.store.enqueue(1, 1)
        self.store.enqueue(1, 2)
        self.store.block(1, 1, 1, "checkpoint-missing")
        self.assertEqual(self.store.next_pending()["issue_number"], 2)
        self.assertEqual(self.store.errors()[0]["error_code"], "checkpoint-missing")
        self.store.enqueue(1, 1)
        self.assertEqual(self.store.next_pending()["issue_number"], 2)
        self.store.complete(1, 2, 1)
        self.assertEqual(self.store.next_pending()["issue_number"], 1)
        self.store.complete(1, 1, 2)
        self.assertEqual(self.store.errors(), [])

    def test_block_of_old_generation_keeps_later_event_ready(self):
        self.store.enqueue(1, 1)
        self.store.enqueue(1, 1)
        self.store.block(1, 1, 1, "checkpoint-changed")
        self.assertEqual(self.store.next_pending()["generation"], 2)

    def test_temporary_failure_waits_without_starving_others(self):
        self.store.enqueue(1, 1)
        self.store.enqueue(1, 2)
        self.store.defer(1, 1)
        self.assertEqual(self.store.next_pending()["issue_number"], 2)
        self.now += 60
        self.assertEqual(self.store.next_pending()["issue_number"], 1)

    def test_stale_completion_cannot_erase_newer_error(self):
        self.store.enqueue(1, 1)
        self.store.enqueue(1, 1)
        self.store.block(1, 1, 2, "checkpoint-changed")
        with self.assertRaises(ValueError):
            self.store.complete(1, 1, 1)
        self.assertEqual(self.store.errors()[0]["error_code"], "checkpoint-changed")

    def test_parallel_receivers_do_not_lose_wakeups(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: self.store.enqueue(1, 2), range(20)))
        self.assertEqual(self.store.next_pending()["generation"], 20)

    def test_failed_transaction_does_not_acknowledge(self):
        self.store.enqueue(1, 2)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("""CREATE TRIGGER fail_complete BEFORE UPDATE OF completed_generation
                          ON issues BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.complete(1, 2, 1)
        self.assertEqual(self.store.next_pending()["completed_generation"], 0)


if __name__ == "__main__":
    unittest.main()
