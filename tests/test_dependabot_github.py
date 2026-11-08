import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from dependabot_github import DependabotGitHub
from dependabot_plan import BOT_ID


class Client:
    owner, repository, repository_id = "OtisRed", "repo", 20

    def __init__(self, pr):
        self.pr = pr

    def _rest_pages(self, path, token, **kwargs):
        return [copy.deepcopy(self.pr)] if path.endswith("/pulls") else []


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.pr = {"number": 12, "state": "open", "draft": False, "body": "Dependabot notes\n",
                   "node_id": "PR_test", "user": {"id": BOT_ID, "login": "dependabot[bot]", "type": "Bot"},
                   "head": {"repo": {"id": 20}}, "base": {"ref": "main", "repo": {"id": 20}}}
        self.mutations = []
        self.gateway = DependabotGitHub(Client(self.pr), lambda: "stub", transport=self.transport)

    def transport(self, path, token, *, body=None):
        if path.endswith("/pulls/12"):
            return copy.deepcopy(self.pr), None
        if path == "/graphql":
            query = body["query"]
            if "convertPullRequestToDraft" in query:
                self.mutations.append("draft")
                self.pr["draft"] = True
                return {"data": {"convertPullRequestToDraft": {"pullRequest": {"id": "PR_test"}}}}, None
            self.mutations.append(body["variables"])
            self.pr["base"]["ref"] = body["variables"]["base"]
            self.pr["body"] = body["variables"]["body"]
            return {"data": {"updatePullRequest": {"pullRequest": {"id": "PR_test"}}}}, None
        raise AssertionError(path)

    def test_draft_before_retarget_and_preserve_notes(self):
        self.assertEqual(self.gateway.candidates(), [12])
        self.gateway.normalize(copy.deepcopy(self.pr), 13)
        self.assertEqual(self.mutations[0], "draft")
        self.assertEqual(self.mutations[1]["base"], "smoke")
        self.assertEqual(self.mutations[1]["body"], "Dependabot notes\n\nRefs #13\n")

    def test_changed_body_stops_before_update(self):
        original = copy.deepcopy(self.pr)
        original["draft"] = True
        self.pr["draft"] = True
        self.pr["body"] = "Changed by owner"
        with self.assertRaises(ValueError):
            self.gateway.normalize(original, 13)
        self.assertEqual(self.mutations, [])
