import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from selective_promotion_candidate import CandidateError, build_candidate
from selective_promotion_plan import plan_selective


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], encoding="utf-8",
                                   stderr=subprocess.PIPE).strip()


class CandidateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name)
        git(self.repo, "init", "--initial-branch=main")
        git(self.repo, "config", "user.name", "AGF test")
        git(self.repo, "config", "user.email", "agf@example.invalid")
        self.main = self.commit("base.txt", "base\n")
        git(self.repo, "switch", "-c", "smoke")
        self.a = self.commit("a.txt", "not accepted\n")
        git(self.repo, "switch", "-c", "topic-b")
        self.commit("b.txt", "accepted\n")
        git(self.repo, "switch", "smoke")
        git(self.repo, "merge", "--no-ff", "topic-b", "-m", "Integrate B")
        self.b = git(self.repo, "rev-parse", "HEAD")
        self.smoke = self.commit("c.txt", "waiting for A\n")
        git(self.repo, "update-ref", "refs/remotes/origin/main", self.main)
        git(self.repo, "update-ref", "refs/remotes/origin/smoke", self.smoke)
        refs = {"main": self.main, "smoke": self.smoke}
        entries = [{"issue": n, "pr": n + 10, "cycle": n + 100, "sha": sha,
                    "body": f"Refs #{n}", "merged_at": "2026-11-24T00:00:00Z"}
                   for n, sha in enumerate((self.a, self.b, self.smoke), 1)]
        entries[-1]["body"] += "\nDepends-on: #1"
        issues = {str(n): {"state": "closed", "status": "done", "cycle": n + 100,
                           "prs": [n + 10], "published": None,
                           "closed_at": "2026-11-25T00:00:00Z"} for n in (1, 2, 3)}
        issues["1"]["state"] = "open"
        self.plan = plan_selective({"repository_id": 7, "before": refs, "after": dict(refs),
                                    "entries": entries, "issues": issues, "complete": True})

    def commit(self, name, content):
        (self.repo / name).write_text(content, encoding="utf-8")
        git(self.repo, "add", "--", name)
        git(self.repo, "commit", "-m", name)
        return git(self.repo, "rev-parse", "HEAD")

    def test_candidate_contains_only_b_and_is_reproducible(self):
        workdirs = []

        def check(repo, sha):
            workdirs.append(repo)
            self.assertEqual(git(repo, "rev-parse", "HEAD"), sha)
            self.assertEqual(git(repo, "show", "-s", "--format=%P", sha), self.main)
            self.assertEqual(git(repo, "ls-tree", "--name-only", sha).splitlines(), ["b.txt", "base.txt"])
            self.assertEqual((repo / "b.txt").read_text(encoding="utf-8"), "accepted\n")

        result = build_candidate(self.repo, self.plan, {"12": "merge"}, check)
        self.assertEqual(result, build_candidate(self.repo, self.plan, {"12": "merge"}, check))
        self.assertEqual([source["sha"] for source in result["sources"]], [self.b])
        self.assertTrue(all(not path.exists() for path in workdirs))
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), self.smoke)

    def test_squash_requires_explicit_method_and_rebase_is_blocked(self):
        # A's single-parent commit models a GitHub squash with verified metadata.
        self.plan["selected"] = [{"issue": 1, "cycle": 101, "prs": [{"pr": 11, "sha": self.a}]}]
        for method in ({}, {"11": "rebase"}, {"11": "merge"}):
            with self.subTest(method=method), self.assertRaisesRegex(CandidateError, "merge-method"):
                build_candidate(self.repo, self.plan, method, lambda *_: self.fail("Ran checks"))
        build_candidate(self.repo, self.plan, {"11": "squash"}, lambda repo, _: self.assertTrue(
            (repo / "a.txt").exists()))

    def test_conflicting_delta_blocks_before_checks(self):
        git(self.repo, "switch", "main")
        conflicting = self.commit("b.txt", "different content in main\n")
        git(self.repo, "update-ref", "refs/remotes/origin/main", conflicting)
        self.plan["main"] = conflicting
        with self.assertRaisesRegex(CandidateError, "delta-failed:12"):
            build_candidate(self.repo, self.plan, {"12": "merge"}, lambda *_: self.fail("Ran checks"))
        self.assertEqual((self.repo / "b.txt").read_text(encoding="utf-8"), "different content in main\n")

    def test_main_changed_while_checks_ran(self):
        def advance_main(*_):
            git(self.repo, "update-ref", "refs/remotes/origin/main", self.a)
        with self.assertRaisesRegex(CandidateError, "refs-changed-during-checks"):
            build_candidate(self.repo, self.plan, {"12": "merge"}, advance_main)

    def test_failed_or_mutating_checks_invalidate_the_candidate(self):
        def fail(*_):
            raise subprocess.CalledProcessError(1, ["test"])
        with self.assertRaisesRegex(CandidateError, "git-or-check-failed"):
            build_candidate(self.repo, self.plan, {"12": "merge"}, fail)

        def edit(repo, _):
            (repo / "b.txt").write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(CandidateError, "candidate-changed-during-checks"):
            build_candidate(self.repo, self.plan, {"12": "merge"}, edit)
