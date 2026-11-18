import contextlib
import io
import sys
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from deployment_schedule import run_deployments
from deployment_state import DeploymentState


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
