import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from deployment_state import DeploymentState
from deployment_worker import run_deployment_once, reconcile_deployment
from deployment_executor import ProjectExecutor


class DeploymentWorkerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.store = DeploymentState(Path(temp.name) / 'state.sqlite')
        self.store.initialize()
        self.req = {'id': 'attempt', 'repository_id': 7, 'target': 'main', 'commit': 'a'*40, 'changes': ['A', 'B']}
        self.result = {'id': 'attempt', 'target': 'main', 'commit': 'a'*40, 'observed_commit': 'a'*40, 'status': 'succeeded'}

    def test_verifies_twice_and_duplicate_never_reexecutes(self):
        calls = []
        result = run_deployment_once(self.store, self.req, lambda r: calls.append('verify') or True,
                                     lambda r: calls.append('execute') or self.result)
        self.assertEqual(result, 'succeeded')
        self.assertEqual(calls, ['verify', 'verify', 'execute'])
        self.assertEqual(run_deployment_once(self.store, self.req, lambda r: True,
                                            lambda r: self.fail('must not repeat')), 'succeeded')

    def test_changed_branch_before_dispatch_does_not_execute(self):
        checks = iter([True, False])
        self.assertEqual(run_deployment_once(self.store, self.req, lambda r: next(checks),
                                             lambda r: self.fail('must not run')), 'not-verified')
        self.assertEqual(self.store.get(7)['status'], 'superseded')
        self.assertEqual(self.store.reserve({**self.req, 'id': 'new', 'commit': 'b'*40}), 'reserved')

    def test_superseded_undispatched_request_can_be_revalidated_if_branch_returns(self):
        checks = iter([True, False])
        self.assertEqual(run_deployment_once(self.store, self.req, lambda r: next(checks),
                                             lambda r: self.fail('must not run')), 'not-verified')
        self.assertEqual(run_deployment_once(self.store, self.req, lambda r: True,
                                             lambda r: self.result), 'succeeded')

    def test_unconfirmed_result_blocks_and_requires_exact_reconciliation(self):
        self.assertEqual(run_deployment_once(self.store, self.req, lambda r: True,
                                             lambda r: {**self.result, 'commit': 'b'*40}), 'unknown')
        with self.assertRaisesRegex(ValueError, 'unresolved'):
            self.store.reserve({**self.req, 'id': 'another'})
        with self.assertRaisesRegex(ValueError, 'Unconfirmed'):
            reconcile_deployment(self.store, self.req, {**self.result, 'id': 'another'})
        self.assertEqual(reconcile_deployment(self.store, self.req, self.result), 'succeeded')

    def test_different_running_version_does_not_report_success(self):
        response = {**self.result, 'observed_commit': 'b'*40}
        self.assertEqual(run_deployment_once(self.store, self.req, lambda r: True, lambda r: response), 'unknown')
        self.assertEqual(self.store.get(7)['status'], 'unknown')

    def test_process_death_keeps_running_attempt_until_confirmed(self):
        self.store.reserve(self.req)
        self.store.transition(self.req, 'reserved', 'running')
        reopened = DeploymentState(self.store.path)
        self.assertEqual(run_deployment_once(reopened, self.req, lambda r: True,
                                             lambda r: self.fail('must not replay')), 'running')
        self.assertEqual(reconcile_deployment(reopened, self.req, self.result), 'succeeded')

    def test_real_fixture_process_reports_exact_attempt(self):
        script = ('import json,sys; r=json.load(sys.stdin)["request"]; '
                  'print(json.dumps({"id":r["id"],"target":r["target"],"commit":r["commit"],"observed_commit":r["commit"],"status":"succeeded"}))')
        executor = ProjectExecutor((sys.executable, '-c', script))
        self.assertEqual(run_deployment_once(self.store, self.req, lambda req: True, executor), 'succeeded')
        self.assertEqual(self.store.get(7)['request']['changes'], ['A', 'B'])
