import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from dependabot_journal import DependabotJournal
from mvp_store import Store


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / "state.sqlite")
        self.store.initialize()
        self.journal = DependabotJournal(self.store)
        self.journal.initialize()

    def test_creation_intent_and_issue_survive_restart(self):
        self.assertTrue(self.journal.begin(20, 123))
        restarted = DependabotJournal(Store(self.store.path))
        restarted.initialize()
        self.assertFalse(restarted.begin(20, 123))
        self.assertEqual(restarted.read(20, 123), {"issue_number": None})
        restarted.bind(20, 123, 124)
        self.assertEqual(self.journal.read(20, 123), {"issue_number": 124})
        restarted.bind(20, 123, 124)
        with self.assertRaises(ValueError):
            restarted.bind(20, 123, 125)

    def test_missing_database_cannot_be_initialized(self):
        journal = DependabotJournal(Store(Path(self.directory.name) / "absent.sqlite"))
        with self.assertRaises(Exception):
            journal.initialize()
        self.assertFalse(journal.store.path.exists())


if __name__ == "__main__":
    unittest.main()
