import subprocess
import sys
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from promotion_runner import promotion_step, protection_ready
from deployment_state import DeploymentState
from deployment_source import promoted_scope


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.sha, self.main = 'a' * 40, 'b' * 40
        self.plan = {'main': self.main, 'smoke': self.sha, 'base': self.main,
                     'plan': {'kind': 'ready', 'sha': self.sha, 'count': 1}}
        self.protection = {'required_status_checks': {'strict': True, 'contexts': ['verify']},
                           'enforce_admins': {'enabled': True}}
        self.branch = 'agf-promotion/' + self.sha
        self.rows = {'/branches/main/protection': self.protection, '': {'node_id': 'repo'},
                     '/git/matching-refs/heads/' + self.branch: [
                         {'ref': 'refs/heads/' + self.branch, 'object': {'sha': self.sha}}],
                     '/pulls?state=open&base=main&head=example%3Aagf-promotion%2F' + self.sha + '&per_page=100': [{'number': 7}],
                     '/pulls/7': {'number': 7, 'state': 'open', 'node_id': 'pr', 'draft': False,
                                  'head': {'sha': self.sha, 'ref': self.branch, 'repo': {'node_id': 'repo'}},
                                  'base': {'sha': self.main, 'ref': 'main', 'repo': {'node_id': 'repo'}},
                                  'mergeable_state': 'clean'}}
        self.mutations = []

    def transport(self, path, token, *, body=None):
        if path == '/graphql':
            self.mutations.append(body)
            return {'data': {'createRef': {'ref': {'id': 'ref'}},
                             'createPullRequest': {'pullRequest': {'id': 'pr'}},
                             'mergePullRequest': {'pullRequest': {'merged': True}}}}, None
        return self.rows[path.removeprefix('/repos/example/repo')], None

    def run_step(self):
        return promotion_step(self.transport, 'test-token', 'example', 'repo')

    def test_empty_or_unenforced_checks_do_not_permit_promotion(self):
        for value in ({}, {'required_status_checks': {'strict': True, 'contexts': []}, 'enforce_admins': {'enabled': True}},
                      {'required_status_checks': {'strict': True, 'contexts': ['verify']}, 'enforce_admins': {'enabled': False}}):
            self.assertFalse(protection_ready(value))
        with patch('promotion_runner.inventory', return_value=self.plan):
            self.rows['/branches/main/protection'] = {}
            self.assertEqual(self.run_step(), 'protection-required')
            self.assertFalse(self.mutations)

    def test_creates_one_branch_then_waits_for_another_step(self):
        self.rows['/git/matching-refs/heads/' + self.branch] = []
        with patch('promotion_runner.inventory', return_value=self.plan):
            self.assertEqual(self.run_step(), 'branch-created')
        self.assertEqual(len(self.mutations), 1)

    def test_existing_branch_creates_one_pull_request(self):
        path = '/pulls?state=open&base=main&head=example%3Aagf-promotion%2F' + self.sha + '&per_page=100'
        self.rows[path] = []
        with patch('promotion_runner.inventory', return_value=self.plan):
            self.assertEqual(self.run_step(), 'pull-request-created')
        self.assertEqual(self.mutations[0]['variables'], {'repo': 'repo', 'head': self.branch})

    def test_reopened_first_issue_prevents_all_writes(self):
        waiting = dict(self.plan, plan={'kind': 'waiting', 'reason': 'open-issue'})
        with patch('promotion_runner.inventory', return_value=waiting):
            self.assertEqual(self.run_step(), 'waiting')
        self.assertFalse(self.mutations)

    def test_candidate_without_current_main_never_creates_branch_or_pr(self):
        blocked = dict(self.plan, plan={'kind': 'blocked', 'reason': 'candidate-missing-main'})
        with patch('promotion_runner.inventory', return_value=blocked):
            self.assertEqual(self.run_step(), 'blocked')
        self.assertFalse(self.mutations)

    def test_existing_branch_with_wrong_tip_is_blocked(self):
        self.rows['/git/matching-refs/heads/' + self.branch][0]['object']['sha'] = 'c' * 40
        with patch('promotion_runner.inventory', return_value=self.plan):
            with self.assertRaises(ValueError):
                self.run_step()
        self.assertFalse(self.mutations)

    def test_waits_for_clean_check_status(self):
        self.rows['/pulls/7']['mergeable_state'] = 'unstable'
        with patch('promotion_runner.inventory', return_value=self.plan):
            self.assertEqual(self.run_step(), 'waiting-checks')
        self.assertFalse(self.mutations)

    def test_changed_issue_or_head_blocks_merge(self):
        changed = dict(self.plan, smoke='c' * 40)
        with patch('promotion_runner.inventory', side_effect=[self.plan, changed]):
            self.assertEqual(self.run_step(), 'changed')
        self.assertFalse(self.mutations)

    def test_guarded_merge_uses_exact_reviewed_sha(self):
        with patch('promotion_runner.inventory', return_value=self.plan):
            self.assertEqual(self.run_step(), 'merged')
        self.assertEqual(self.mutations[0]['variables'], {'id': 'pr', 'sha': self.sha})

    def test_deployment_gate_blocks_before_any_github_mutation(self):
        with patch('promotion_runner.inventory', return_value=self.plan):
            outcome = promotion_step(self.transport, 'test-token', 'example', 'repo', deployment_ready=lambda sha: False)
        self.assertEqual(outcome, 'deployment-blocked')
        self.assertFalse(self.mutations)

    def test_strict_promotion_preserves_two_successive_closed_prefixes(self):
        with tempfile.TemporaryDirectory() as folder:
            def git(*args):
                return subprocess.check_output(
                    ['git', '-C', folder, '-c', 'user.name=AGF test',
                     '-c', 'user.email=agf@example.invalid', '-c', 'commit.gpgSign=false', *args],
                    text=True, encoding='utf-8',
                ).strip()

            def commit(tree, *parents):
                return git('commit-tree', tree, *sum((['-p', parent] for parent in parents), []),
                           '-m', f'isolated candidate {len(parents)}')

            def commit_data(sha):
                return {'sha': sha, 'tree': {'sha': git('rev-parse', sha + '^{tree}')},
                        'parents': [{'sha': p} for p in git('show', '-s', '--format=%P', sha).split()]}

            git('init', '-q')
            file = Path(folder) / 'content'
            trees = []
            for state in ['base', 'first closed', 'second closed', 'still open']:
                file.write_text(state, encoding='utf-8')
                git('add', 'content')
                trees.append(git('write-tree'))

            common = commit(trees[0])
            main = commit(trees[0], common)
            sources = [commit(trees[1], common)]
            sources.append(commit(trees[2], sources[0]))
            open_tip = commit(trees[3], sources[-1])

            for cycle, source in enumerate(sources, 1):
                branch = f'agf-promotion/strict-{main}-{source}'
                prefix = '/repos/example/repo'
                commit_path = '/git/commits'
                ref_path = '/git/matching-refs/heads/' + branch
                plan = {'main': main, 'smoke': open_tip, 'base': common,
                        'plan': {'kind': 'ready', 'sha': source, 'count': 1},
                        'requires_main_parent': True,
                        'accepted_scope': {'changes': [f'issue-{cycle}'], 'commits': [source]}}
                refs, prs, merges = [], [], []
                clean = False

                def transport(path, token, *, body=None):
                    if path == '/graphql':
                        query = body['query']
                        variables = body['variables']
                        if 'createRef' in query:
                            refs.append({'ref': variables['name'], 'object': {'sha': variables['oid']}})
                            result = {'createRef': {'ref': {'id': 'ref'}}}
                        elif 'createPullRequest' in query:
                            self.assertEqual(variables['head'], branch)
                            prs.append({'number': 7})
                            result = {'createPullRequest': {'pullRequest': {'id': 'pr'}}}
                        else:
                            candidate = variables['sha']
                            self.assertEqual(candidate, refs[0]['object']['sha'])
                            merges.append(commit(commit_data(candidate)['tree']['sha'], main, candidate))
                            result = {'mergePullRequest': {'pullRequest': {'merged': True}}}
                        return {'data': result}, None
                    path = path.removeprefix(prefix)
                    if path == commit_path:
                        return commit_data(commit(body['tree'], *body['parents'])), None
                    if path.startswith(commit_path + '/'):
                        return commit_data(path[len(commit_path) + 1:]), None
                    if path == ref_path:
                        return refs, None
                    if path.startswith('/pulls?'):
                        return prs, None
                    if path == '/pulls/7':
                        return {'number': 7, 'state': 'open', 'node_id': 'pr', 'draft': False,
                                'head': {'sha': refs[0]['object']['sha'], 'ref': branch, 'repo': {'node_id': 'repo'}},
                                'base': {'sha': main, 'ref': 'main', 'repo': {'node_id': 'repo'}},
                                'mergeable_state': 'clean' if clean else 'behind'}, None
                    return self.rows[path], None

                with patch('promotion_runner.inventory', return_value=plan):
                    self.assertEqual(promotion_step(transport, 'token', 'example', 'repo'), 'branch-created')
                    candidate = refs[0]['object']['sha']
                    self.assertEqual(git('merge-base', candidate, main), main)
                    self.assertEqual(commit_data(candidate)['tree']['sha'], trees[cycle])
                    self.assertNotEqual(commit_data(candidate)['tree']['sha'], trees[3])
                    self.assertEqual(promotion_step(transport, 'token', 'example', 'repo'), 'pull-request-created')
                    self.assertEqual(promotion_step(transport, 'token', 'example', 'repo'), 'waiting-checks')
                    clean = True
                    refs[0]['object']['sha'] = open_tip
                    with self.assertRaisesRegex(ValueError, 'Unexpected strict promotion candidate'):
                        promotion_step(transport, 'token', 'example', 'repo')
                    refs[0]['object']['sha'] = candidate

                with patch('promotion_runner.inventory', side_effect=[plan, dict(plan, main='f' * 40)]):
                    self.assertEqual(promotion_step(transport, 'token', 'example', 'repo'), 'changed')
                    self.assertFalse(merges)

                store = DeploymentState(Path(folder) / f'deployment-{cycle}.sqlite')
                store.initialize()
                request = {'id': 'baseline', 'repository_id': 20, 'target': 'main', 'commit': main, 'changes': []}
                store.reserve(request)
                store.transition(request, 'reserved', 'running')
                store.transition(request, 'running', 'succeeded')
                with store.promotion_guard(20) as ready, patch('promotion_runner.inventory', return_value=plan):
                    self.assertEqual(promotion_step(transport, 'token', 'example', 'repo', deployment_ready=ready),
                                     'merged')
                merged, = merges
                self.assertEqual(store.promotion_receipt(20, candidate)['scope'], plan['accepted_scope'])

                def deployed(path, token, *, body=None):
                    if path == '/graphql':
                        return {'data': {'repository': {'pullRequest': {
                            'number': 7, 'merged': True, 'mergeCommit': {'oid': merged},
                        }}}}, None
                    if path == prefix:
                        return {'id': 20}, None
                    if path == prefix + '/pulls/7':
                        return {'number': 7, 'merged': True,
                                'head': {'sha': candidate, 'ref': branch, 'repo': {'id': 20}},
                                'base': {'ref': 'main', 'repo': {'id': 20}}}, None
                    if path == prefix + '/commits/' + merged:
                        data = commit_data(merged)
                        return {**data, 'commit': {'tree': data['tree']}}, None
                    return transport(path, token, body=body)

                self.assertEqual(promoted_scope(deployed, 'token', 'example', 'repo', 20, merged, store),
                                 plan['accepted_scope'])
                main = merged
                self.assertEqual(git('merge-base', source, main), source)

    def test_promotion_records_scope_before_merge(self):
        with tempfile.TemporaryDirectory() as folder:
            store = DeploymentState(Path(folder) / 'state'); store.initialize()
            request = {'id': 'old', 'repository_id': 20, 'target': 'main', 'commit': self.main, 'changes': []}
            store.reserve(request); store.transition(request, 'reserved', 'running'); store.transition(request, 'running', 'succeeded')
            self.plan['accepted_scope'] = {'changes': ['issue-1'], 'commits': [self.sha]}
            with store.promotion_guard(20) as ready, patch('promotion_runner.inventory', return_value=self.plan):
                def verified_transport(path, token, *, body=None):
                    if path == '/graphql':
                        self.assertEqual(store.promotion_receipt(20, self.sha)['scope'], self.plan['accepted_scope'])
                    return self.transport(path, token, body=body)
                self.assertEqual(promotion_step(verified_transport, 'test-token', 'example', 'repo', deployment_ready=ready), 'merged')


if __name__ == '__main__':
    unittest.main()
