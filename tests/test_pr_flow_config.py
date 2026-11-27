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

    def test_promotion_modes_are_explicit_and_preserve_legacy_opt_in(self):
        from promotion_schedule import promotion_mode

        self.assertEqual(promotion_mode(self.project), 'paused')
        self.project['promotion_enabled'] = True
        self.assertEqual(promotion_mode(self.project), 'prefix')
        for mode in ('prefix', 'paused', 'selective'):
            self.project['promotion_mode'] = mode
            self.assertIs(validate_config(self.config), self.config)
            self.assertEqual(promotion_mode(self.project), mode)
        self.project['deployment_guarded'] = True
        with self.assertRaisesRegex(ValueError, 'requires selective deployment evidence'):
            validate_config(self.config)
        self.project['deployment_guarded'] = False
        self.project['promotion_enabled'] = False
        self.assertEqual(promotion_mode(self.project), 'paused')
        self.project['promotion_mode'] = 'unknown'
        with self.assertRaisesRegex(ValueError, 'Invalid promotion mode'):
            validate_config(self.config)

    def test_deployment_guard_requires_explicit_state_and_promotion(self):
        self.project['deployment_guarded'] = True
        with self.assertRaises(ValueError):
            validate_config(self.config)
        self.config['deployment_state_path'] = os.path.abspath('deployment-state')
        self.project['promotion_enabled'] = True
        self.project['deployment_enabled'] = True
        self.project['deployment_executor'] = os.path.abspath('synthetic-executor')
        self.project['deployment_checks'] = [{'context': 'verify', 'app_id': 10}]
        self.assertIs(validate_config(self.config), self.config)
        self.config['deployment_state_path'] = 'relative'
        with self.assertRaises(ValueError):
            validate_config(self.config)


    def test_guarded_selective_main_accepts_paused_but_not_prefix_or_shared_database(self):
        self.config['deployment_state_path'] = os.path.abspath('deployment-state')
        self.project.update(promotion_enabled=True, promotion_mode='selective',
                            deployment_enabled=True, deployment_guarded=True, deployment_main_only=True,
                            deployment_promotion_source='selective',
                            deployment_executor=os.path.abspath('synthetic-executor'),
                            deployment_checks={'main': [{'context': 'verify', 'app_id': 10}]})
        self.assertIs(validate_config(self.config), self.config)
        self.project['promotion_mode'] = 'prefix'
        with self.assertRaisesRegex(ValueError, 'selective or paused'):
            validate_config(self.config)
        self.project['promotion_mode'] = 'paused'
        self.assertIs(validate_config(self.config), self.config)
        self.config['deployment_state_path'] = self.config['state_path']
        with self.assertRaisesRegex(ValueError, 'separate databases'):
            validate_config(self.config)


    def test_smoke_only_allows_nightly_promotion_and_rejects_production_guard(self):
        self.project.update(deployment_enabled=True, deployment_smoke_only=True,
                            deployment_executor=os.path.abspath('synthetic-executor'),
                            deployment_checks=[{'context':'verify', 'app_id':10}])
        with self.assertRaises(ValueError):
            validate_config(self.config)
        self.config['deployment_state_path'] = os.path.abspath('deployment-state')
        self.assertIs(validate_config(self.config), self.config)
        self.project['promotion_enabled'] = True
        self.assertIs(validate_config(self.config), self.config)
        self.project['deployment_guarded'] = True
        with self.assertRaisesRegex(ValueError, 'cannot guard production promotion'):
            validate_config(self.config)

    def test_per_branch_checks_require_all_and_only_enabled_targets(self):
        verify = {'context': 'verify', 'app_id': 10}
        build = {'context': 'build-chef-test', 'app_id': 10}
        self.config['deployment_state_path'] = os.path.abspath('deployment-state')
        self.project.update(deployment_enabled=True, promotion_enabled=True, deployment_guarded=True,
                            deployment_executor=os.path.abspath('synthetic-executor'),
                            deployment_checks={'smoke': [verify, build], 'main': [verify]})
        self.assertIs(validate_config(self.config), self.config)
        self.project['deployment_checks'] = {'smoke': [verify, build]}
        with self.assertRaises(ValueError):
            validate_config(self.config)
        self.project.update(deployment_smoke_only=True, deployment_guarded=False)
        self.assertIs(validate_config(self.config), self.config)
        self.project['deployment_checks']['smoke'] = [verify, verify]
        with self.assertRaisesRegex(ValueError, 'Duplicate deployment checks'):
            validate_config(self.config)


if __name__ == "__main__":
    unittest.main()
