import contextlib
import io
import sys
import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from promotion_schedule import run_promotions
from deployment_state import DeploymentState


class StopAfterTwoWaits:
    def __init__(self):
        self.waits = 0

    def is_set(self):
        return self.waits >= 2

    def wait(self, _seconds):
        self.waits += 1


class PromotionScheduleTests(unittest.TestCase):
    def test_incomplete_night_is_reported(self):
        stop = StopAfterTwoWaits()
        config = {'app_id': 1, 'installation_id': 2, 'projects': [
            {'repository_id': 3, 'owner': 'example', 'repository': 'repo', 'promotion_enabled': True}]}
        output = io.StringIO()
        with patch('promotion_schedule.AppToken', return_value=lambda: 'synthetic-token'), \
                patch('promotion_schedule.promotion_step', return_value='waiting-checks'), \
                patch('promotion_schedule.datetime') as clock, contextlib.redirect_stderr(output):
            clock.now.side_effect = [SimpleNamespace(hour=4), SimpleNamespace(hour=5)]
            run_promotions(stop, config, b'not-a-key')
        self.assertIn('FLOW attention: promotion-incomplete repo=3', output.getvalue())

    def test_open_issue_wait_is_not_an_error(self):
        stop = StopAfterTwoWaits()
        config = {'app_id': 1, 'installation_id': 2, 'projects': [
            {'repository_id': 3, 'owner': 'example', 'repository': 'repo', 'promotion_enabled': True}]}
        output = io.StringIO()
        with patch('promotion_schedule.AppToken', return_value=lambda: 'synthetic-token'), \
                patch('promotion_schedule.promotion_step', return_value='waiting'), \
                patch('promotion_schedule.datetime') as clock, contextlib.redirect_stderr(output):
            clock.now.side_effect = [SimpleNamespace(hour=4), SimpleNamespace(hour=5)]
            run_promotions(stop, config, b'not-a-key')
        self.assertEqual(output.getvalue(), '')

    def test_guard_checks_live_version_before_promotion(self):
        with tempfile.TemporaryDirectory() as folder:
            store = DeploymentState(Path(folder) / 'state'); store.initialize()
            req = {'id': 'baseline', 'repository_id': 3, 'target': 'main', 'commit': 'a'*40, 'changes': []}
            store.reserve(req); store.transition(req, 'reserved', 'running'); store.transition(req, 'running', 'succeeded')
            config = {'app_id': 1, 'installation_id': 2, 'deployment_state_path': str(store.path), 'projects': [
                {'repository_id': 3, 'owner': 'example', 'repository': 'repo', 'promotion_enabled': True,
                 'deployment_guarded': True, 'deployment_executor': '/fixture/executor'}]}
            executor = SimpleNamespace(status=lambda r: {'id': r['id'], 'target': r['target'], 'commit': r['commit'],
                                                         'observed_commit': 'b'*40, 'status': 'succeeded'})
            def step(_transport, _token, _owner, _repo, *, deployment_ready):
                return 'merged' if deployment_ready('a'*40) else 'deployment-blocked'
            output = io.StringIO()
            with patch('promotion_schedule.AppToken', return_value=lambda: 'fixture'), \
                    patch('promotion_schedule.trusted_executor', return_value=executor), \
                    patch('promotion_schedule.promotion_step', side_effect=step), \
                    patch('promotion_schedule.datetime') as clock, contextlib.redirect_stderr(output):
                clock.now.side_effect = [SimpleNamespace(hour=4), SimpleNamespace(hour=5)]
                run_promotions(StopAfterTwoWaits(), config, b'fixture')
            self.assertIn('promotion-deployment-blocked', output.getvalue())


if __name__ == '__main__':
    unittest.main()
