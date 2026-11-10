import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from promotion_runner import promotion_step, protection_ready


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


if __name__ == '__main__':
    unittest.main()
