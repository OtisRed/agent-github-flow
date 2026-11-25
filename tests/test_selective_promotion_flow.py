import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import test_selective_promotion_candidate as candidate_fixture
import test_selective_promotion_ci as ci_fixture
from selective_promotion_candidate import _git, build_candidate
from selective_promotion_flow import prepare_forward_sync, verify_and_squash
from selective_promotion_merge import SelectiveMergeJournal


class SelectiveFlowTests(unittest.TestCase):
    def setUp(self):
        fixture = candidate_fixture.CandidateTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.repo, self.main, self.smoke = fixture.repo, fixture.main, fixture.smoke
        bundle = self.repo / "candidate.bundle"
        self.manifest = build_candidate(self.repo, dict(fixture.plan, repository_id=1), {"12": "merge"},
                                        lambda repo, _: _git(repo, "bundle", "create", str(bundle),
                                                             "HEAD", f"^{self.main}"))
        _git(self.repo, "fetch", str(bundle), "HEAD:refs/heads/candidate")
        bundle.unlink()
        tree, head = self.manifest["tree"], self.manifest["candidate"]
        self.test_commit = _git(self.repo, "commit-tree", tree, "-p", self.main, "-p", head,
                                input_text="Fixture merge for CI\n", author=True)
        self.journal_path = self.repo.parent / (self.repo.name + "-journal.sqlite")
        self.addCleanup(self.journal_path.unlink, missing_ok=True)
        self.journal = SelectiveMergeJournal(self.journal_path)

        ci = ci_fixture.SelectiveCiTests()
        ci.setUp()
        raw = json.dumps(ci.responses)
        for sentinel, value in (("a", self.main), ("b", head), ("c", tree), ("f", self.test_commit)):
            raw = raw.replace(sentinel * 40, value)
        self.ci, self.policy, self.repository = json.loads(raw), ci.policy, ci.repo
        self.writes = 0
        self.squashed = None

    def read_ci(self, path):
        path = path.removeprefix(f"repos/{self.repository}/")
        if path == "git/ref/heads/main":
            return {"object": {"sha": _git(self.repo, "rev-parse", "origin/main")}}
        return self.ci[path]

    def observe(self, repo, pr):
        head = self.manifest["candidate"]
        if self.squashed:
            return {"state": "closed", "merged": True, "repository_id": repo, "pr": pr, "head": head,
                    "merge_commit": self.squashed,
                    "result_parents": _git(self.repo, "show", "-s", "--format=%P", self.squashed).split(),
                    "result_tree": _git(self.repo, "rev-parse", f"{self.squashed}^{{tree}}"),
                    "reachable_from_main": _git(self.repo, "merge-base", "origin/main", self.squashed) == self.squashed}
        return {"state": "open", "draft": False, "clean": True, "protection_verified": True,
                "repository_id": repo, "pr": pr, "head": head, "base": self.main,
                "main": _git(self.repo, "rev-parse", "origin/main"),
                "smoke": _git(self.repo, "rev-parse", "origin/smoke"), "sources": self.manifest["sources"]}

    def squash(self, repo, pr, head):
        self.assertEqual((repo, pr, head), (1, 2, self.manifest["candidate"]))
        self.writes += 1
        self.squashed = _git(self.repo, "commit-tree", self.manifest["tree"], "-p", self.main,
                             input_text="Fixture squash\n", author=True)
        _git(self.repo, "update-ref", "refs/remotes/origin/main", self.squashed, self.main)

    def run_step(self, *, squash=None, read_ci=None):
        return verify_and_squash(self.journal, self.manifest, 2, enabled=True, observe=self.observe,
                                 squash=squash or self.squash, repository=self.repository,
                                 read_ci=read_ci or self.read_ci, policy=self.policy, run_id=5, job_id=6)

    def test_offline_squash_then_forward_sync_keeps_accepted_and_pending_changes_on_smoke(self):
        def lose_response(*args):
            self.squash(*args)
            raise TimeoutError("Lost response after Git changed")

        with self.assertRaises(TimeoutError):
            self.run_step(squash=lose_response)
        self.assertEqual(prepare_forward_sync(self.repo, self.journal, 1, 2, self.smoke)["kind"],
                         "unconfirmed-promotion")
        self.journal = SelectiveMergeJournal(self.journal_path)
        self.assertEqual(self.run_step(), "merged")
        self.assertEqual(self.writes, 1)
        sync = prepare_forward_sync(self.repo, self.journal, 1, 2, self.smoke)
        self.assertEqual(sync["kind"], "sync-ready")
        self.assertEqual(_git(self.repo, "show", "-s", "--format=%P", sync["head"]).split(),
                         [self.smoke, self.squashed])
        self.assertEqual(_git(self.repo, "ls-tree", "--name-only", sync["head"]).splitlines(),
                         ["a.txt", "b.txt", "base.txt", "c.txt"])
        self.assertEqual(_git(self.repo, "ls-tree", "--name-only", self.squashed).splitlines(),
                         ["b.txt", "base.txt"])
        self.assertEqual(_git(self.repo, "rev-parse", "origin/smoke"), self.smoke)
        _git(self.repo, "update-ref", "refs/remotes/origin/smoke", sync["head"], self.smoke)
        self.assertEqual(prepare_forward_sync(self.repo, self.journal, 1, 2, sync["head"])["kind"],
                         "already-synced")

    def test_main_moves_after_ci_and_the_squash_is_never_sent(self):
        count = 0

        def read(path):
            nonlocal count
            if path.endswith("/git/ref/heads/main"):
                count += 1
                if count == 4:
                    _git(self.repo, "update-ref", "refs/remotes/origin/main", self.smoke, self.main)
            return self.read_ci(path)

        self.assertEqual(self.run_step(read_ci=read), "waiting-or-stale")
        self.assertEqual(self.writes, 0)
        self.assertIsNone(self.journal.read(1, 2))

    def test_sync_does_not_apply_additional_content_or_advance_changed_refs(self):
        self.assertEqual(self.run_step(), "merged")
        _git(self.repo, "update-ref", "refs/remotes/origin/smoke", self.main, self.smoke)
        self.assertEqual(prepare_forward_sync(self.repo, self.journal, 1, 2, self.smoke)["kind"],
                         "refs-changed")
        self.assertEqual(prepare_forward_sync(self.repo, self.journal, 1, 2, self.main)["kind"],
                         "sync-changes-content")
