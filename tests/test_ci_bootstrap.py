"""Checks for the CI starting point and its fail-closed admission wrapper."""

import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CiBootstrapTests(unittest.TestCase):
    def test_template_cannot_report_success_without_project_tests(self):
        template = (ROOT / 'skills/github-flow/assets/ci-template.yml').read_text(encoding='utf-8')
        self.assertLess(template.index('name: Wait for flow admission'), template.index('name: Check out event revision'))
        self.assertIn('wait-admission@' + '0' * 40, template)
        self.assertIn('run: exit 1', template)
        self.assertIn('persist-credentials: false', template)

    def test_action_points_to_existing_shared_waiter_and_invalid_input_fails(self):
        action_path = ROOT / '.github/actions/wait-admission'
        action = (action_path / 'action.yml').read_text(encoding='utf-8')
        self.assertIn('scripts/wait_admission.py', action)
        self.assertIn('github.event.pull_request.head.sha', action)
        self.assertIn('inputs.app-id', action)
        waiter = (action_path / '../../../scripts/wait_admission.py').resolve()
        self.assertTrue(waiter.is_file())
        env = {**os.environ, 'GITHUB_REPOSITORY': 'owner/repo', 'PR_HEAD_SHA': 'a' * 40,
               'FLOW_APP_ID': '0', 'GH_TOKEN': 'synthetic-not-a-token'}
        result = subprocess.run([sys.executable, str(waiter)], env=env, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('flow admission: unavailable', result.stdout)
        self.assertNotIn('synthetic-not-a-token', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
