"""Full synthetic promotion -> exact scope -> main/smoke dispatch."""
import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from deployment_state import DeploymentState
from deployment_source import approved_scope
from deployment_schedule import run_deployments
from deployment_executor import ProjectExecutor
from promotion_runner import promotion_step


class FullFlowTests(unittest.TestCase):
    def test_promotion_then_poller_delivers_only_accepted_scope(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        store = DeploymentState(Path(temp.name) / 'state.sqlite'); store.initialize()
        base, candidate, smoke, merged = 'd'*40, 'b'*40, 'c'*40, 'f'*40
        baseline = {'id': 'baseline', 'repository_id': 20, 'target': 'main', 'commit': base, 'changes': []}
        store.reserve(baseline); store.transition(baseline, 'reserved', 'running'); store.transition(baseline, 'running', 'succeeded')
        entries = [{'issue': 1, 'sha': 'a'*40}, {'issue': 2, 'sha': candidate}, {'issue': 3, 'sha': smoke}]
        selected = {'kind': 'ready', 'count': 2, 'sha': candidate}
        scope = approved_scope(entries, selected)
        plan = {'main': base, 'smoke': smoke, 'base': base, 'plan': selected, 'accepted_scope': scope}
        current = {'main': base, 'merged': False}
        pr = {'number': 17, 'state': 'open', 'node_id': 'pr-node', 'draft': False,
              'head': {'sha': candidate, 'ref': 'agf-promotion/' + candidate, 'repo': {'node_id': 'repo-node', 'id': 20}},
              'base': {'sha': base, 'ref': 'main', 'repo': {'node_id': 'repo-node', 'id': 20}}, 'mergeable_state': 'clean'}
        def github(path, token, *, body=None):
            root = '/repos/example/repo'
            if path == '/graphql':
                self.assertEqual(store.promotion_receipt(20, candidate)['scope'], scope)
                current.update(main=merged, merged=True)
                return {'data': {'mergePullRequest': {'pullRequest': {'merged': True}}}}, None
            suffix = path.removeprefix(root)
            if suffix == '': return {'id': 20, 'node_id': 'repo-node'}, None
            if suffix == '/branches/main': return {'commit': {'sha': current['main']}}, None
            if suffix == '/branches/smoke': return {'commit': {'sha': smoke}}, None
            if suffix.startswith('/git/matching-refs/heads/'):
                return [{'ref': 'refs/heads/agf-promotion/' + candidate, 'object': {'sha': candidate}}], None
            if suffix.startswith('/pulls?'): return [{'number': 17}], None
            if suffix == '/branches/main/protection':
                return {'required_status_checks': {'strict': True, 'contexts': ['verify']}, 'enforce_admins': {'enabled': True}}, None
            if suffix == '/pulls/17':
                return ({**pr, 'merged': True, 'merge_commit_sha': merged} if current['merged'] else pr), None
            if suffix == '/commits/' + merged:
                return {'sha': merged, 'parents': [{'sha': base}, {'sha': candidate}]}, None
            if '/check-runs?' in suffix:
                sha = suffix.split('/')[2]
                run = {'id': 1, 'name': 'verify', 'app': {'id': 7}, 'head_sha': sha, 'status': 'completed', 'conclusion': 'success'}
                return {'total_count': 1, 'check_runs': [run]}, None
            raise AssertionError(path)
        with store.promotion_guard(20) as ready, patch('promotion_runner.inventory', return_value=plan):
            self.assertEqual(promotion_step(github, 'fixture', 'example', 'repo', deployment_ready=ready), 'merged')
        log = Path(temp.name) / 'executor.jsonl'
        script = ('import json,sys; m=json.load(sys.stdin); r=m["request"]; '
                  f'p={str(log)!r}; '
                  'm["action"] != "deploy" or open(p,"a").write(json.dumps(r)+"\\n"); '
                  'print(json.dumps({"id":r["id"],"target":r["target"],"commit":r["commit"],'
                  '"observed_commit":r["commit"],"status":"succeeded"}))')
        executor = ProjectExecutor((sys.executable, '-c', script))
        config = {'app_id': 1, 'installation_id': 2, 'deployment_state_path': str(store.path), 'projects': [
            {'repository_id': 20, 'owner': 'example', 'repository': 'repo', 'deployment_enabled': True,
             'deployment_executor': '/fixture/executor', 'deployment_checks': [{'context': 'verify', 'app_id': 7}]}]}
        class Stop:
            done = False
            def is_set(self): return self.done
            def wait(self, _): self.done = True
        with patch('deployment_schedule.AppToken', return_value=lambda: 'fixture'), contextlib.redirect_stdout(io.StringIO()):
            run_deployments(Stop(), config, b'fixture', transport=github, executor_factory=lambda _: executor)
            run_deployments(Stop(), config, b'fixture', transport=github, executor_factory=lambda _: executor)
        import json
        received = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual([item['target'] for item in received], ['main', 'smoke'])
        self.assertEqual(received[0]['changes'], ['issue-1', 'issue-2'])
        self.assertNotIn('issue-3', received[0]['changes'])
        self.assertEqual(received[1]['changes'], [])
