import copy
import shutil
import sqlite3
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_store import Store
from selective_promotion_merge import SelectiveMergeJournal, request_github_squash, selective_merge_step


class SelectiveMergeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "journal.sqlite"
        self.journal = SelectiveMergeJournal(self.path)
        self.manifest = {"repository_id": 7, "main": "a" * 40, "smoke": "b" * 40,
                         "candidate": "c" * 40, "tree": "d" * 40,
                         "sources": [{"issue": 2, "cycle": 20, "pr": 3,
                                      "sha": "f" * 40, "method": "merge"}]}
        self.observation = {"repository_id": 7, "pr": 5, "state": "open", "draft": False,
                            "head": "c" * 40, "main": "a" * 40, "base": "a" * 40, "smoke": "b" * 40,
                            "clean": True, "protection_verified": True, "test_commit": "e" * 40, "tested_revision_verified": True,
                            "test_tree": "d" * 40, "test_parents": ["a" * 40, "c" * 40],
                            "sources": copy.deepcopy(self.manifest["sources"]),
                            "checks": [{"id": 1, "app": {"id": 9}, "name": "verify", "head_sha": "c" * 40,
                                        "status": "completed", "conclusion": "success"}]}
        self.writes = []

    def read(self, repo, pr):
        return dict(self.observation, repository_id=repo, pr=pr)

    def squash(self, repo, pr, head):
        self.writes.append((repo, pr, head))
        self.observation.update(merged=True, merge_commit="1" * 40, result_tree="d" * 40,
                                result_parents=["a" * 40], reachable_from_main=True)

    def step(self, **overrides):
        args = dict(enabled=True, read=self.read, squash=self.squash, required=(("verify", 9),))
        args.update(overrides)
        return selective_merge_step(self.journal, self.manifest, 5, **args)

    def test_success_is_recorded_and_replayed_without_second_write(self):
        self.assertEqual(self.step(), "merged")
        self.journal = SelectiveMergeJournal(self.path)
        self.assertEqual(self.step(), "merged")
        self.assertEqual(self.writes, [(7, 5, "c" * 40)])
        self.assertEqual(self.journal.read(7, 5)[1], "1" * 40)

    def test_controller_backup_restores_confirmed_and_pending_promotions(self):
        store = Store(self.path.with_name("state.sqlite"))
        store.initialize()
        store.enqueue(7, 2)
        journal = SelectiveMergeJournal(store.path, require_existing=True)
        self.assertTrue(journal.reserve(7, 5, self.manifest))
        self.assertTrue(journal.confirm(7, 5, "1" * 40))
        pending = copy.deepcopy(self.manifest)
        pending["sources"][0]["pr"] = 9
        self.assertTrue(journal.reserve(7, 8, pending))

        store.backup()
        restored = self.path.with_name("restored.sqlite")
        shutil.copyfile(store.path.with_name("state.sqlite.backup"), restored)
        restored_journal = SelectiveMergeJournal(restored, require_existing=True)
        self.assertEqual(restored_journal.latest_confirmed(7), "1" * 40)
        self.assertIsNone(restored_journal.read(7, 8)[1])
        self.assertFalse(restored_journal.reserve(7, 10, self.manifest))
        restored_journal.cancel_before_send(7, 8, pending)
        self.assertFalse(restored_journal.reserve(7, 10, self.manifest))
        self.assertEqual(Store(restored).next_pending()["issue_number"], 2)

    def test_runtime_journal_does_not_recreate_missing_state(self):
        missing = self.path.with_name("missing-state.sqlite")
        with self.assertRaises(sqlite3.OperationalError):
            SelectiveMergeJournal(missing, require_existing=True)
        self.assertFalse(missing.exists())

    def test_opt_in_draft_ci_and_exact_proof(self):
        self.assertEqual(self.step(enabled=False), "disabled")
        for field, value in (("draft", True), ("main", "9" * 40), ("smoke", "8" * 40),
                             ("sources", []), ("test_tree", "9" * 40), ("protection_verified", False),
                             ("tested_revision_verified", False), ("test_commit", None), ("test_parents", []), ("checks", [])):
            prior = self.observation[field]
            with self.subTest(field=field):
                self.observation[field] = value
                self.assertEqual(self.step(), "waiting-or-stale")
            self.observation[field] = prior
        self.observation["checks"][0]["conclusion"] = "failure"
        self.assertEqual(self.step(), "waiting-or-stale")
        self.assertEqual(self.writes, [])

    def test_reopen_or_base_change_before_write_releases_unused_reservation(self):
        calls = 0

        def read(repo, pr):
            nonlocal calls
            calls += 1
            observed = self.read(repo, pr)
            if calls == 2:
                observed["sources"] = []
            return observed

        self.assertEqual(self.step(read=read), "waiting-or-stale")
        self.assertIsNone(self.journal.read(7, 5))
        self.assertEqual(self.writes, [])
        self.assertEqual(self.step(), "merged")

    def test_lost_response_after_squash_recovers_on_restart(self):
        def lost(*args):
            self.squash(*args)
            raise TimeoutError("response lost")

        with self.assertRaises(TimeoutError):
            self.step(squash=lost)
        self.assertIsNone(self.journal.read(7, 5)[1])
        self.journal = SelectiveMergeJournal(self.path)
        self.assertEqual(self.step(enabled=False), "merged")
        self.assertEqual(len(self.writes), 1)

    def test_ambiguous_result_blocks_another_pr_and_cannot_retry(self):
        def unknown(*args):
            self.writes.append(args)
            raise TimeoutError("response lost")

        with self.assertRaises(TimeoutError):
            self.step(squash=unknown)
        self.assertEqual(self.step(), "unknown")
        other = dict(self.manifest, sources=[dict(self.manifest["sources"][0], pr=4)])
        self.assertFalse(self.journal.reserve(7, 6, other))
        self.assertEqual(len(self.writes), 1)

    def test_wrong_parent_or_tree_does_not_confirm_external_merge(self):
        def unknown(*args):
            self.squash(*args)
            self.observation["result_parents"] = ["9" * 40]
        self.assertEqual(self.step(squash=unknown), "unknown")
        self.observation["result_parents"] = ["a" * 40]
        self.observation["result_tree"] = "9" * 40
        self.assertEqual(self.step(), "unknown")
        self.assertEqual(len(self.writes), 1)

    def test_concurrent_calls_only_send_once_and_do_not_reuse_promoted_sources(self):
        entered, release = Event(), Event()

        def block(*args):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("test thread stalled")
            self.squash(*args)

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.step, squash=block)
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.step(), "unknown")
            finally:
                release.set()
            self.assertEqual(first.result(timeout=5), "merged")
        self.assertEqual(len(self.writes), 1)
        self.assertFalse(self.journal.reserve(7, 6, self.manifest))

    def test_github_request_is_squash_bound_to_head_and_missing_response_is_uncertain(self):
        calls = []

        def transport(path, token, *, body):
            calls.append((path, token, body))
            return {"errors": [{"message": "unknown"}]}, None

        with self.assertRaisesRegex(ValueError, "Unconfirmed"):
            request_github_squash(transport, "fixture", "PR_node", "c" * 40)
        self.assertEqual(len(calls), 1)
        path, token, body = calls[0]
        self.assertEqual((path, token), ("/graphql", "fixture"))
        self.assertEqual(body["variables"], {"pr": "PR_node", "head": "c" * 40})
        self.assertIn("mergeMethod: SQUASH", body["query"])
        self.assertIn("expectedHeadOid: $head", body["query"])
