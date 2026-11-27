import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from archive_promotion import read_archive_promotion
from mvp_store import APPLICATION_ID


class ArchivePromotionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "state.sqlite"
        self.project = dict(owner="Owner", repository="repo", repository_id=1, promotion_enabled=True)
        self.main, self.smoke, self.source, self.base, self.tree = (char * 40 for char in "abcde")
        self.pr = dict(number=2, state="closed", merged_at="2026-11-24T01:00:00Z", body="Refs #3",
                       base={"ref": "smoke", "repo": {"id": 1}}, merge_commit_sha=self.source)
        self.closure = {"id": 4, "event": "closed", "created_at": "2026-11-24T02:00:00Z"}
        self.list_path = "pulls?state=all&base=smoke&sort=created&direction=asc&per_page=100&page="
        self.data = {
            "": {"id": 1, "full_name": "Owner/repo"},
            "git/ref/heads/main": {"object": {"sha": self.main}},
            "git/ref/heads/smoke": {"object": {"sha": self.smoke}},
            "issues/3": {"number": 3, "state": "closed", "state_reason": "completed",
                         "created_at": "2026-11-24T00:00:00Z", "closed_at": self.closure["created_at"]},
            "issues/3/events?per_page=100&page=1": [self.closure],
            self.list_path + "1": [self.pr],
            f"compare/{self.source}...{self.smoke}?per_page=1": {"merge_base_commit": {"sha": self.source}},
            f"compare/{self.source}...{self.main}?per_page=1": {"merge_base_commit": {"sha": self.source}},
            f"git/commits/{self.main}": {"sha": self.main, "tree": {"sha": self.tree},
                                         "parents": [{"sha": self.base}]},
        }

    def transport(self, path, _token, *, body=None):
        if path == "/graphql":
            self.assertTrue(body["query"].startswith("query"))
            self.assertEqual(body["variables"]["number"], 2)
            return {"data": {"repository": {"pullRequest": {
                "number": 2, "merged": True, "mergeCommit": {"oid": self.source}}}}}, None
        self.assertIsNone(body)
        self.assertTrue(path == "/repos/Owner/repo" or path.startswith("/repos/Owner/repo/"))
        return self.data[path.removeprefix("/repos/Owner/repo").lstrip("/")], None

    def observe(self, status="done", transport=None):
        return read_archive_promotion(3, self.project, self.state, transport or self.transport, "test",
                                      lambda _: status)

    def selective(self, *, cycle=4, sha=None, confirmed=True):
        self.project["promotion_mode"] = "selective"
        source = dict(issue=3, cycle=cycle, pr=2, sha=sha or self.source, method="merge")
        manifest = dict(repository_id=1, main=self.base, smoke=self.smoke, candidate="f" * 40,
                        tree=self.tree, sources=[source])
        with closing(sqlite3.connect(self.state)) as db, db:
            db.execute(f"pragma application_id={APPLICATION_ID}")
            db.execute("create table attempt (repo, pr, manifest, result)")
            db.execute("insert into attempt values (1, 5, ?, ?)",
                       (json.dumps(manifest), self.main if confirmed else None))

    def test_prefix_requires_every_current_source_in_main(self):
        self.assertEqual(self.observe()["source_prs"], [{"pr": 2, "sha": self.source}])
        more = "7" * 40
        self.data[self.list_path + "1"].append(dict(self.pr, number=6, merge_commit_sha=more))
        self.data[f"compare/{more}...{self.smoke}?per_page=1"] = {"merge_base_commit": {"sha": more}}
        self.data[f"compare/{more}...{self.main}?per_page=1"] = {"merge_base_commit": {"sha": self.base}}
        self.assertEqual(self.observe()["reason"], "source-not-on-main")

    def test_two_sources_at_the_same_merge_are_ambiguous(self):
        self.data[self.list_path + "1"].append(dict(self.pr, number=6))
        self.assertEqual(self.observe()["reason"], "ambiguous-source-merge")

    def test_prefix_resolves_missing_rest_merge_commit(self):
        self.pr["merge_commit_sha"] = None
        self.assertEqual(self.observe()["kind"], "confirmed")

    def test_selective_matches_current_cycle_and_source_without_source_on_main(self):
        self.selective()
        del self.data[f"compare/{self.source}...{self.main}?per_page=1"]
        result = self.observe()
        self.assertEqual((result["kind"], result["promotion_pr"], result["squash"]),
                         ("confirmed", 5, self.main))

    def test_selective_blocks_pending_or_missing_history(self):
        self.selective(confirmed=False)
        self.assertEqual(self.observe()["reason"], "promotion-not-confirmed")
        self.state.unlink()
        self.assertEqual(self.observe()["reason"], "evidence-unavailable")

    def test_selective_blocks_history_from_old_closed_cycle(self):
        self.selective(cycle=8)
        self.assertEqual(self.observe()["reason"], "promotion-not-confirmed")

    def test_selective_blocks_incomplete_or_different_source_set(self):
        self.selective(sha="9" * 40)
        self.assertEqual(self.observe()["reason"], "source-set-changed")

    def test_open_or_missing_source_blocks(self):
        self.pr["state"] = "open"
        self.assertEqual(self.observe()["reason"], "open-source-pr")
        self.data[self.list_path + "1"] = []
        self.assertEqual(self.observe()["reason"], "no-source-pr")

    def test_missing_done_and_changed_cycle_block(self):
        self.assertEqual(self.observe(status="smoke")["reason"], "issue-not-completed")

        def transport(path, token, *, body=None):
            result = self.transport(path, token, body=body)
            if f"/compare/{self.source}...{self.main}" in path:
                self.closure["id"] = 8
            return result

        self.assertEqual(self.observe(transport=transport)["reason"], "observation-changed")


    def cleanup(self, scope):
        self.project["trusted_author_ids"] = [7]
        self.data["issues/3/comments?per_page=100&page=1"] = [
            {"id": 14, "user": {"id": 7, "type": "User"},
             "created_at": "2026-11-24T03:00:00Z", "updated_at": "2026-11-24T03:00:00Z",
             "body": f"[ARCHIVE-CLEANUP]\nCycle: 4\nScope: {scope}\nWorktrees: not-created"
                     "\nBranches: not-created\nTemporary: not-created\nEnvironment: not-created"}
        ]
        return read_archive_promotion(3, self.project, self.state, self.transport, "test", lambda _: "done",
                                      with_cleanup=True)

    def test_two_proofs_are_bound_to_same_issue_cycle(self):
        result = self.cleanup("code")
        self.assertEqual((result["kind"], result["cycle"], result["cleanup"]["comment_id"]), ("confirmed", 4, 14))
        self.data[f"compare/{self.source}...{self.main}?per_page=1"] = {"merge_base_commit": {"sha": self.base}}
        self.assertEqual(self.cleanup("code")["reason"], "source-not-on-main")

    def test_explicit_no_code_can_confirm_only_without_sources(self):
        self.assertEqual(self.cleanup("no-code")["reason"], "cleanup-scope-mismatch")
        self.data[self.list_path + "1"] = []
        self.assertEqual(self.cleanup("no-code")["promotion"], "not-applicable")

    def test_existing_selective_receipt_prevents_no_code_confirmation(self):
        self.selective()
        self.data[self.list_path + "1"] = []
        self.assertEqual(self.cleanup("no-code")["reason"], "source-set-changed")
