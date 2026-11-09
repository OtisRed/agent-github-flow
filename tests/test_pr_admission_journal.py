import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pr_admission_journal import MergeJournal


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
