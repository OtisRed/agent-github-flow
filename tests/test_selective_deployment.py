"""Drive confirmed selective deployment through the existing worker and attestor."""
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from deployment_attestation import attest
from deployment_schedule import run_deployments
from deployment_state import DeploymentState
from mvp_store import Store
from selective_promotion_merge import SelectiveMergeJournal


class SelectiveDeploymentTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.state = root / 'controller.sqlite'
        Store(self.state).initialize()
        self.journal = SelectiveMergeJournal(self.state, require_existing=True)
        self.store = DeploymentState(root / 'deployment.sqlite')
        self.store.initialize()
        self.base, self.squash, self.tree, self.candidate = (letter * 40 for letter in 'abcd')
        self.manifest = {'repository_id': 20, 'main': self.base, 'smoke': 'e'*40,
                         'candidate': self.candidate, 'tree': self.tree,
                         'sources': [{'pr': 21, 'issue': 9, 'cycle': 11, 'sha': 'f'*40, 'method': 'merge'}]}
        self.journal.reserve(20, 17, self.manifest)
        self.current = self.squash
        self.parents = [self.base]
        self.actual_tree = self.tree
        self.merge_oid = self.squash
        self.green = True
        baseline = {'id': 'baseline', 'repository_id': 20, 'target': 'main', 'commit': self.base, 'changes': []}
        self.store.reserve(baseline)
        self.store.transition(baseline, 'reserved', 'running')
        self.store.transition(baseline, 'running', 'succeeded')
        self.config = {'app_id': 1, 'installation_id': 2, 'state_path': str(self.state),
                       'deployment_state_path': str(self.store.path), 'projects': [
                           {'repository_id': 20, 'owner': 'example', 'repository': 'repo',
                            'deployment_enabled': True, 'deployment_executor': '/fixture/executor',
                            'deployment_main_only': True, 'deployment_promotion_source': 'selective',
                            'deployment_checks': {'main': [{'context': 'verify', 'app_id': 7}]}}]}
        self.executor = Mock(side_effect=self.deploy)
        self.executor.status.side_effect = self.success

    def github(self, path, _token, *, body=None):
        root = '/repos/example/repo'
        if path == '/graphql':
            self.assertEqual(body['variables']['number'], 17)
            return {'data': {'repository': {'pullRequest': {
                'number': 17, 'merged': True, 'mergeCommit': {'oid': self.merge_oid},
            }}}}, None
        if path == root:
            return {'id': 20}, None
        if path == root + '/branches/main':
            return {'commit': {'sha': self.current}}, None
        if path == root + '/git/commits/' + self.squash:
            return {'sha': self.squash, 'tree': {'sha': self.actual_tree},
                    'parents': [{'sha': parent} for parent in self.parents]}, None
        if path == root + '/pulls/17':
            return {'number': 17, 'merged': True, 'base': {'ref': 'main', 'repo': {'id': 20}},
                    'head': {'sha': self.candidate, 'repo': {'id': 20}}}, None
        if '/check-runs?' in path:
            sha = path.split('/')[5]
            run = {'id': 1, 'name': 'verify', 'app': {'id': 7}, 'head_sha': sha, 'status': 'completed',
                   'conclusion': 'success' if self.green else 'failure'}
            return {'total_count': 1, 'check_runs': [run]}, None
        self.fail(path)

    def success(self, candidate):
        return {**{key: candidate[key] for key in ('id', 'target', 'commit')},
                'observed_commit': candidate['commit'], 'status': 'succeeded'}

    def deploy(self, candidate):
        self.assertTrue(attest(self.config, candidate, 'fixture', self.store, self.github))
        return self.success(candidate)

    def poll(self):
        stop = Mock()
        stop.is_set.side_effect = lambda: bool(stop.wait.called)
        with patch('deployment_schedule.AppToken', return_value=lambda: 'fixture'), redirect_stdout(io.StringIO()):
            run_deployments(stop, self.config, b'fixture', transport=self.github,
                            executor_factory=lambda _: self.executor)

    def test_confirmed_squash_runs_and_reattests_once(self):
        self.journal.confirm(20, 17, self.squash)
        self.poll()
        self.poll()
        self.executor.assert_called_once_with({'id': f'main-{self.squash}', 'repository_id': 20, 'target': 'main',
                                               'commit': self.squash, 'changes': ['issue-9']})
        self.assertEqual(self.store.last_success(20, 'main')['commit'], self.squash)

    def test_pending_squash_cannot_deploy(self):
        self.poll()
        self.executor.assert_not_called()

    def test_wrong_result_or_failed_ci_cannot_deploy(self):
        self.journal.confirm(20, 17, self.squash)
        for field, wrong in [('parents', ['0'*40]), ('actual_tree', '0'*40), ('merge_oid', '0'*40),
                             ('green', False), ('current', '0'*40)]:
            with self.subTest(field=field):
                original = getattr(self, field)
                setattr(self, field, wrong)
                self.poll()
                self.executor.assert_not_called()
                setattr(self, field, original)

    def test_unknown_result_recovers_without_second_invocation(self):
        self.journal.confirm(20, 17, self.squash)
        self.executor.side_effect = TimeoutError
        self.poll()
        self.assertEqual(self.store.unresolved(20)['status'], 'unknown')
        self.poll()
        self.executor.assert_called_once()
        self.assertEqual(self.store.last_success(20, 'main')['commit'], self.squash)

    def test_failed_deployment_keeps_previous_sha_and_blocks_next_promotion(self):
        self.journal.confirm(20, 17, self.squash)
        self.executor.side_effect = lambda request: {**self.success(request), 'status': 'failed',
                                                     'observed_commit': self.base}
        self.poll()
        self.poll()
        self.executor.assert_called_once()
        self.assertEqual(self.store.get(20)['status'], 'failed')
        self.assertEqual(self.store.last_success(20, 'main')['commit'], self.base)
        with self.store.promotion_guard(20) as ready:
            self.assertFalse(ready(self.squash))
