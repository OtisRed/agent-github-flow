import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pr_flow_github import read_candidates
from mvp_github import GitHub
from pr_flow_decision import draft_message


class FakeClient:
    owner, repository, repository_id = "OtisRed", "repo", 20

    def __init__(self, events):
        self.events = events
        self.requests = []

    def app_token(self):
        return "synthetic"

    def _rest_pages(self, path, token):
        self.requests.append(path)
        return self.events

    def transport(self, path, token):
        self.requests.append(path)
        number = int(path.rsplit("/", 1)[1])
        return ({"number": number, "body": "Refs #7", "state": "open", "merged": False,
                 "created_at": "2026-11-08T10:02:00Z", "updated_at": "2026-11-08T10:03:00Z", "merged_at": None,
                 "head": {"ref": "issue/7", "repo": {"id": 20}},
                 "base": {"ref": "smoke", "repo": {"id": 20}}}, None)


def reference(number, repository="https://api.github.com/repos/OtisRed/repo"):
    return {"event": "cross-referenced", "source": {"issue": {
        "number": number, "repository_url": repository, "pull_request": {"url": f"{repository}/pulls/{number}"}}}}


class CandidateTests(unittest.TestCase):
    def test_filters_other_repositories_and_deduplicates(self):
        client = FakeClient([reference(12), reference(12), reference(99, "https://api.github.com/repos/else/repo"),
                             {"event": "closed"}])
        result = read_candidates(client, 7)
        self.assertEqual([item["number"] for item in result], [12])
        self.assertTrue(result[0]["same_repository"])
        self.assertEqual(len(client.requests), 2)

    def test_incomplete_identity_fails_instead_of_selecting_a_pr(self):
        event = reference(12)
        del event["source"]["issue"]["repository_url"]
        with self.assertRaises(ValueError):
            read_candidates(FakeClient([event]), 7)

    def test_foreign_branch_does_not_pass_as_same_repository(self):
        client = FakeClient([reference(12)])
        old = client.transport
        def foreign(path, token):
            value, link = old(path, token)
            value["head"]["repo"]["id"] = 21
            return value, link
        client.transport = foreign
        self.assertFalse(read_candidates(client, 7)[0]["same_repository"])

    def test_incomplete_pr_does_not_allow_selection_of_other_prs(self):
        client = FakeClient([reference(12), reference(13)])
        old = client.transport
        def incomplete(path, token):
            value, link = old(path, token)
            if value["number"] == 13:
                value["merged"] = None
            return value, link
        client.transport = incomplete
        with self.assertRaises(ValueError):
            read_candidates(client, 7)

    def test_merged_pr_does_not_require_removed_rest_sha_field(self):
        client = FakeClient([reference(12)])
        old = client.transport
        def merged(path, token):
            value, link = old(path, token)
            value.update(state="closed", merged=True, merged_at="2026-11-08T10:04:00Z")
            value.pop("merge_commit_sha", None)
            return value, link
        client.transport = merged
        self.assertTrue(read_candidates(client, 7)[0]["merged"])

    def test_merged_pr_without_merge_time_is_rejected(self):
        client = FakeClient([reference(12)])
        old = client.transport
        def merged(path, token):
            value, link = old(path, token)
            value.update(state="closed", merged=True, merged_at=None)
            return value, link
        client.transport = merged
        with self.assertRaises(ValueError):
            read_candidates(client, 7)

    def test_publishes_only_standard_handoff_to_configured_repo(self):
        calls = []
        def transport(path, token, *, body=None):
            calls.append((path, token, body))
            return {"id": 123}, None
        client = GitHub(repository_id=20, owner="OtisRed", repository="repo", project_owner="OtisRed",
                        project_number=3, app_token=lambda: "read", project_token="project",
                        pr_flow_token=lambda: "write", transport=transport)
        client.post_flow(7, draft_message(12))
        self.assertEqual(calls, [("/repos/OtisRed/repo/issues/7/comments", "write", {"body": draft_message(12)})])
        with self.assertRaises(ValueError):
            client.post_flow(7, "not a FLOW comment")


if __name__ == "__main__":
    unittest.main()
