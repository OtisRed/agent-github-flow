import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pr_admission_journal import CiRetryJournal, MergeJournal
from mvp_store import Store


class CiRetryJournalTests(unittest.TestCase):
    def test_retry_reservation_survives_restart_and_is_per_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "state.sqlite")
            store.initialize()
            journal = CiRetryJournal(store)
            journal.initialize()
            self.assertTrue(journal.reserve(20, 4, 19, 1))
            restarted = CiRetryJournal(Store(store.path))
            restarted.initialize()
            self.assertFalse(restarted.reserve(20, 4, 19, 1))
            self.assertFalse(restarted.reserve(20, 5, 19, 1))
            self.assertTrue(restarted.reserve(20, 4, 19, 2))

    def test_missing_database_and_invalid_identifiers_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "absent.sqlite"
            with self.assertRaises(Exception):
                CiRetryJournal(Store(path)).initialize()
            self.assertFalse(path.exists())
            store = Store(path)
            store.initialize()
            journal = CiRetryJournal(store)
            journal.initialize()
            with self.assertRaises(ValueError):
                journal.reserve(20, 4, 19, 0)


@unittest.skipUnless(os.name == "posix", "POSIX private state is required")
class JournalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        os.chmod(self.directory.name, 0o700)
        self.journal = MergeJournal(self.directory.name, 20)

    def test_marker_survives_new_instance_and_refuses_second_attempt(self):
        self.journal.begin(4, "a" * 40)
        restarted = MergeJournal(self.directory.name, 20)
        self.assertEqual(restarted.pending(), [(4, "a" * 40)])
        with self.assertRaises(FileExistsError):
            restarted.begin(4, "a" * 40)
        restarted.confirm_merged(4)
        restarted.begin(4, "b" * 40)

    def test_world_accessible_state_directory_is_rejected(self):
        os.chmod(self.directory.name, 0o755)
        with self.assertRaises(ValueError):
            self.journal.begin(4, "a" * 40)


if __name__ == "__main__":
    unittest.main()
