import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from deployment_executor import ProjectExecutor
from deployment_retry import requeue_unstarted
from deployment_state import DeploymentState
from deployment_worker import reconcile_deployment, run_deployment_once


class DeploymentRetryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = DeploymentState(Path(temporary.name) / 'agf.sqlite')
        self.store.initialize()
        self.request = {'id': 'main-' + 'a'*40, 'repository_id': 7, 'target': 'main',
                        'commit': 'a'*40, 'changes': ['issue-63']}
        self.success = {'id': self.request['id'], 'target': 'main', 'commit': self.request['commit'],
                        'observed_commit': self.request['commit'], 'status': 'succeeded'}
        self.store.reserve(self.request)
        self.store.transition(self.request, 'reserved', 'running')

    def requeue(self, *, verify=lambda _: True, execute=None, attempt_id=None):
        if execute is None:
            execute = SimpleNamespace(retry_status=lambda request: {'request': request, 'status': 'not-started'})
        return requeue_unstarted(self.store, 7, attempt_id or self.request['id'], verify, execute)

    def test_requeues_same_request_and_keeps_promotion_blocked_until_deploy(self):
        self.store.transition(self.request, 'running', 'unknown')
        with self.assertRaisesRegex(ValueError, 'Previous deployment'):
            self.store.reserve({**self.request, 'id': 'other'})
        script = ("import json,sys; envelope=json.load(sys.stdin); assert envelope['action']=='retry-status'; "
                  "print(json.dumps({'request':envelope['request'],'status':'not-started'}))")
        self.assertEqual(self.requeue(execute=ProjectExecutor((sys.executable, '-c', script))), 'reserved')
        with self.store.promotion_guard(7) as can_promote:
            self.assertFalse(can_promote(self.request['commit']))
        self.assertEqual(run_deployment_once(self.store, self.request, lambda _: True,
                                             lambda _: self.success), 'succeeded')
        with self.store.promotion_guard(7) as can_promote:
            self.assertTrue(can_promote(self.request['commit']))

    def test_refuses_running_and_runtime_status_regression(self):
        with self.assertRaisesRegex(ValueError, 'matching interrupted dispatch'):
            self.requeue()
        self.store.transition(self.request, 'running', 'succeeded')
        self.store.transition(self.request, 'succeeded', 'unknown', 'runtime-unconfirmed')
        with self.assertRaisesRegex(ValueError, 'matching interrupted dispatch'):
            self.requeue()

    def test_refuses_stale_scope_wrong_identity_and_nonpositive_proof(self):
        self.store.transition(self.request, 'running', 'unknown')
        with self.assertRaisesRegex(ValueError, 'No matching'):
            self.requeue(attempt_id='another')
        with self.assertRaisesRegex(ValueError, 'no longer matches'):
            self.requeue(verify=lambda _: False)
        for change in ({'changes': []}, {'commit': 'b'*40}, {'repository_id': 8}):
            executor = SimpleNamespace(retry_status=lambda request: {
                'request': {**request, **change}, 'status': 'not-started'})
            with self.assertRaisesRegex(ValueError, 'No proof'):
                self.requeue(execute=executor)
        executor = SimpleNamespace(retry_status=lambda request: {'request': request, 'status': 'in-progress'})
        with self.assertRaisesRegex(ValueError, 'No proof'):
            self.requeue(execute=executor)
        self.assertEqual(self.store.get(7)['status'], 'unknown')

    def test_concurrent_reconciliation_prevents_requeue(self):
        self.store.transition(self.request, 'running', 'unknown')

        def proof(request):
            reconcile_deployment(self.store, request, self.success)
            return {'request': request, 'status': 'not-started'}

        with self.assertRaisesRegex(ValueError, 'no longer eligible'):
            self.requeue(execute=SimpleNamespace(retry_status=proof))
        self.assertEqual(self.store.get(7)['status'], 'succeeded')
