import contextlib
import io
import queue
import sys
import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

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
    def test_daytime_quickfix_runs_only_in_selected_repo_and_coalesces_duplicates(self):
        work = queue.SimpleQueue()
        work.put(3)
        work.put(3)
        config = {'app_id': 1, 'installation_id': 2, 'projects': [
            {'repository_id': n, 'owner': 'example', 'repository': str(n), 'promotion_enabled': True}
            for n in (3, 4)]}
        with patch('promotion_schedule.AppToken', return_value=lambda: 'fixture'), \
                patch('promotion_schedule.promotion_step', return_value='waiting') as step, \
                patch('promotion_schedule.datetime') as clock:
            clock.now.return_value = SimpleNamespace(hour=12)
            run_promotions(StopAfterTwoWaits(), config, b'fixture', quickfix_queue=work)
        self.assertEqual(step.call_count, 1)
        self.assertEqual(step.call_args.args[-1], '3')

    def test_switches_modes_at_restart_for_nightly_and_quickfix(self):
        config = {'app_id': 1, 'installation_id': 2, 'projects': [
            {'repository_id': 3, 'owner': 'example', 'repository': 'target', 'promotion_enabled': True},
            {'repository_id': 4, 'owner': 'example', 'repository': 'other', 'promotion_enabled': True},
        ]}
        target = config['projects'][0]
        for mode in ('prefix', 'paused', 'selective', 'prefix'):
            target['promotion_mode'] = mode
            for hour in (4, 12):
                with self.subTest(mode=mode, hour=hour):
                    work = queue.SimpleQueue()
                    for repository_id in (3, 3, 4, 99):
                        work.put(repository_id)
                    stop = StopAfterTwoWaits()
                    stop.waits = 1
                    with patch('promotion_schedule.AppToken', return_value=lambda: 'fixture') as tokens, \
                            patch('promotion_schedule.promotion_step', return_value='waiting') as prefix, \
                            patch('promotion_schedule.datetime') as clock:
                        selective = Mock(return_value='waiting')
                        clock.now.return_value = SimpleNamespace(hour=hour)
                        run_promotions(stop, config, b'fixture', quickfix_queue=work, selective_step=selective)
                    self.assertEqual([call.args[-1] for call in prefix.call_args_list],
                                     ['target', 'other'] if mode == 'prefix' else ['other'])
                    self.assertEqual(selective.call_count, int(mode == 'selective'))
                    self.assertEqual([call.args[2] for call in tokens.call_args_list],
                                     [4] if mode == 'paused' else [3, 4])

    def test_missing_selective_executor_does_not_fall_back_or_request_token(self):
        config = {'app_id': 1, 'installation_id': 2, 'projects': [
            {'repository_id': 3, 'owner': 'example', 'repository': 'target',
             'promotion_enabled': True, 'promotion_mode': 'selective'},
        ]}
        output = io.StringIO()
        with patch('promotion_schedule.AppToken') as token, \
                patch('promotion_schedule.promotion_step') as prefix, \
                patch('promotion_schedule.datetime') as clock, contextlib.redirect_stderr(output):
            clock.now.return_value = SimpleNamespace(hour=4)
            run_promotions(StopAfterTwoWaits(), config, b'fixture')
        token.assert_not_called()
        prefix.assert_not_called()
        self.assertEqual(output.getvalue(), 'FLOW attention: promotion-selective-unavailable repo=3\n')

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
