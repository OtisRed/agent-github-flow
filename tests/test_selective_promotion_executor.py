import io
import json
import tempfile
import unittest
from contextlib import nullcontext
from email.message import Message
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_errors import GitHubRequestError
from selective_promotion_executor import read_job_log, run_prepared_promotion
from selective_promotion_merge import SelectiveMergeJournal


JOB = "/repos/test/repo/actions/jobs/12/logs"


class TestSelectivePromotionExecutor(unittest.TestCase):
    def redirect(self, target):
        headers = Message()
        headers["Location"] = target
        return HTTPError("https://api.github.com" + JOB, 302, "Found", headers, io.BytesIO())

    def test_signed_log_redirect_does_not_forward_token(self):
        log = io.BytesIO(b"test log")
        log.status = 200
        opener = Mock(side_effect=[
            self.redirect("https://productionresultssa31.blob.core.windows.net/log?sig=example"), log,
        ])
        self.assertEqual(read_job_log(JOB, "fixture", opener=opener), "test log")
        first, second = [call.args[0] for call in opener.call_args_list]
        self.assertEqual(first.get_header("Authorization"), "Bearer fixture")
        self.assertIsNone(second.get_header("Authorization"))

    def test_untrusted_redirect_is_never_contacted(self):
        for target in ("http://productionresultssa31.blob.core.windows.net/log?sig=example",
                       "https://productionresultssa31.blob.core.windows.net.example.org/log?sig=example"):
            with self.subTest(target=target):
                opener = Mock(side_effect=self.redirect(target))
                with self.assertRaises(GitHubRequestError):
                    read_job_log(JOB, "fixture", opener=opener)
                opener.assert_called_once()

    def test_rejects_foreign_manifest_before_contacting_github(self):
        project = {"repository_id": 1, "selective_request_path": "fixture"}
        staged = {"manifest": {"repository_id": 2, "main": "a"*40, "smoke": "b"*40,
                               "candidate": "c"*40, "tree": "d"*40,
                               "sources": [{"pr": 2, "issue": 1, "cycle": 7, "sha": "e"*40, "method": "merge"}]},
                  "pr": 3, "policy": {}, "run_id": 12, "job_id": 11}
        transport = Mock()
        with tempfile.TemporaryDirectory() as tmp, patch(
            "selective_promotion_executor.read_private_file", return_value=json.dumps(staged).encode()
        ):
            path = Path(tmp) / "selective.sqlite"
            self.assertEqual(run_prepared_promotion(transport, "fixture", project,
                                                    project_token="fixture", journal_path=path), "blocked")
            self.assertFalse(path.exists())
        transport.assert_not_called()

    def test_routes_only_the_two_staged_jobs_through_the_log_reader(self):
        project = {"repository_id": 2, "selective_request_path": "fixture", "owner": "test",
                   "repository": "repo", "project_owner": "test", "project_number": 1}
        staged = {"manifest": {"repository_id": 2, "main": "a"*40, "smoke": "b"*40,
                               "candidate": "c"*40, "tree": "d"*40,
                               "sources": [{"pr": 2, "issue": 1, "cycle": 7, "sha": "e"*40, "method": "merge"}]},
                  "pr": 3, "policy": {"workflow_change": {"job_id": 13}}, "run_id": 11, "job_id": 12}
        trusted = "/repos/test/repo/actions/jobs/13/logs"
        unstaged = "/repos/test/repo/actions/jobs/14/logs"
        transport = Mock(return_value=({"standard": True}, None))

        def verify(*_args, read_ci, **_kwargs):
            self.assertEqual(read_ci(unstaged[1:]), {"standard": True})
            self.assertEqual(read_ci(JOB[1:]), "ordinary log")
            self.assertEqual(read_ci(trusted[1:]), "trusted log")
            return "waiting-or-stale"

        with tempfile.TemporaryDirectory() as tmp, patch(
            "selective_promotion_executor.read_private_file", return_value=json.dumps(staged).encode()
        ), patch("selective_promotion_executor.verify_and_squash", side_effect=verify), patch(
            "selective_promotion_executor.read_job_log", side_effect=["ordinary log", "trusted log"]
        ) as log_reader:
            self.assertEqual(run_prepared_promotion(transport, "fixture", project, project_token="fixture",
                                                    journal_path=Path(tmp) / "selective.sqlite"), "waiting-checks")
        self.assertEqual([item.args for item in log_reader.call_args_list],
                         [(JOB, "fixture"), (trusted, "fixture")])
        transport.assert_called_once_with(unstaged, "fixture")

    def test_deployment_guard_blocks_new_attempt_but_allows_reconciliation(self):
        project = {"repository_id": 2, "selective_request_path": "fixture", "owner": "test",
                   "repository": "repo", "project_owner": "test", "project_number": 1}
        staged = {"manifest": {"repository_id": 2, "main": "a"*40, "smoke": "b"*40,
                               "candidate": "c"*40, "tree": "d"*40,
                               "sources": [{"pr": 2, "issue": 1, "cycle": 7, "sha": "e"*40, "method": "merge"}]},
                  "pr": 3, "policy": {}, "run_id": 12, "job_id": 11}
        with tempfile.TemporaryDirectory() as tmp, patch(
            "selective_promotion_executor.read_private_file", return_value=json.dumps(staged).encode()
        ), patch("selective_promotion_executor.verify_and_squash", return_value="unknown") as verify:
            path = Path(tmp) / "selective.sqlite"
            ready = Mock(return_value=False)
            guard = Mock(side_effect=lambda: nullcontext(ready))
            def run():
                return run_prepared_promotion(Mock(), "fixture", project, project_token="fixture",
                                              journal_path=path, deployment_guard=guard)

            self.assertEqual(run(), "deployment-blocked")
            ready.assert_called_once_with(staged["manifest"]["main"])
            verify.assert_not_called()
            journal = SelectiveMergeJournal(path)
            self.assertIsNone(journal.read(2, 3))
            journal.reserve(2, 3, staged["manifest"])
            self.assertEqual(run(), "unknown")
            guard.assert_called_once()
            verify.assert_called_once()
