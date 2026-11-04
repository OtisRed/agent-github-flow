import sqlite3
import concurrent.futures
from contextlib import closing
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_store import Store


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

    def test_uncertain_write_survives_restart_and_waits(self):
        self.store.enqueue(1, 2)
        self.store.begin_status_write(1, 2, "agent-ready")
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
        self.store.begin_status_write(1, 2, "agent-ready")
        self.store.resolve_status_write(1, 2, target_observed=True)
        self.store.complete(1, 2, 1)
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

    def test_failed_checkpoint_does_not_acknowledge_work(self):
        self.store.enqueue(1, 2)
        with self.assertRaises(ValueError):
            self.store.complete(1, 2, 1, comment_id=55, comment_digest="invalid")
        self.assertEqual(self.store.next_pending()["completed_generation"], 0)

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
