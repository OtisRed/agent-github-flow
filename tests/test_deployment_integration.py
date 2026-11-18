"""End-to-end synthetic source -> scope -> executor -> promotion gate."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from deployment_source import approved_scope, verify_head_and_ci
from deployment_state import DeploymentState
from deployment_worker import run_deployment_once
from deployment_dispatch import bootstrap_current_main, dispatch_current


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.store = DeploymentState(Path(temp.name) / 'state.sqlite'); self.store.initialize()
        self.commit = 'f'*40
        self.head = self.commit
        self.run = {'id': 1, 'name': 'verify', 'app': {'id': 7}, 'head_sha': self.commit,
                    'status': 'completed', 'conclusion': 'success'}
        self.entries = [{'issue': 1, 'sha': 'a'*40}, {'issue': 2, 'sha': 'b'*40}, {'issue': 3, 'sha': 'c'*40}]
        self.plan = {'kind': 'ready', 'count': 2, 'sha': 'b'*40}

    def transport(self, path, token):
        if '/branches/' in path:
            return {'commit': {'sha': self.head}}, None
        return {'total_count': 1, 'check_runs': [self.run]}, None

    def test_approved_scope_reaches_executor_and_current_version_unblocks(self):
        scope = approved_scope(self.entries, self.plan)
        request = {'id': 'main-promoted', 'repository_id': 20, 'target': 'main',
                   'commit': self.commit, 'changes': scope['changes']}
        calls = []
        def execute(req):
            calls.append(req['changes'])
            return {'id': req['id'], 'target': req['target'], 'commit': req['commit'],
                    'observed_commit': req['commit'], 'status': 'succeeded'}
        verify = lambda req: verify_head_and_ci(self.transport, 'fixture', 'example', 'repo',
                                                 req['target'], req['commit'], (('verify', 7),))
        self.assertEqual(run_deployment_once(self.store, request, verify, execute), 'succeeded')
        self.assertEqual(calls, [['issue-1', 'issue-2']])
        with self.store.promotion_guard(20) as ready:
            self.assertTrue(ready(self.commit)); self.assertFalse(ready('e'*40))
        self.assertEqual(run_deployment_once(self.store, request, verify, execute), 'succeeded')
        self.assertEqual(len(calls), 1)

    def test_stale_or_failed_ci_never_dispatches(self):
        request = {'id': 'smoke', 'repository_id': 20, 'target': 'smoke', 'commit': self.commit, 'changes': []}
        verify = lambda req: verify_head_and_ci(self.transport, 'fixture', 'example', 'repo',
                                                 req['target'], req['commit'], (('verify', 7),))
        self.run['conclusion'] = 'failure'
        self.assertEqual(run_deployment_once(self.store, request, verify, lambda _: self.fail('unexpected')), 'not-verified')
        self.assertIsNone(self.store.get(20))

    def test_persisted_promotion_receipt_drives_actual_dispatch(self):
        base, candidate = 'd'*40, 'b'*40
        baseline = {'id': 'baseline', 'repository_id': 20, 'target': 'main', 'commit': base, 'changes': []}
        self.store.reserve(baseline); self.store.transition(baseline, 'reserved', 'running'); self.store.transition(baseline, 'running', 'succeeded')
        scope = approved_scope(self.entries, self.plan)
        inventory = {'main': base, 'plan': self.plan, 'accepted_scope': scope}
        with self.store.promotion_guard(20) as ready:
            self.assertTrue(ready(base)); ready.capture(inventory, 17)
        def github(path, token):
            if path == '/repos/example/repo': return {'id': 20}, None
            if path.endswith('/branches/main'): return {'commit': {'sha': self.commit}}, None
            if path.endswith('/commits/' + self.commit):
                return {'sha': self.commit, 'parents': [{'sha': base}, {'sha': candidate}]}, None
            if path.endswith('/pulls/17'):
                return {'number': 17, 'merged': True, 'merge_commit_sha': self.commit,
                        'base': {'ref': 'main', 'repo': {'id': 20}},
                        'head': {'ref': 'agf-promotion/' + candidate, 'sha': candidate, 'repo': {'id': 20}}}, None
            if '/check-runs?' in path: return {'total_count': 1, 'check_runs': [self.run]}, None
            raise AssertionError(path)
        received = []
        def execute(req):
            received.append(req)
            return {'id': req['id'], 'target': req['target'], 'commit': req['commit'],
                    'observed_commit': req['commit'], 'status': 'succeeded'}
        execute.status = lambda req: {'id': req['id'], 'target': req['target'], 'commit': req['commit'],
                                      'observed_commit': req['commit'], 'status': 'succeeded'}
        self.assertEqual(dispatch_current(github, 'fixture', 'example', 'repo', 20, 'main',
                                          (('verify', 7),), self.store, execute), 'succeeded')
        self.assertEqual(received[0]['changes'], ['issue-1', 'issue-2'])
        self.assertNotIn('issue-3', received[0]['changes'])
        self.assertEqual(dispatch_current(github, 'fixture', 'example', 'repo', 20, 'main',
                                          (('verify', 7),), self.store, execute), 'succeeded')
        self.assertEqual(len(received), 1)

    def test_promotion_without_receipt_never_reaches_executor(self):
        request_count = []
        def github(path, token):
            if path == '/repos/example/repo': return {'id': 20}, None
            if path.endswith('/branches/main'): return {'commit': {'sha': self.commit}}, None
            if path.endswith('/commits/' + self.commit):
                return {'sha': self.commit, 'parents': [{'sha': 'd'*40}, {'sha': 'b'*40}]}, None
            raise AssertionError(path)
        with self.assertRaises(FileNotFoundError):
            dispatch_current(github, 'fixture', 'example', 'repo', 20, 'main', (('verify', 7),), self.store,
                             lambda req: request_count.append(req))
        self.assertEqual(request_count, [])

    def test_runtime_drift_blocks_even_after_a_later_smoke_succeeded(self):
        main = {'id': 'main-baseline', 'repository_id': 20, 'target': 'main', 'commit': self.commit, 'changes': []}
        smoke = {'id': 'smoke-later', 'repository_id': 20, 'target': 'smoke', 'commit': 'c'*40, 'changes': []}
        for req in (main, smoke):
            self.store.reserve(req); self.store.transition(req, 'reserved', 'running'); self.store.transition(req, 'running', 'succeeded')
        def execute(req): self.fail('must not deploy')
        execute.status = lambda req: {'id': req['id'], 'target': req['target'], 'commit': req['commit'],
                                      'observed_commit': 'd'*40, 'status': 'succeeded'}
        self.assertEqual(dispatch_current(self.transport, 'fixture', 'example', 'repo', 20, 'main',
                                          (('verify', 7),), self.store, execute), 'unknown')
        with self.store.promotion_guard(20) as ready:
            self.assertFalse(ready(self.commit))
        with self.assertRaisesRegex(ValueError, 'unresolved'):
            self.store.reserve({**smoke, 'id': 'another'})

    def test_bootstrap_requires_matching_live_version_and_ci(self):
        def execute(_): self.fail('bootstrap must not deploy')
        execute.status = lambda req: {'id': req['id'], 'target': req['target'], 'commit': req['commit'],
                                      'observed_commit': 'b'*40, 'status': 'succeeded'}
        with self.assertRaises(ValueError):
            bootstrap_current_main(self.transport, 'fixture', 'example', 'repo', 20, (('verify', 7),), self.store, execute)
        self.assertIsNone(self.store.get(20))
        execute.status = lambda req: {'id': req['id'], 'target': req['target'], 'commit': req['commit'],
                                      'observed_commit': req['commit'], 'status': 'succeeded'}
        self.assertEqual(bootstrap_current_main(self.transport, 'fixture', 'example', 'repo', 20, (('verify', 7),), self.store, execute), 'succeeded')
        self.assertEqual(self.store.get(20)['request']['commit'], self.commit)

    def test_interrupted_bootstrap_can_resume_without_deploying(self):
        request = {'id': 'bootstrap-main-' + self.commit, 'repository_id': 20,
                   'target': 'main', 'commit': self.commit, 'changes': []}
        self.store.reserve(request)
        def execute(_): self.fail('bootstrap must not deploy')
        execute.status = lambda req: {'id': req['id'], 'target': req['target'], 'commit': req['commit'],
                                      'observed_commit': req['commit'], 'status': 'succeeded'}
        self.assertEqual(bootstrap_current_main(self.transport, 'fixture', 'example', 'repo', 20,
                                                (('verify', 7),), self.store, execute), 'succeeded')
        self.assertEqual(self.store.get_attempt(request)['status'], 'succeeded')

    def test_bootstrap_after_superseded_reservation_still_checks_live_state(self):
        old = {'id': 'bootstrap-main-' + 'a'*40, 'repository_id': 20,
               'target': 'main', 'commit': 'a'*40, 'changes': []}
        self.store.reserve(old); self.store.transition(old, 'reserved', 'superseded')
        def execute(_): self.fail('bootstrap must not deploy')
        execute.status = lambda req: {'id': req['id'], 'target': req['target'], 'commit': req['commit'],
                                      'observed_commit': req['commit'], 'status': 'succeeded'}
        self.assertEqual(bootstrap_current_main(self.transport, 'fixture', 'example', 'repo', 20,
                                                (('verify', 7),), self.store, execute), 'succeeded')
        self.assertEqual(self.store.get(20)['request']['commit'], self.commit)
