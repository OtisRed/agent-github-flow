import sys
import tempfile
import unittest
from collections import deque
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_scan import stage_one
from mvp_store import Store


class ScanQueueTests(unittest.TestCase):
    def test_live_event_keeps_fifo_position_ahead_of_unstaged_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "state.sqlite")
            store.initialize()
            backlog = deque([(1, 1), (1, 2), (1, 3)])
            stage_one(store, backlog)
            first = store.next_pending()
            store.enqueue(2, 4)  # Arrives while the first scan issue is being processed.
            store.complete(1, 1, first["generation"])
            stage_one(store, backlog)
            self.assertEqual((store.next_pending()["repository_id"], store.next_pending()["issue_number"]), (2, 4))
            current = store.next_pending()
            store.complete(2, 4, current["generation"])
            self.assertEqual(store.next_pending()["issue_number"], 2)

    def test_failed_enqueue_keeps_candidate_for_retry(self):
        class Failing:
            def enqueue(self, *_args):
                raise RuntimeError("synthetic failure")
        backlog = deque([(1, 2)])
        with self.assertRaises(RuntimeError):
            stage_one(Failing(), backlog)
        self.assertEqual(list(backlog), [(1, 2)])
