import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from selective_forward_sync import publish_forward_sync


class ForwardSyncTests(unittest.TestCase):
    main, smoke = "a" * 40, "b" * 40
    project = {"owner": "Owner", "repository": "repo", "repository_id": 1, "admission_sync_bot_id": 2}

    def test_unprotected_smoke_does_not_fetch_or_write(self):
        def fake(path, token):
            if path.endswith("/git/ref/heads/smoke"):
                return {"object": {"sha": self.smoke}}, None
            if "/compare/" in path:
                return {"status": "diverged"}, None
            if path.endswith("/branches/smoke/protection"):
                return {"required_status_checks": {"strict": False}}, None
            return {"id": 1, "allow_merge_commit": True, "allow_auto_merge": True}, None

        transport, fetch = Mock(side_effect=fake), Mock()
        self.assertEqual(publish_forward_sync(transport, "fixture", self.project, Mock(),
                                              3, self.main, 4, fetch=fetch), "forward-sync-blocked")
        fetch.assert_not_called()
        self.assertTrue(all(not call.kwargs for call in transport.call_args_list))

    def test_already_reachable_is_idempotent(self):
        def fake(path, token):
            if path.endswith("/git/ref/heads/smoke"):
                return {"object": {"sha": self.smoke}}, None
            if "/compare/" in path:
                return {"status": "ahead", "merge_base_commit": {"sha": self.main}}, None
            return {"id": 1, "allow_merge_commit": True, "allow_auto_merge": True}, None

        transport, fetch = Mock(side_effect=fake), Mock()
        self.assertEqual(publish_forward_sync(transport, "fixture", self.project, Mock(),
                                              3, self.main, 4, fetch=fetch), "merged")
        fetch.assert_not_called()
        self.assertTrue(all(not call.kwargs for call in transport.call_args_list))
