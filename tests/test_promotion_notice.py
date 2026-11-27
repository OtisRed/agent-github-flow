import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_errors import GitHubRequestError
from promotion_notice import notice_body, publish_promotion_notices
from selective_promotion_merge import SelectiveMergeJournal


class PromotionNoticeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.db = Path(directory.name, "state.sqlite")
        self.project = {"repository_id": 1, "owner": "Owner", "repository": "repo",
                        "promotion_notice_since": "2026-11-26T03:00:00Z", "admission_sync_bot_id": 7}
        self.manifest = {"sources": [{"issue": 3, "cycle": 4, "pr": 2}, {"issue": 3, "cycle": 4, "pr": 6}]}
        self.comments = []
        self.posts = 0
        self.closure = 4
        self.squash = "a" * 40
        self.merged_at = "2026-11-26T03:00:00Z"
        self.failure = None
        journal = SelectiveMergeJournal(self.db)
        self.assertTrue(journal.reserve(1, 5, self.manifest))
        self.assertTrue(journal.confirm(1, 5, self.squash))

    def transport(self, path, token, *, body=None):
        if path == "/graphql":
            return {"data": {"repository": {"pullRequest": {"number": 5, "merged": True,
                     "mergeCommit": {"oid": self.squash}}}}}, None
        suffix = path.removeprefix("/repos/Owner/repo/")
        if suffix == "pulls/5":
            return {"number": 5, "merged": True, "merged_at": self.merged_at,
                    "base": {"ref": "main", "repo": {"id": 1}}}, None
        if suffix == "git/ref/heads/main":
            return {"object": {"sha": self.squash}}, None
        if suffix == "issues/3":
            return {"number": 3, "state": "closed", "state_reason": "completed",
                    "created_at": "2026-11-24T00:00:00Z", "closed_at": "2026-11-25T00:00:00Z"}, None
        if suffix.startswith("issues/3/events?"):
            return [{"id": self.closure, "event": "closed", "created_at": "2026-11-25T00:00:00Z"}], None
        if suffix.startswith("issues/3/comments?"):
            return list(self.comments), None
        if suffix == "issues/3/comments":
            self.posts += 1
            if self.failure != "lost-without-comment":
                self.comments.append({"body": body["body"], "user": {"type": "Bot", "id": 7}})
            if self.failure:
                raise GitHubRequestError("timeout")
            return self.comments[-1], None
        raise AssertionError(path)

    def publish(self):
        return publish_promotion_notices(self.transport, "fixture", self.project, SelectiveMergeJournal(self.db),
                                         self.manifest, 5, self.squash, lambda _: "done")

    def test_lost_response_and_restart_recover_without_duplicate(self):
        self.failure = "lost-after-post"
        self.assertFalse(self.publish())
        self.assertTrue(self.publish())
        self.assertTrue(self.publish())
        self.assertEqual(self.posts, 1)
        self.assertEqual(self.comments[0]["body"], notice_body("Owner", "repo", 4, 5, self.squash))

    def test_absence_after_uncertain_send_does_not_authorize_retry(self):
        self.failure = "lost-without-comment"
        self.assertFalse(self.publish())
        self.assertFalse(self.publish())
        self.assertEqual(self.posts, 1)

    def test_old_promotion_and_reclosed_issue_do_not_create_notice(self):
        self.merged_at = "2026-11-26T02:59:59Z"
        self.assertTrue(self.publish())
        self.merged_at = self.project["promotion_notice_since"]
        self.closure = 8
        self.assertTrue(self.publish())
        self.assertEqual(self.posts, 0)

    def test_conflicting_notice_from_same_app_blocks_a_second_comment(self):
        self.comments.append({"body": notice_body("Owner", "repo", 4, 5, "b" * 40),
                              "user": {"id": 7, "type": "Bot"}})
        self.assertFalse(self.publish())
        self.assertEqual(self.posts, 0)
