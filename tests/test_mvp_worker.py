import copy
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_store import Store, comment_digest
from mvp_worker import process_one

FLOW = "[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Projekt\nNastępny krok: Kod"
BOUNDARY = "2026-11-01T00:00:00Z"
AUTHORS = frozenset({10})


class FakeGithub:
    def __init__(self):
        self.snapshot = {"complete": True, "state": "OPEN", "status": "needs-design",
                         "created_at": "2026-10-01T00:00:00Z", "comments": [], "latest_reopen": None}
        self.writes = []
        self.fail_after_write = False
        self.after_write = None
        self.added = 0

    def read(self, *_):
        return copy.deepcopy(self.snapshot)

    def set_status(self, _repo, _number, status):
        self.writes.append(status)
        self.snapshot["status"] = status
        if self.after_write:
            self.after_write()
        if self.fail_after_write:
            raise TimeoutError("synthetic")

    def add_item(self, _repo, _number):
        self.added += 1
        self.snapshot.pop("missing_card")
        self.snapshot["status"] = None


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.now = 1000.0
        self.store = Store(Path(self.directory.name) / "state.sqlite", clock=lambda: self.now)
        self.store.initialize()
        self.github = FakeGithub()

    def run_worker(self):
        return process_one(self.store, self.github, enrolled_at=BOUNDARY, trusted_authors=AUTHORS)

    def handoff(self, number=77, when="2026-11-02T00:00:00Z"):
        return {"id": number, "body": FLOW, "created_at": when, "updated_at": when, "author_id": 10}

    def test_handoff_updates_status_then_saves_checkpoint(self):
        self.github.snapshot["comments"] = [self.handoff()]
        self.store.enqueue(20, 7)
        self.assertEqual(self.run_worker()["kind"], "completed")
        self.assertEqual(self.github.writes, ["agent-ready"])
        self.assertEqual(self.store.get(20, 7)["comment_id"], 77)
        self.assertIsNone(self.store.next_pending())

    def test_lost_response_preserves_intent_and_recovers_from_observation(self):
        self.github.snapshot["comments"] = [self.handoff()]
        self.github.fail_after_write = True
        self.store.enqueue(20, 7)
        self.assertEqual(self.run_worker()["kind"], "write-uncertain")
        self.assertEqual(self.store.get(20, 7)["uncertain_comment_id"], 77)
        self.assertEqual(self.run_worker()["kind"], "idle")
        self.now = 1120
        self.assertEqual(self.run_worker()["kind"], "completed")
        self.assertEqual(self.github.writes, ["agent-ready"])
        self.assertEqual(self.store.get(20, 7)["comment_id"], 77)

    def test_new_event_during_write_remains_pending(self):
        self.github.snapshot["comments"] = [self.handoff()]
        self.github.after_write = lambda: self.store.enqueue(20, 7)
        self.store.enqueue(20, 7)
        self.assertEqual(self.run_worker()["kind"], "completed")
        self.assertEqual(self.store.next_pending()["generation"], 2)

    def test_changed_issue_yields_to_already_waiting_issue(self):
        self.github.snapshot["comments"] = [self.handoff()]
        self.store.enqueue(20, 7)
        self.store.enqueue(30, 8)
        read = self.github.read
        calls = 0
        def read_with_wakeup(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.store.enqueue(20, 7)
            return read(*args)
        self.github.read = read_with_wakeup
        self.assertEqual(self.run_worker()["kind"], "rescan")
        self.assertEqual(self.store.next_pending()["repository_id"], 30)

    def test_worker_uses_the_issue_selected_for_its_project_client(self):
        self.store.enqueue(20, 7)
        selected = self.store.next_pending()
        self.store.enqueue(10, 1)
        seen = []
        read = self.github.read
        def record_repo(repo, number):
            seen.append((repo, number))
            return read(repo, number)
        self.github.read = record_repo
        process_one(self.store, self.github, enrolled_at=BOUNDARY, trusted_authors=AUTHORS, row=selected)
        self.assertEqual(seen[0], (20, 7))

    def test_reopen_first_resets_then_processes_new_handoff(self):
        self.github.snapshot.update({"status": "smoke", "latest_reopen": {"id": 55, "created_at": "2026-11-02T10:00:00Z"},
                                     "comments": [self.handoff(77, "2026-11-02T11:00:00Z")]})
        self.store.enqueue(20, 7)
        self.assertEqual(self.run_worker()["kind"], "completed")
        self.assertEqual(self.github.writes, ["needs-design"])
        self.assertEqual(self.store.next_pending()["reopen_id"], 55)
        self.assertEqual(self.run_worker()["kind"], "completed")
        self.assertEqual(self.github.writes, ["needs-design", "agent-ready"])

    def test_removed_checkpoint_blocks_and_does_not_write(self):
        self.store.enqueue(20, 7)
        self.store.complete(20, 7, 1, comment_id=77, comment_digest=comment_digest(FLOW, "2026-11-02T00:00:00Z"))
        self.store.enqueue(20, 7)
        self.assertEqual(self.run_worker(), {"kind": "blocked", "reason": "checkpoint-missing"})
        self.assertEqual(self.github.writes, [])
        self.assertEqual(self.store.errors()[0]["error_code"], "checkpoint-missing")

    def test_unconfirmed_old_status_waits_then_rechecks(self):
        self.github.snapshot["comments"] = [self.handoff()]
        self.store.enqueue(20, 7)
        self.store.begin_status_write(20, 7, 1, "agent-ready", comment_id=77, comment_digest=comment_digest(FLOW, "2026-11-02T00:00:00Z"))
        self.now = 1119
        self.assertEqual(self.run_worker()["kind"], "idle")
        self.assertEqual(self.github.writes, [])
        self.now = 1120
        self.assertEqual(self.run_worker()["kind"], "completed")
        self.assertEqual(self.github.writes, ["agent-ready"])

    def test_new_issue_waits_for_auto_add_then_is_put_in_needs_design(self):
        self.github.snapshot = {"complete": True, "missing_card": True, "state": "OPEN",
                                "created_at": "2026-11-02T00:00:00Z", "updated_at": "2026-11-02T00:00:00Z",
                                "comments": [], "latest_reopen": None}
        self.store.enqueue(20, 7)
        self.assertEqual(self.run_worker()["kind"], "awaiting-card")
        self.assertEqual(self.github.added, 0)
        self.assertEqual(self.run_worker()["kind"], "idle")
        self.now += 60
        self.github.add_item(20, 7)  # GitHub's built-in workflow, not the controller
        self.assertEqual(self.run_worker()["kind"], "completed")
        self.assertEqual(self.github.writes, ["needs-design"])

    def test_older_issue_without_card_waits_for_github_auto_add(self):
        self.github.snapshot = {"complete": True, "missing_card": True, "state": "OPEN",
                                "created_at": "2026-10-02T00:00:00Z", "updated_at": "2026-10-02T00:00:00Z"}
        self.store.enqueue(20, 7)
        self.assertEqual(self.run_worker(), {"kind": "awaiting-card"})
        self.assertEqual(self.github.added, 0)

    def test_previously_seen_card_is_never_silently_recreated(self):
        self.store.enqueue(20, 7)
        self.store.complete(20, 7, 1)
        self.store.enqueue(20, 7)
        self.github.snapshot = {"complete": True, "missing_card": True, "state": "OPEN",
                                "created_at": "2026-11-02T00:00:00Z", "updated_at": "2026-11-02T00:00:00Z"}
        self.assertEqual(self.run_worker(), {"kind": "blocked", "reason": "existing-card-missing"})
        self.assertEqual(self.github.added, 0)


if __name__ == "__main__":
    unittest.main()
