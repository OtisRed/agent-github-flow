import copy
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_decision import STATUSES
from mvp_github import ADD_MUTATION, PROJECT_ID_QUERY, PROJECT_QUERY, STATUS_MUTATION, GitHub


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.item = {"node_id": "item1", "content_type": "Issue", "archived_at": None,
                     "content": {"node_id": "issue1", "number": 7,
                                 "repository_url": "https://api.github.com/repos/Owner/Project"}}
        self.items = [self.item]
        self.link = None
        self.status = "needs-design"

    def __call__(self, path, token, *, body=None):
        self.calls.append((path, token, body))
        if path == "/repos/Owner/Project":
            return {"id": 20, "full_name": "Owner/Project"}, None
        if path == "/repos/Owner/Project/issues/7":
            return {"number": 7, "node_id": "issue1", "state": "open", "created_at": "2026-11-02T00:00:00Z",
                    "updated_at": "2026-11-02T01:00:00Z"}, None
        if path.startswith("/repos/Owner/Project/issues?"):
            return [{"number": 8, "created_at": "2026-11-02T00:00:00Z"},
                    {"number": 9, "created_at": "2026-10-02T00:00:00Z"},
                    {"number": 10, "created_at": "2026-11-02T00:00:00Z", "pull_request": {}}], None
        if "/issues/7/comments?" in path or "/issues/7/events?" in path:
            return [], None
        if path.startswith("/users/Owner/projectsV2/3/items?"):
            return copy.deepcopy(self.items), self.link
        if path == "/graphql":
            query = body["query"]
            if query == PROJECT_ID_QUERY:
                return {"data": {"user": {"projectV2": {"id": "project1"}}}}, None
            if query == PROJECT_QUERY:
                options = [{"name": name, "id": "option-" + name} for name in sorted(STATUSES)]
                field = {"id": "field1", "name": "Status", "dataType": "SINGLE_SELECT", "options": options}
                value = None if self.status is None else {"name": self.status, "optionId": "option-" + self.status,
                                                         "field": {"id": "field1"}}
                return {"data": {"user": {"projectV2": {"id": "project1"}},
                                 "node": {"id": "item1", "isArchived": False,
                                          "project": {"id": "project1", "statusField": field}, "status": value}}}, None
            if query == STATUS_MUTATION:
                return {"data": {"updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "item1"}}}}, None
            if query == ADD_MUTATION:
                return {"data": {"addProjectV2ItemById": {"item": {"id": "item1"}}}}, None
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

    def test_missing_card_is_distinguished_and_can_be_added(self):
        self.transport.items = []
        self.assertTrue(self.github.read(20, 7)["missing_card"])
        self.github.add_item(20, 7)
        adds = [body for path, _, body in self.transport.calls if path == "/graphql" and body["query"] == ADD_MUTATION]
        self.assertEqual(adds[0]["variables"], {"project": "project1", "content": "issue1"})

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
        self.assertEqual(self.github.reconciliation_candidates("2026-11-01T00:00:00Z"), [7, 8])


if __name__ == "__main__":
    unittest.main()
