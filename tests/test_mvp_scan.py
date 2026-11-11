import sys
import tempfile
import threading
import unittest
from collections import deque
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_scan import collect_in_background, stage_one
from mvp_store import Store


class ScanQueueTests(unittest.TestCase):
    def test_collection_failure_does_not_prevent_next_project(self):
        class Client:
            def __init__(self, result):
                self.result = result

            def reconciliation_candidates(self, *_args):
                if isinstance(self.result, Exception):
                    raise self.result
                return self.result

        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "state.sqlite")
            store.initialize()
            clients = {1: (Client(ValueError("private detail")), "boundary"),
                       2: (Client([8]), "boundary")}
            results = collect_in_background(store, clients, [1, 2], threading.Event())
            first = results.get(timeout=2)
            second = results.get(timeout=2)
            self.assertEqual(first[:2], (1, None))
            self.assertEqual(second[:2], (2, [8]))
            self.assertIsNone(results.get(timeout=2))

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
