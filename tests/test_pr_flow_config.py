import os
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
if os.name != "posix":
    sys.modules.setdefault("fcntl", types.ModuleType("fcntl"))
from mvp_service import validate_config


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        path = os.path.abspath("synthetic")
        self.project = {"repository_id": 20, "trusted_author_ids": [4, 99],
                        "enrolled_at": "2026-11-01T00:00:00Z", "pr_flow_enabled": True,
                        "pr_flow_enrolled_at": "2026-11-08T10:00:00Z", "pr_flow_app_author_id": 99}
        self.config = {"app_id": 1, "installation_id": 2, "port": 8080, "state_path": path,
                       "webhook_secret_path": path, "project_token_path": path, "app_key_path": path,
                       "projects": [self.project]}

    def test_accepts_enabled_handoffs_only_with_trusted_bot(self):
        self.assertIs(validate_config(self.config), self.config)
        self.project["pr_flow_app_author_id"] = 100
        with self.assertRaises(ValueError):
            validate_config(self.config)

    def test_refuses_handoffs_without_status_owner_or_before_onboarding(self):
        self.project["status_enabled"] = False
        with self.assertRaises(ValueError):
            validate_config(self.config)
        self.project["status_enabled"] = True
        self.project["pr_flow_enrolled_at"] = "2026-10-01T00:00:00Z"
        with self.assertRaises(ValueError):
            validate_config(self.config)


if __name__ == "__main__":
    unittest.main()
