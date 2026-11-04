import copy
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "src"))


@unittest.skipUnless(os.name == "posix", "Probe host is POSIX")
class ProbeTests(unittest.TestCase):
    def test_one_issue_probe_preserves_uncertain_write_without_retry(self):
        import one_issue_probe as probe
        class FakeGitHub:
            writes = 0
            def __init__(self, **_):
                self.snapshot = {"complete": True, "state": "OPEN", "status": "audit",
                                 "created_at": "2026-11-02T00:00:00Z", "comments": [], "latest_reopen": None}
            def read(self, *_):
                return copy.deepcopy(self.snapshot)
            def set_status(self, *_):
                FakeGitHub.writes += 1
                raise TimeoutError("synthetic")
        with tempfile.TemporaryDirectory() as directory:
            config = {"app_id": 9, "installation_id": 10, "state_path": str(Path(directory) / "unused.sqlite"),
                      "app_key_path": "synthetic", "project_token_path": "synthetic", "projects": [{"repository_id": 20,
                      "owner": "Owner", "repository": "Repo", "project_owner": "Owner", "project_number": 3,
                      "enrolled_at": "2026-11-01T00:00:00Z", "trusted_author_ids": [10]}]}
            with patch.object(probe, "_load", return_value=config), patch.object(probe, "read_private_file", return_value=b"synthetic"), \
                 patch.object(probe, "AppToken", return_value=lambda: "synthetic"), patch.object(probe, "GitHub", FakeGitHub), \
                 patch.object(sys, "argv", ["probe", "config", "20", "7"]), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(probe.main(), 1)
            self.assertIn('"probe_state_preserved": true', output.getvalue())
            self.assertEqual(FakeGitHub.writes, 1)
            self.assertEqual(len(list(Path(directory).glob("flow-one-issue-*"))), 1)
