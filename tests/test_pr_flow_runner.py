import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_decision import decide
from mvp_store import Store
from pr_flow_runner import process_pr_handoff
from mvp_worker import process_one


class Gateway:
    def __init__(self, snapshot, candidates):
        self.snapshot, self.candidates = snapshot, candidates
        self.posted = []
        self.error = False

    def read(self, repo, number):
        return self.snapshot

    def read_pr_candidates(self, number):
        return self.candidates

    def post_flow(self, number, text):
        self.posted.append((number, text))
        if self.error:
            raise TimeoutError()


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.now = 1000
        self.store = Store(Path(self.directory.name) / "state.sqlite", clock=lambda: self.now)
        self.store.initialize()
        self.store.enqueue(20, 7)
        self.row = self.store.next_pending()
        self.comment = {"id": 3, "author_id": 4, "created_at": "2026-11-08T10:01:00Z",
                        "updated_at": "2026-11-08T10:01:00Z", "body": "[FLOW]\nRola: designer\n"
                        "Stan docelowy: agent-ready\nWykonano: Kontrakt.\nNastępny krok: Implementacja."}
        self.snapshot = {"complete": True, "state": "OPEN", "status": "agent-ready",
                         "created_at": "2026-11-08T09:00:00Z", "comments": [self.comment],
                         "latest_reopen": None}
        self.pr = {"number": 12, "body": "Refs #7", "base_ref": "smoke", "head_ref": "issue/7",
                   "same_repository": True, "state": "open", "merged": False,
                   "created_at": "2026-11-08T10:02:00Z", "merge_commit_sha": "a" * 40}
        self.gateway = Gateway(self.snapshot, [self.pr])
        self.boundary = "2026-11-08T10:00:00Z"

    def run_step(self):
        decision = decide(self.snapshot, self.row, enrolled_at=self.boundary, trusted_authors=frozenset({4, 99}))
        return process_pr_handoff(self.store, self.gateway, self.row, self.snapshot, decision,
                                  enrolled_at=self.boundary, app_author_id=99, trusted_authors=frozenset({4, 99}))

    def test_posts_and_immediately_queues_status_read(self):
        self.assertEqual(self.run_step(), "handoff-posted")
        self.assertEqual(len(self.gateway.posted), 1)
        self.assertEqual(self.store.next_pending()["generation"], 2)

    def test_uncertain_post_waits_before_retry(self):
        self.gateway.error = True
        self.assertEqual(self.run_step(), "write-uncertain")
        self.assertIsNone(self.store.next_pending())
        self.now += 120
        self.assertIsNotNone(self.store.next_pending())

    def test_changed_issue_rescans_without_writing(self):
        self.gateway.snapshot = {**self.snapshot, "status": "audit"}
        self.assertEqual(self.run_step(), "rescan")
        self.assertEqual(self.gateway.posted, [])

    def test_ambiguous_prs_do_not_post(self):
        self.gateway.candidates.append({**self.pr, "number": 13})
        self.assertEqual(self.run_step(), "no-change")
        self.assertEqual(self.gateway.posted, [])

    def test_existing_worker_projects_draft_then_confirmed_merge(self):
        gateway = self.gateway
        gateway.read = lambda repo, number: deepcopy(self.snapshot)
        def post(number, text):
            gateway.posted.append((number, text))
            stamp = "2026-11-08T10:03:00Z" if "review" in text else "2026-11-08T10:05:00Z"
            self.snapshot["comments"].append({"id": len(self.snapshot["comments"]) + 3, "author_id": 99,
                                              "body": text, "created_at": stamp, "updated_at": stamp})
        gateway.post_flow = post
        gateway.set_status = lambda repo, number, status: self.snapshot.update(status=status)
        def step():
            return process_one(self.store, gateway, enrolled_at=self.boundary, trusted_authors=frozenset({4, 99}),
                               pr_flow={"enrolled_at": self.boundary, "app_author_id": 99})["kind"]
        self.assertEqual(step(), "rescan")
        self.assertEqual(step(), "completed")
        self.assertEqual(self.snapshot["status"], "review")
        self.pr.update(state="closed", merged=True, merged_at="2026-11-08T10:04:00Z")
        self.store.enqueue(20, 7)
        self.assertEqual(step(), "rescan")
        self.assertEqual(step(), "completed")
        self.assertEqual(self.snapshot["status"], "smoke")
        self.assertEqual(len(gateway.posted), 2)

    def test_lost_response_rechecks_existing_comment_without_duplicate(self):
        gateway = self.gateway
        gateway.read = lambda repo, number: deepcopy(self.snapshot)
        def uncertain_post(number, text):
            gateway.posted.append((number, text))
            self.snapshot["comments"].append({"id": 4, "author_id": 99, "body": text,
                                              "created_at": "2026-11-08T10:03:00Z",
                                              "updated_at": "2026-11-08T10:03:00Z"})
            raise TimeoutError()
        gateway.post_flow = uncertain_post
        gateway.set_status = lambda repo, number, status: self.snapshot.update(status=status)
        def step():
            return process_one(self.store, gateway, enrolled_at=self.boundary, trusted_authors=frozenset({4, 99}),
                               pr_flow={"enrolled_at": self.boundary, "app_author_id": 99})["kind"]
        self.assertEqual(step(), "write-uncertain")
        self.assertIsNone(self.store.next_pending())
        self.now += 120
        self.assertEqual(step(), "completed")
        self.assertEqual(self.snapshot["status"], "review")
        self.assertEqual(len(gateway.posted), 1)

    def test_worker_accepts_trusted_manual_review_then_projects_smoke(self):
        self.snapshot["status"] = "review"
        self.comment.update(body="[FLOW]\nRola: agent\nStan docelowy: review\n"
                                 "Wykonano: Przygotowano PR #12.\nNastępny krok: Review.",
                            created_at="2026-11-08T10:03:00Z", updated_at="2026-11-08T10:03:00Z")
        self.pr.update(state="closed", merged=True, merged_at="2026-11-08T10:04:00Z")
        self.pr.pop("merge_commit_sha", None)
        gateway = self.gateway
        gateway.read = lambda repo, number: deepcopy(self.snapshot)
        def post(number, text):
            gateway.posted.append((number, text))
            self.snapshot["comments"].append({"id": 4, "author_id": 99, "body": text,
                                              "created_at": "2026-11-08T10:05:00Z",
                                              "updated_at": "2026-11-08T10:05:00Z"})
        gateway.post_flow = post
        gateway.set_status = lambda repo, number, status: self.snapshot.update(status=status)
        def step():
            return process_one(self.store, gateway, enrolled_at=self.boundary, trusted_authors=frozenset({4, 99}),
                               pr_flow={"enrolled_at": self.boundary, "app_author_id": 99})["kind"]
        self.assertEqual(step(), "rescan")
        self.assertEqual(step(), "completed")
        self.assertEqual(self.snapshot["status"], "smoke")
        self.assertEqual(len(gateway.posted), 1)

    def test_existing_issue_moves_to_smoke_after_new_merge_without_rewriting_history(self):
        self.snapshot["status"] = "review"
        self.comment.update(body="Historical workflow receipt", created_at="2026-11-08T09:30:00Z",
                            updated_at="2026-11-08T09:30:00Z")
        self.pr.update(created_at="2026-11-08T09:45:00Z", updated_at="2026-11-08T10:04:00Z",
                       state="closed", merged=True, merged_at="2026-11-08T10:04:00Z")
        gateway = self.gateway
        gateway.read = lambda repo, number: deepcopy(self.snapshot)
        def post(number, text):
            gateway.posted.append((number, text))
            self.snapshot["comments"].append({"id": 4, "author_id": 99, "body": text,
                                              "created_at": "2026-11-08T10:05:00Z",
                                              "updated_at": "2026-11-08T10:05:00Z"})
        gateway.post_flow = post
        gateway.set_status = lambda repo, number, status: self.snapshot.update(status=status)
        def step():
            return process_one(self.store, gateway, enrolled_at=self.boundary, trusted_authors=frozenset({4, 99}),
                               pr_flow={"enrolled_at": self.boundary, "app_author_id": 99})["kind"]
        self.assertEqual(step(), "rescan")
        self.assertEqual(step(), "completed")
        self.assertEqual(self.snapshot["status"], "smoke")
        self.assertEqual(self.snapshot["comments"][0]["body"], "Historical workflow receipt")

    def test_edited_legacy_comment_blocks_projection_of_new_merge(self):
        self.snapshot["status"] = "review"
        self.comment.update(body="Historical receipt", created_at="2026-11-08T09:30:00Z",
                            updated_at="2026-11-08T10:03:00Z")
        self.pr.update(created_at="2026-11-08T09:45:00Z", updated_at="2026-11-08T10:04:00Z",
                       state="closed", merged=True, merged_at="2026-11-08T10:04:00Z")
        result = process_one(self.store, self.gateway, enrolled_at=self.boundary, trusted_authors=frozenset({4, 99}),
                             pr_flow={"enrolled_at": self.boundary, "app_author_id": 99})
        self.assertEqual(result, {"kind": "blocked", "reason": "legacy-comment-edited"})
        self.assertEqual(self.gateway.posted, [])
        self.assertEqual(self.snapshot["status"], "review")

    def test_existing_agent_ready_issue_moves_to_review_after_pr_update(self):
        self.comment.update(body="Historical receipt", created_at="2026-11-08T09:30:00Z",
                            updated_at="2026-11-08T09:30:00Z")
        self.pr.update(created_at="2026-11-08T09:45:00Z", updated_at="2026-11-08T10:04:00Z")
        gateway = self.gateway
        gateway.read = lambda repo, number: deepcopy(self.snapshot)
        def post(number, text):
            gateway.posted.append((number, text))
            self.snapshot["comments"].append({"id": 4, "author_id": 99, "body": text,
                                              "created_at": "2026-11-08T10:05:00Z",
                                              "updated_at": "2026-11-08T10:05:00Z"})
        gateway.post_flow = post
        gateway.set_status = lambda repo, number, status: self.snapshot.update(status=status)
        def step():
            return process_one(self.store, gateway, enrolled_at=self.boundary, trusted_authors=frozenset({4, 99}),
                               pr_flow={"enrolled_at": self.boundary, "app_author_id": 99})["kind"]
        self.assertEqual(step(), "rescan")
        self.assertEqual(step(), "completed")
        self.assertEqual(self.snapshot["status"], "review")
        self.assertEqual(len(gateway.posted), 1)
        # The same older PR can subsequently merge after the new review FLOW.
        self.pr.update(state="closed", merged=True, merged_at="2026-11-08T10:06:00Z")
        self.store.enqueue(20, 7)
        def post_smoke(number, text):
            gateway.posted.append((number, text))
            self.snapshot["comments"].append({"id": 5, "author_id": 99, "body": text,
                                              "created_at": "2026-11-08T10:07:00Z",
                                              "updated_at": "2026-11-08T10:07:00Z"})
        gateway.post_flow = post_smoke
        self.assertEqual(step(), "rescan")
        self.assertEqual(step(), "completed")
        self.assertEqual(self.snapshot["status"], "smoke")
        self.assertEqual(len(gateway.posted), 2)


if __name__ == "__main__":
    unittest.main()
