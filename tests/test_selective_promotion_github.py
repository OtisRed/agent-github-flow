import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from selective_promotion_github import observe_candidate


class SelectiveGithubTests(unittest.TestCase):
    def setUp(self):
        main, smoke, head, source = ("a" * 40, "b" * 40, "c" * 40, "d" * 40)
        repo = {"id": 1}
        self.manifest = {"repository_id": 1, "main": main, "smoke": smoke, "candidate": head,
                         "tree": "e" * 40, "sources": [{"pr": 2, "issue": 3, "cycle": 4,
                                                        "sha": source, "method": "merge"}]}
        self.linked = {"number": 2, "state": "closed", "merged_at": "2026-11-24T01:00:00Z",
                       "body": "Refs #3", "base": {"ref": "smoke", "repo": repo}, "merge_commit_sha": source}
        self.responses = {
            "git/ref/heads/main": {"object": {"sha": main}},
            "git/ref/heads/smoke": {"object": {"sha": smoke}},
            "pulls/5": {"number": 5, "state": "open", "draft": False, "mergeable_state": "clean",
                        "base": {"ref": "main", "repo": repo, "sha": main}, "head": {"repo": repo, "sha": head}},
            "issues/3": {"number": 3, "state": "closed", "state_reason": "completed",
                         "created_at": "2026-11-24T00:00:00Z", "closed_at": "2026-11-24T02:00:00Z"},
            "issues/3/events?per_page=100&page=1": [
                {"event": "closed", "id": 4, "created_at": "2026-11-24T02:00:01Z"}],
            "git/commits/" + source: {"sha": source, "parents": [{}, {}]},
            f"compare/{source}...{main}?per_page=1": {"merge_base_commit": {"sha": main}},
            f"compare/{source}...{smoke}?per_page=1": {"merge_base_commit": {"sha": source}},
            "branches/main/protection": {"required_status_checks": {"strict": True,
                                         "checks": [{"context": "verify", "app_id": 8}]},
                                        "enforce_admins": {"enabled": True}},
            "rules/branches/main": [],
        }
        self.list_path = "pulls?state=all&base=smoke&sort=created&direction=asc&per_page=100&page="
        self.responses[self.list_path + "1"] = [self.linked]

    def read(self, path):
        return self.responses[path.removeprefix("repos/Owner/repo/")]

    def observe(self, status="done", read=None):
        return observe_candidate(read or self.read, lambda _: status, "Owner/repo", self.manifest, 5, 8)

    def test_matches_exact_sources_and_reports_independent_blockers(self):
        result = self.observe()
        self.assertEqual(result["blockers"], [])
        self.assertEqual(result["snapshot"]["sources"], self.manifest["sources"])
        self.responses["pulls/5"]["draft"] = True
        self.responses["branches/main/protection"]["required_status_checks"]["strict"] = False
        self.responses["git/ref/heads/smoke"]["object"]["sha"] = "9" * 40
        self.responses[f"compare/{'d' * 40}...{'9' * 40}?per_page=1"] = {"merge_base_commit": {"sha": "d" * 40}}
        self.assertEqual(self.observe()["blockers"],
                         ["draft", "refs-do-not-match-manifest", "main-protection-insufficient"])

    def test_discards_reopened_or_non_done_issue(self):
        self.assertEqual(self.observe(status="review")["reason"], "issue-not-completed")
        self.responses["issues/3/events?per_page=100&page=1"].append(
            {"event": "reopened", "id": 6, "created_at": "2026-11-24T03:00:00Z"})
        self.assertEqual(self.observe()["reason"], "closure-cycle-changed")

    def test_detects_another_pr_in_the_same_cycle_on_a_later_page(self):
        others = [{"number": n, "body": "Refs #8"} for n in range(10, 109)]
        self.responses[self.list_path + "1"].extend(others)
        self.responses[self.list_path + "2"] = [dict(self.linked, number=120)]
        self.assertEqual(self.observe()["reason"], "source-set-changed")

    def test_open_or_ambiguous_source_blocks(self):
        self.responses[self.list_path + "1"].append(dict(self.linked, number=10, state="open"))
        self.assertEqual(self.observe()["reason"], "open-source-pr")
        self.responses[self.list_path + "1"].pop()
        self.linked["body"] += "\nRefs #8"
        self.assertEqual(self.observe()["reason"], "ambiguous-source-link")

    def test_checks_fresh_refs_after_read(self):
        calls = 0

        def moving_main(path):
            nonlocal calls
            if path.endswith("git/ref/heads/main"):
                calls += 1
                if calls == 2:
                    return {"object": {"sha": "9" * 40}}
            return copy.deepcopy(self.read(path))

        self.assertEqual(self.observe(read=moving_main)["reason"], "observation-changed")

    def test_blocks_missing_graph_evidence_and_unverified_squash(self):
        self.responses[f"compare/{'d' * 40}...{'b' * 40}?per_page=1"] = {"merge_base_commit": {"sha": "a" * 40}}
        self.assertEqual(self.observe()["reason"], "source-not-on-smoke")
        self.manifest["sources"][0]["method"] = "squash"
        self.assertEqual(self.observe()["reason"], "unverified-source-method")
