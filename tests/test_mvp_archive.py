import copy
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_archive import ARCHIVE_MUTATION, archive_candidates, archive_one
from mvp_github import PROJECT_QUERY, UNARCHIVE_MUTATION


NOW = datetime(2026, 11, 15, tzinfo=timezone.utc)


class FakeGitHub:
    owner = "Owner"
    repository = "Project"
    project_owner = "Owner"
    project_number = 3
    project_token = "pat"

    def __init__(self):
        self.item = {"id": 1, "node_id": "item1", "content_type": "Issue", "archived_at": None,
                     "content": {"node_id": "issue1", "number": 7,
                                 "repository_url": "https://api.github.com/repos/Owner/Project",
                                 "state": "closed", "closed_at": "2026-11-01T00:00:00Z"}}
        self.issue = {"number": 7, "node_id": "issue1", "state": "closed",
                      "closed_at": "2026-11-01T00:00:00Z"}
        self.status = "done"
        self.writes = []
        self.reopen_on_archive = False
        self.reclose_on_archive = False

    def app_token(self):
        return "app"

    def _project_items(self):
        return [copy.deepcopy(self.item)]

    def _batch_done_items(self):
        return {"item1"} if self.status == "done" else set()

    def transport(self, path, token, *, body=None):
        if path == "/repos/Owner/Project/issues/7" and token == "app":
            return copy.deepcopy(self.issue), None
        if path == "/users/Owner/projectsV2/3/items/1" and token == "pat":
            return copy.deepcopy(self.item), None
        raise AssertionError(path)

    def _graphql(self, query, variables):
        if query == PROJECT_QUERY:
            field = {"id": "field", "name": "Status", "dataType": "SINGLE_SELECT",
                     "options": [{"name": "done", "id": "d"}, {"name": "smoke", "id": "s"}]}
            value = {"name": self.status, "optionId": "d" if self.status == "done" else "s",
                     "field": {"id": "field"}}
            return {"user": {"projectV2": {"id": "project1"}}, "node": {"id": "item1",
                    "isArchived": self.item["archived_at"] is not None,
                    "project": {"id": "project1", "statusField": field}, "status": value}}
        if query == ARCHIVE_MUTATION:
            self.writes.append("archive")
            self.item["archived_at"] = "2026-11-15T00:00:00Z"
            if self.reopen_on_archive:
                self.issue["state"] = "open"
            if self.reclose_on_archive:
                self.issue["closed_at"] = "2026-11-15T00:00:00Z"
            return {"archiveProjectV2Item": {"item": {"id": "item1"}}}
        if query == UNARCHIVE_MUTATION:
            self.writes.append("unarchive")
            self.item["archived_at"] = None
            return {"unarchiveProjectV2Item": {"item": {"id": "item1"}}}
        raise AssertionError(query)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.github = FakeGitHub()
        self.candidate = (7, 1, "item1")

    def test_exact_14_days_and_both_close_reasons_and_handed_off(self):
        for reason in ("completed", "not_planned"):
            for labels in ([], ["handed-off"]):
                self.github.item["content"].update({"state_reason": reason, "labels": labels})
                self.assertEqual(archive_candidates(self.github, NOW), [self.candidate])
        self.github.item["content"]["closed_at"] = "2026-11-01T00:00:01Z"
        self.assertEqual(archive_candidates(self.github, NOW), [])

    def test_requires_closed_and_done(self):
        self.github.status = "smoke"
        self.assertEqual(archive_candidates(self.github, NOW), [])
        self.github.status = "done"
        self.github.item["content"]["state"] = "open"
        self.assertEqual(archive_candidates(self.github, NOW), [])

    def test_eligible_card_archives_once_and_readback_confirms(self):
        self.assertEqual(archive_one(self.github, self.candidate, NOW), "archived")
        self.assertEqual(archive_one(self.github, self.candidate, NOW), "skipped")
        self.assertEqual(self.github.writes, ["archive"])

    def test_reopen_during_archive_restores_same_card(self):
        self.github.reopen_on_archive = True
        self.assertEqual(archive_one(self.github, self.candidate, NOW), "changed")
        self.assertEqual(self.github.writes, ["archive", "unarchive"])
        self.assertIsNone(self.github.item["archived_at"])

    def test_reclose_during_archive_restarts_the_14_day_period(self):
        self.github.reclose_on_archive = True
        self.assertEqual(archive_one(self.github, self.candidate, NOW), "changed")
        self.assertEqual(self.github.writes, ["archive", "unarchive"])
        self.assertIsNone(self.github.item["archived_at"])

    def test_reopen_between_the_two_reads_aborts_before_write(self):
        original = self.github.transport
        count = 0
        def changed(path, token, *, body=None):
            nonlocal count
            if path == "/repos/Owner/Project/issues/7":
                count += 1
                if count == 2:
                    self.github.issue["state"] = "open"
            return original(path, token, body=body)
        self.github.transport = changed
        self.assertEqual(archive_one(self.github, self.candidate, NOW), "skipped")
        self.assertEqual(self.github.writes, [])

    def test_lost_archive_response_is_resolved_by_fresh_state(self):
        original = self.github._graphql
        def lost(query, variables):
            result = original(query, variables)
            if query == ARCHIVE_MUTATION:
                raise TimeoutError("synthetic")
            return result
        self.github._graphql = lost
        with self.assertRaises(TimeoutError):
            archive_one(self.github, self.candidate, NOW)
        self.github._graphql = original
        self.assertEqual(archive_one(self.github, self.candidate, NOW), "skipped")
        self.assertEqual(self.github.writes, ["archive"])

    def test_issue_reopened_before_write_is_not_archived(self):
        self.github.issue["state"] = "open"
        self.assertEqual(archive_one(self.github, self.candidate, NOW), "skipped")
        self.assertEqual(self.github.writes, [])

    def test_status_changed_before_write_is_not_archived(self):
        self.github.status = "smoke"
        self.assertEqual(archive_one(self.github, self.candidate, NOW), "skipped")
        self.assertEqual(self.github.writes, [])


if __name__ == "__main__":
    unittest.main()
