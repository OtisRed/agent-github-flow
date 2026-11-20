import contextlib
import io
import sys
import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from deployment_schedule import run_deployments
from deployment_state import DeploymentState
from promotion_schedule import run_promotions


class OneTurn:
    done = False
    def is_set(self): return self.done
    def wait(self, _): self.done = True


class ScheduleTests(unittest.TestCase):
    def setUp(self):
        self.config = {'app_id': 1, 'installation_id': 2, 'deployment_state_path': '/fixture/state', 'projects': [
            {'deployment_enabled': True, 'repository_id': 3, 'owner': 'example', 'repository': 'repo',
             'deployment_executor': '/fixed/executor', 'deployment_checks': [{'context': 'verify', 'app_id': 4}]}]}

    def test_checks_main_then_smoke_with_fixed_executor(self):
        calls = []
        def dispatch(_transport, _token, _owner, _repo, _id, target, _required, _store, _execute):
            calls.append(target); return 'succeeded'
        with patch('deployment_schedule.DeploymentState', return_value=Mock(get=lambda _: {'status':'succeeded'}, unresolved=lambda _: None)), \
                patch('deployment_schedule.AppToken', return_value=lambda: 'fixture'), \
                patch('deployment_schedule.dispatch_current', side_effect=dispatch), contextlib.redirect_stdout(io.StringIO()):
            run_deployments(OneTurn(), self.config, b'fixture', executor_factory=lambda _: lambda _: None)
        self.assertEqual(calls, ['main', 'smoke'])

    def test_unverified_main_prevents_smoke_dispatch(self):
        calls = []
        def dispatch(_transport, _token, _owner, _repo, _id, target, _required, _store, _execute):
            calls.append(target); return 'not-verified'
        with patch('deployment_schedule.DeploymentState', return_value=Mock(get=lambda _: {'status':'succeeded'}, unresolved=lambda _: None)), \
                patch('deployment_schedule.AppToken', return_value=lambda: 'fixture'), \
                patch('deployment_schedule.dispatch_current', side_effect=dispatch), contextlib.redirect_stdout(io.StringIO()):
            run_deployments(OneTurn(), self.config, b'fixture', executor_factory=lambda _: lambda _: None)
        self.assertEqual(calls, ['main'])

    def test_first_main_baseline_after_smoke_uses_each_branch_checks(self):
        main, smoke = 'a' * 40, 'b' * 40
        self.config['projects'][0]['deployment_checks'] = {
            'main': [{'context': 'verify', 'app_id': 4}],
            'smoke': [{'context': 'verify', 'app_id': 4}, {'context': 'build-chef-test', 'app_id': 4}],
        }
        smoke_request = {'id': 'smoke-' + smoke, 'repository_id': 3,
                         'target': 'smoke', 'commit': smoke, 'changes': []}

        def github(route, _token):
            if route.endswith('/branches/main'):
                return {'commit': {'sha': main}}, {}
            if route.endswith('/branches/smoke'):
                return {'commit': {'sha': smoke}}, {}
            for commit, names in ((main, ('verify',)), (smoke, ('verify', 'build-chef-test'))):
                if f'/commits/{commit}/check-runs?' in route:
                    return {'total_count': len(names), 'check_runs': [
                        {'id': index, 'head_sha': commit, 'name': name, 'app': {'id': 4},
                         'status': 'completed', 'conclusion': 'success'}
                        for index, name in enumerate(names, start=1)]}, {}
            self.fail(f'Unexpected discovery of production promotion scope: {route}')

        executor = Mock()
        executor.status.side_effect = lambda job: {
            **{key: job[key] for key in ('id', 'target', 'commit')},
            'observed_commit': job['commit'], 'status': 'succeeded',
        }
        with tempfile.TemporaryDirectory() as folder:
            store = DeploymentState(Path(folder) / 'state')
            store.initialize()
            store.reserve(smoke_request)
            store.transition(smoke_request, 'reserved', 'running')
            store.transition(smoke_request, 'running', 'succeeded')
            self.config['deployment_state_path'] = str(store.path)
            with patch('deployment_schedule.AppToken', return_value=lambda: 'fixture'), \
                    contextlib.redirect_stdout(io.StringIO()):
                run_deployments(OneTurn(), self.config, b'fixture', transport=github,
                                executor_factory=lambda _: executor)
            self.assertEqual(store.last_success(3, 'main'), {
                'id': 'bootstrap-main-' + main, 'repository_id': 3,
                'target': 'main', 'commit': main, 'changes': [],
            })
            self.assertEqual(store.last_success(3, 'smoke'), smoke_request)
        executor.assert_not_called()
        self.assertEqual([call.args[0]['target'] for call in executor.status.call_args_list],
                         ['main', 'main', 'smoke'])

    def test_smoke_only_dispatches_chef_test_and_keeps_nightly_promotion(self):
        commit = 'a' * 40
        project = self.config['projects'][0]
        project.update(deployment_smoke_only=True, promotion_enabled=True,
                       repository='Jedzenie', deployment_executor='/fixed/chef-test')
        attempted_routes = []

        def github(route, _token):
            attempted_routes.append(route)
            if route == '/repos/example/Jedzenie/branches/smoke':
                return {'commit': {'sha': commit}}, {}
            if route.startswith(f'/repos/example/Jedzenie/commits/{commit}/check-runs?'):
                return {'total_count': 1, 'check_runs': [
                    {'id': 1, 'head_sha': commit, 'name': 'verify', 'app': {'id': 4},
                     'status': 'completed', 'conclusion': 'success'}]}, {}
            raise AssertionError(f'Unexpected deployment lookup: {route}')

        def confirm(job):
            return {key: job[key] for key in ('id', 'target', 'commit')} | {
                'observed_commit': commit, 'status': 'succeeded'}

        chef_test = Mock(side_effect=confirm)
        with tempfile.TemporaryDirectory() as folder:
            state = DeploymentState(Path(folder) / 'state')
            state.initialize()
            self.config['deployment_state_path'] = str(state.path)
            with patch('deployment_schedule.AppToken', return_value=lambda: 'fixture'), \
                    patch('deployment_schedule.bootstrap_current_main') as bootstrap, \
                    patch('promotion_schedule.AppToken', return_value=lambda: 'fixture'), \
                    patch('promotion_schedule.datetime') as clock, \
                    patch('promotion_schedule.promotion_step', return_value='merged') as promote, \
                    contextlib.redirect_stdout(io.StringIO()):
                clock.now.return_value = SimpleNamespace(hour=4)
                factory = Mock(return_value=chef_test)
                run_deployments(OneTurn(), self.config, b'fixture', transport=github, executor_factory=factory)
                run_promotions(OneTurn(), self.config, b'fixture', transport=github)
            bootstrap.assert_not_called()
            factory.assert_called_once_with('/fixed/chef-test')
            request = {'id': 'smoke-' + commit, 'repository_id': 3, 'target': 'smoke',
                       'commit': commit, 'changes': []}
            chef_test.assert_called_once_with(request)
            self.assertTrue(attempted_routes)
            self.assertFalse(any('/branches/main' in route for route in attempted_routes))
            self.assertEqual(state.get_attempt(request)['status'], 'succeeded')
            self.assertIsNone(state.last_success(3, 'main'))
            promote.assert_called_once_with(github, 'fixture', 'example', 'Jedzenie')

    def test_restart_reconciles_only_confirmed_same_attempt(self):
        with tempfile.TemporaryDirectory() as folder:
            state = DeploymentState(Path(folder) / 'state'); state.initialize()
            req = {'id': 'attempt', 'repository_id': 3, 'target': 'main', 'commit': 'a'*40, 'changes': ['issue-1']}
            state.reserve(req); state.transition(req, 'reserved', 'running')
            self.config['deployment_state_path'] = str(state.path)
            class Executor:
                def status(self, request):
                    return {'id': request['id'], 'target': request['target'], 'commit': request['commit'],
                            'observed_commit': request['commit'], 'status': 'succeeded'}
            with patch('deployment_schedule.AppToken', return_value=lambda: 'fixture'), \
                    patch('deployment_schedule.dispatch_current', return_value='succeeded'), contextlib.redirect_stdout(io.StringIO()):
                run_deployments(OneTurn(), self.config, b'fixture', executor_factory=lambda _: Executor())
            self.assertEqual(state.get(3)['status'], 'succeeded')

    def test_stale_reservation_is_superseded_after_branch_moves(self):
        with tempfile.TemporaryDirectory() as folder:
            state = DeploymentState(Path(folder) / 'state'); state.initialize()
            req = {'id': 'smoke-' + 'a'*40, 'repository_id': 3, 'target': 'smoke', 'commit': 'a'*40, 'changes': []}
            state.reserve(req)
            self.config['deployment_state_path'] = str(state.path)
            with patch('deployment_schedule.AppToken', return_value=lambda: 'fixture'), \
                    patch('deployment_schedule.branch_head', return_value='b'*40, create=True), \
                    patch('deployment_schedule.dispatch_current', return_value='succeeded'), contextlib.redirect_stdout(io.StringIO()):
                run_deployments(OneTurn(), self.config, b'fixture', executor_factory=lambda _: lambda _: None)
            self.assertEqual(state.get_attempt(req)['status'], 'superseded')

    def test_current_smoke_reservation_is_retried_before_main(self):
        with tempfile.TemporaryDirectory() as folder:
            state = DeploymentState(Path(folder) / 'state'); state.initialize()
            req = {'id': 'smoke-' + 'a'*40, 'repository_id': 3, 'target': 'smoke', 'commit': 'a'*40, 'changes': []}
            state.reserve(req); self.config['deployment_state_path'] = str(state.path)
            calls = []
            def dispatch(_transport, _token, _owner, _repo, _id, target, _required, _store, _execute):
                calls.append(target)
                if len(calls) == 1:
                    state.transition(req, 'reserved', 'running'); state.transition(req, 'running', 'succeeded')
                return 'succeeded'
            with patch('deployment_schedule.AppToken', return_value=lambda: 'fixture'), \
                    patch('deployment_schedule.branch_head', return_value='a'*40, create=True), \
                    patch('deployment_schedule.dispatch_current', side_effect=dispatch), contextlib.redirect_stdout(io.StringIO()):
                run_deployments(OneTurn(), self.config, b'fixture', executor_factory=lambda _: lambda _: None)
            self.assertEqual(calls[0], 'smoke')
            self.assertEqual(state.get_attempt(req)['status'], 'succeeded')

    def test_branch_lookup_error_preserves_reservation_without_dispatch(self):
        with tempfile.TemporaryDirectory() as folder:
            state = DeploymentState(Path(folder) / 'state'); state.initialize()
            req = {'id': 'smoke-' + 'a'*40, 'repository_id': 3, 'target': 'smoke', 'commit': 'a'*40, 'changes': []}
            state.reserve(req); self.config['deployment_state_path'] = str(state.path)
            with patch('deployment_schedule.AppToken', return_value=lambda: 'fixture'), \
                    patch('deployment_schedule.branch_head', side_effect=OSError('offline')), \
                    patch('deployment_schedule.dispatch_current') as dispatch, contextlib.redirect_stderr(io.StringIO()):
                run_deployments(OneTurn(), self.config, b'fixture', executor_factory=lambda _: lambda _: None)
            self.assertEqual(state.get_attempt(req)['status'], 'reserved')
            dispatch.assert_not_called()

    def test_bad_executor_blocks_only_its_project(self):
        other = {**self.config['projects'][0], 'repository_id': 4, 'deployment_executor': '/fixed/other'}
        self.config['projects'].append(other)
        calls = []
        def factory(path):
            if path.endswith('executor'): raise ValueError('missing')
            return lambda _: None
        def dispatch(_transport, _token, _owner, _repo, repo_id, target, _required, _store, _execute):
            calls.append((repo_id, target)); return 'succeeded'
        with patch('deployment_schedule.DeploymentState', return_value=Mock(get=lambda _: {'status':'succeeded'}, unresolved=lambda _: None)), \
                patch('deployment_schedule.AppToken', return_value=lambda: 'fixture'), \
                patch('deployment_schedule.dispatch_current', side_effect=dispatch), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            run_deployments(OneTurn(), self.config, b'fixture', executor_factory=factory)
        self.assertEqual(calls, [(4, 'main'), (4, 'smoke')])
