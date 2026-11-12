import copy
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_decision import STATUSES
from mvp_errors import read_failure, format_read_failure
from mvp_github import (PROJECT_BATCH_QUERY, PROJECT_ID_QUERY, PROJECT_QUERY, STATUS_MUTATION,
                        ARCHIVED_QUERY, UNARCHIVE_MUTATION, GitHub)


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.item = {"node_id": "item1", "content_type": "Issue", "archived_at": None,
                     "content": {"node_id": "issue1", "number": 7,
                                 "repository_url": "https://api.github.com/repos/Owner/Project"}}
        self.items = [self.item]
        self.link = None
        self.status = "needs-design"
        self.batch = None
        self.archived = []

    def __call__(self, path, token, *, body=None):
        self.calls.append((path, token, body))
        if path == "/repos/Owner/Project":
            return {"id": 20, "full_name": "Owner/Project"}, None
        if path == "/repos/Owner/Project/issues/7":
            return {"number": 7, "node_id": "issue1", "state": "open", "created_at": "2026-11-02T00:00:00Z",
                    "updated_at": "2026-11-02T01:00:00Z"}, None
        if path.startswith("/repos/Owner/Project/issues?") and "state=open" in path:
            return [], None
        if path.startswith("/repos/Owner/Project/issues?"):
            return [{"number": 8, "created_at": "2026-11-02T00:00:00Z"},
                    {"number": 9, "created_at": "2026-10-02T00:00:00Z"},
                    {"number": 11, "created_at": "2026-11-01T00:00:00Z"},
                    {"number": 10, "created_at": "2026-11-02T00:00:00Z", "pull_request": {}}], None
        if "/issues/7/comments?" in path or "/issues/7/events?" in path:
            return [], None
        if path.startswith("/users/Owner/projectsV2/3/items?"):
            return copy.deepcopy(self.items), self.link
        if path == "/users/Owner/projectsV2/3/items/1" and self.archived:
            return copy.deepcopy(self.archived[0]), None
        if path == "/graphql":
            query = body["query"]
            if query == PROJECT_ID_QUERY:
                return {"data": {"user": {"projectV2": {"id": "project1"}}}}, None
            if query == ARCHIVED_QUERY:
                nodes = [{"id": item["node_id"], "fullDatabaseId": "1", "isArchived": True}
                         for item in self.archived]
                return {"data": {"user": {"projectV2": {"id": "project1", "items": {
                    "nodes": nodes, "pageInfo": {"hasNextPage": False, "endCursor": None}}}}}}, None
            if query == UNARCHIVE_MUTATION:
                item = self.archived.pop(0)
                item["archived_at"] = None
                self.items.append(item)
                return {"data": {"unarchiveProjectV2Item": {"item": {"id": item["node_id"]}}}}, None
            if query == PROJECT_BATCH_QUERY and self.batch is not None:
                return copy.deepcopy(self.batch), None
            if query == PROJECT_QUERY:
                options = [{"name": name, "id": "option-" + name} for name in sorted(STATUSES)]
                field = {"id": "field1", "name": "Status", "dataType": "SINGLE_SELECT", "options": options}
                value = None if self.status is None else {"name": self.status, "optionId": "option-" + self.status,
                                                         "field": {"id": "field1"}}
                return {"data": {"user": {"projectV2": {"id": "project1"}},
                                 "node": {"id": "item1", "isArchived": bool(self.archived),
                                          "project": {"id": "project1", "statusField": field}, "status": value}}}, None
            if query == STATUS_MUTATION:
                return {"data": {"updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "item1"}}}}, None
        raise AssertionError("unexpected fake request: " + path)


class GitHubTests(unittest.TestCase):
    def setUp(self):
        self.transport = FakeTransport()
        self.github = GitHub(repository_id=20, owner="Owner", repository="Project", project_owner="Owner",
                             project_number=3, app_token=lambda: "synthetic-app-token",
                             project_token="synthetic-project-token", transport=self.transport)

    def test_read_binds_repo_issue_card_and_separate_identities(self):
        snapshot = self.github.read(20, 7)
        self.assertEqual((snapshot["state"], snapshot["status"], snapshot["item_id"]), ("OPEN", "needs-design", "item1"))
        for path, token, _ in self.transport.calls:
            self.assertEqual(token, "synthetic-app-token" if path.startswith("/repos/") else "synthetic-project-token")

    def test_write_uses_only_latest_verified_item_and_options(self):
        with self.assertRaises(ValueError):
            self.github.set_status(20, 7, "agent-ready")
        self.github.read(20, 7)
        self.github.set_status(20, 7, "agent-ready")
        mutations = [body for path, _, body in self.transport.calls if path == "/graphql" and body["query"] == STATUS_MUTATION]
        self.assertEqual(mutations[0]["variables"]["item"], "item1")
        self.assertEqual(mutations[0]["variables"]["value"], {"singleSelectOptionId": "option-agent-ready"})
        with self.assertRaises(ValueError):
            self.github.set_status(20, 7, "review")

    def test_issue_change_during_read_has_safe_distinct_diagnostic(self):
        original = self.transport
        count = 0

        def changed(path, token, *, body=None):
            nonlocal count
            value, link = original(path, token, body=body)
            if path == "/repos/Owner/Project/issues/7":
                count += 1
                if count == 2:
                    value["updated_at"] = "2026-11-02T01:00:01Z"
            return value, link

        self.github.transport = changed
        with self.assertRaises(ValueError) as observed:
            self.github.read(20, 7)
        line = format_read_failure(read_failure("snapshot", observed.exception))
        self.assertEqual(line, "FLOW retry: issue-changed stage=snapshot")
        self.assertIsNone(self.github._last)
        with self.assertRaises(ValueError):
            self.github.set_status(20, 7, "agent-ready")

    def test_missing_card_is_distinguished_without_adding_it(self):
        self.transport.items = []
        self.assertTrue(self.github.read(20, 7)["missing_card"])

    def test_archived_private_item_is_matched_by_rest_and_restored_without_duplicate(self):
        self.transport.items = []
        self.transport.archived = [{**copy.deepcopy(self.transport.item), "archived_at": "2026-11-01T00:00:00Z"}]
        snapshot = self.github.read(20, 7)
        self.assertTrue(snapshot["archived_card"])
        with self.assertRaises(ValueError):
            self.github.set_status(20, 7, "needs-design")
        self.github.unarchive(20, 7)
        after = self.github.read(20, 7)
        self.assertFalse(after["archived_card"])
        self.assertEqual(after["item_id"], snapshot["item_id"])
        with self.assertRaises(ValueError):
            self.github.unarchive(20, 7)

    def test_archived_search_collision_cannot_restore_other_issue(self):
        self.transport.items = []
        other = copy.deepcopy(self.transport.item)
        other["archived_at"] = "2026-11-01T00:00:00Z"
        other["content"]["node_id"] = "unrelated"
        self.transport.archived = [other]
        self.assertTrue(self.github.read(20, 7)["missing_card"])

    def test_reconciliation_finds_archived_issue_reopened_since_enrollment(self):
        original = self.transport
        def reopened(path, token, *, body=None):
            if path.startswith("/repos/Owner/Project/issues?"):
                return [{"number": 7, "node_id": "issue1", "state": "open",
                         "created_at": "2026-10-01T00:00:00Z"}], None
            return original(path, token, body=body)
        self.transport.items = []
        self.transport.archived = [{**copy.deepcopy(self.transport.item), "archived_at": "2026-11-01T00:00:00Z"}]
        self.github.transport = reopened
        self.assertEqual(self.github.reconciliation_candidates("2026-11-01T00:00:00Z", set()), [7])

    def test_missing_issue_identity_or_duplicate_never_means_absent(self):
        self.transport.items = [{**self.transport.item, "content": None}]
        with self.assertRaises(ValueError):
            self.github.read(20, 7)
        self.transport.items = [self.transport.item, {**self.transport.item, "node_id": "item2"}]
        with self.assertRaises(ValueError):
            self.github.read(20, 7)

    def test_bad_next_link_fails_closed_and_empty_status_is_supported(self):
        self.transport.link = "bad pagination"
        with self.assertRaises(ValueError):
            self.github.read(20, 7)
        self.transport.link = None
        self.transport.status = None
        self.assertIsNone(self.github.read(20, 7)["status"])

    def test_unknown_repository_and_unsafe_path_are_rejected(self):
        with self.assertRaises(ValueError):
            self.github.read(21, 7)
        with self.assertRaises(ValueError):
            GitHub(repository_id=20, owner="Owner", repository="..", project_owner="Owner", project_number=3,
                   app_token=lambda: "synthetic", project_token="synthetic", transport=self.transport)

    def test_comments_follow_next_link_even_on_short_page(self):
        original = self.transport
        def paginated(path, token, *, body=None):
            if "/issues/7/comments?" in path:
                if path.endswith("&page=1"):
                    return [{"id": 1, "user": {"id": 10}, "body": "a", "created_at": "2026-11-02T00:00:00Z", "updated_at": "2026-11-02T00:00:00Z"}], \
                        '<https://api.github.com/repos/Owner/Project/issues/7/comments?per_page=100&page=2>; rel="next"'
                return [{"id": 2, "user": {"id": 10}, "body": "b", "created_at": "2026-11-02T01:00:00Z", "updated_at": "2026-11-02T01:00:00Z"}], None
            return original(path, token, body=body)
        self.github.transport = paginated
        self.assertEqual([c["id"] for c in self.github.read(20, 7)["comments"]], [1, 2])

    def test_reconciliation_includes_existing_cards_and_new_issues_only(self):
        self.assertEqual(self.github.reconciliation_candidates("2026-11-01T00:00:00Z"), [7, 8, 11])

    def _historical_done(self):
        item = self.transport.item
        item["content"].update({"state": "closed", "created_at": "2026-10-01T00:00:00Z",
                                "updated_at": "2026-10-02T00:00:00Z", "closed_at": "2026-10-02T00:00:00Z"})
        field = {"id": "field1", "name": "Status", "dataType": "SINGLE_SELECT",
                 "options": [{"name": name, "id": "option-" + name} for name in sorted(STATUSES)]}
        node = {"id": "item1", "isArchived": False,
                "status": {"name": "done", "optionId": "option-done", "field": {"id": "field1"}}}
        self.transport.batch = {"data": {"user": {"projectV2": {"id": "project1", "statusField": field,
            "items": {"nodes": [node], "pageInfo": {"hasNextPage": False, "endCursor": "cursor1"}}}}}}
        return node

    def test_batch_skips_only_historical_done_without_checkpoint(self):
        self._historical_done()
        self.assertEqual(self.github.reconciliation_candidates("2026-11-01T00:00:00Z", set()), [8, 11])
        self.assertEqual(self.github.reconciliation_candidates("2026-11-01T00:00:00Z", {7}), [7, 8, 11])
        self.assertEqual(self.github.reconciliation_candidates("2026-11-01T00:00:00Z"), [7, 8, 11])

    def test_batch_retains_reopened_recent_or_ambiguous_items(self):
        node = self._historical_done()
        content = self.transport.item["content"]
        for key, value in (("state", "open"), ("updated_at", "2026-11-02T00:00:00Z"),
                           ("closed_at", None), ("created_at", "invalid"), ("node_id", None)):
            old = content[key]
            content[key] = value
            self.assertIn(7, self.github.reconciliation_candidates("2026-11-01T00:00:00Z", set()), key)
            content[key] = old
        node["status"]["name"] = "smoke"
        node["status"]["optionId"] = "option-smoke"
        self.assertIn(7, self.github.reconciliation_candidates("2026-11-01T00:00:00Z", set()))
        node["status"]["name"] = "done"
        node["status"]["optionId"] = "wrong"
        self.assertIn(7, self.github.reconciliation_candidates("2026-11-01T00:00:00Z", set()))

    def test_incomplete_or_duplicate_batch_falls_back_to_full_scan(self):
        node = self._historical_done()
        page = self.transport.batch["data"]["user"]["projectV2"]["items"]
        page["nodes"].append(copy.deepcopy(node))
        self.assertIn(7, self.github.reconciliation_candidates("2026-11-01T00:00:00Z", set()))
        page["nodes"].pop()
        page["pageInfo"] = {"hasNextPage": True, "endCursor": None}
        self.assertIn(7, self.github.reconciliation_candidates("2026-11-01T00:00:00Z", set()))
        self.transport.batch = None
        self.assertIn(7, self.github.reconciliation_candidates("2026-11-01T00:00:00Z", set()))

    def test_batch_consumes_every_page(self):
        node = self._historical_done()
        original = self.transport
        def paginated(path, token, *, body=None):
            if path == "/graphql" and body["query"] == PROJECT_BATCH_QUERY:
                result = copy.deepcopy(original.batch)
                page = result["data"]["user"]["projectV2"]["items"]
                if body["variables"]["after"] is None:
                    page["nodes"] = []
                    page["pageInfo"] = {"hasNextPage": True, "endCursor": "next"}
                else:
                    page["nodes"] = [node]
                return result, None
            return original(path, token, body=body)
        self.github.transport = paginated
        self.assertEqual(self.github.reconciliation_candidates("2026-11-01T00:00:00Z", set()), [8, 11])


if __name__ == "__main__":
    unittest.main()
