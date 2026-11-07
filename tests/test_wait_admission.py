import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from wait_admission import wait


class AdmissionWaitTests(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 40
        self.run = {"id": 1, "name": "flow-admission", "head_sha": self.sha, "app": {"id": 10},
                    "status": "completed", "conclusion": "success"}

    def get(self, runs):
        def transport(_path, _token):
            return {"total_count": len(runs), "check_runs": runs}, None
        return transport

    def test_success_requires_expected_app_and_commit(self):
        self.assertEqual(wait("owner/repo", self.sha, 10, "token", transport=self.get([self.run])), "success")
        self.assertEqual(wait("owner/repo", self.sha, 11, "token", transport=self.get([self.run]),
                              clock=lambda: 10, timeout=0), "timeout")

    def test_failed_admission_stops_ci(self):
        run = dict(self.run, conclusion="failure")
        self.assertEqual(wait("owner/repo", self.sha, 10, "token", transport=self.get([run])), "failure")

    def test_unavailable_or_truncated_check_list_is_an_error(self):
        def incomplete(_path, _token):
            return {"total_count": 2, "check_runs": [self.run]}, None
        with self.assertRaises(ValueError):
            wait("owner/repo", self.sha, 10, "token", transport=incomplete)


if __name__ == "__main__":
    unittest.main()
