import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from promotion_inventory import inventory


class InventoryTests(unittest.TestCase):
    def setUp(self):
        a, b, c = ('a' * 40, 'b' * 40, 'c' * 40)
        self.a, self.b, self.c = a, b, c
        self.graphql_override = None
        self.values = {
            '/branches/main': {'commit': {'sha': a}},
            '/branches/smoke': {'commit': {'sha': c}},
            f'/compare/{a}...{c}?per_page=1': {'merge_base_commit': {'sha': a}},
            f'/compare/{a}...{c}?per_page=100&page=1': {'status': 'ahead', 'ahead_by': 2, 'total_commits': 2, 'merge_base_commit': {'sha': a}, 'commits': [{'sha': b}, {'sha': c}]},
            f'/compare/{a}...{b}?per_page=1': {'status': 'ahead', 'merge_base_commit': {'sha': a}},
            f'/commits/{c}': {'sha': c, 'parents': [{'sha': b}]},
            f'/commits/{b}': {'sha': b, 'parents': [{'sha': a}]},
            f'/commits/{b}/pulls?per_page=100': [self.pr(b, 1)],
            f'/commits/{c}/pulls?per_page=100': [self.pr(c, 2)],
            '/issues/1': {'number': 1, 'state': 'closed', 'closed_at': '2026-11-02T00:00:00Z'},
            '/issues/2': {'number': 2, 'state': 'open', 'closed_at': None},
        }

    @staticmethod
    def pr(sha, n):
        return {'number': n, 'merge_commit_sha': sha, 'base': {'ref': 'smoke'}, 'merged_at': '2026-11-01T00:00:00Z', 'body': f'Refs #{n}'}

    def transport(self, path, token, *, body=None):
        self.assertEqual(token, 'test-token')
        if path == '/graphql':
            if self.graphql_override is not None:
                return self.graphql_override, None
            number = body['variables']['number']
            oid = self.b if number == 1 else self.c
            return {'data': {'repository': {'pullRequest': {'number': number, 'merged': True, 'mergeCommit': {'oid': oid}}}}}, None
        return self.values[path.removeprefix('/repos/example/repo')], None

    def run_inventory(self):
        return inventory(self.transport, 'test-token', 'example', 'repo')

    def test_selects_contiguous_prefix(self):
        self.assertEqual(self.run_inventory()['plan'], {'kind': 'ready', 'sha': self.b, 'count': 1})

    def test_main_in_side_parent_uses_closed_prefix_without_walking_older_history(self):
        # main=a; smoke=c -> b -> x, with main merged into b as a side parent.
        # x is already on main; b is the last closed PR and c remains open.
        x, z = 'd' * 40, 'e' * 40
        self.values[f'/commits/{self.b}']['parents'] = [{'sha': x}, {'sha': self.a}]
        self.values[f'/commits/{x}'] = {'sha': x, 'parents': [{'sha': z}]}
        self.values[f'/commits/{z}'] = {'sha': z, 'parents': []}
        self.values[f'/compare/{self.a}...{self.c}?per_page=100&page=1'] = {
            'status': 'ahead', 'ahead_by': 2, 'total_commits': 2,
            'merge_base_commit': {'sha': self.a},
            'commits': [{'sha': self.b}, {'sha': self.c}],
        }
        self.values[f'/compare/{self.a}...{self.b}?per_page=1'] = {
            'status': 'ahead', 'merge_base_commit': {'sha': self.a},
        }
        try:
            plan = self.run_inventory()['plan']
        except ValueError as exc:
            self.fail(f'Valid side-parent history was rejected: {exc}')
        self.assertEqual(plan, {'kind': 'ready', 'sha': self.b, 'count': 1})

    def test_open_issue_before_main_merge_blocks_candidate(self):
        # The closed first PR does not include main; the next PR includes main
        # but remains open, so no candidate may advance.
        x = 'd' * 40
        self.values[f'/commits/{self.c}']['parents'] = [{'sha': self.b}, {'sha': self.a}]
        self.values[f'/commits/{self.b}']['parents'] = [{'sha': x}]
        self.values[f'/commits/{x}'] = {'sha': x, 'parents': []}
        self.values[f'/compare/{self.a}...{self.b}?per_page=1'] = {
            'status': 'diverged', 'merge_base_commit': {'sha': x},
        }
        try:
            plan = self.run_inventory()['plan']
        except ValueError as exc:
            self.fail(f'Expected a safe blocked result: {exc}')
        self.assertEqual(plan, {'kind': 'blocked', 'reason': 'candidate-missing-main'})

    def test_promotes_when_diverged_main_has_same_tree_as_common_base(self):
        # main=a and candidate=b descend from x through different commits.
        # main changes only ancestry; its complete tree is unchanged from x.
        x, tree = 'd' * 40, 'e' * 40
        self.values[f'/commits/{self.b}']['parents'] = [{'sha': x}]
        self.values[f'/compare/{self.a}...{self.b}?per_page=1'] = {
            'status': 'diverged',
            'base_commit': {'sha': self.a, 'commit': {'tree': {'sha': tree}}},
            'merge_base_commit': {'sha': x, 'commit': {'tree': {'sha': tree}}},
        }
        self.assertEqual(self.run_inventory()['plan'], {'kind': 'ready', 'sha': self.b, 'count': 1})

    def test_diverged_main_with_different_or_incomplete_trees_stays_blocked(self):
        x, tree = 'd' * 40, 'e' * 40
        self.values[f'/commits/{self.b}']['parents'] = [{'sha': x}]
        key = f'/compare/{self.a}...{self.b}?per_page=1'
        for base, other in [({'sha': self.a, 'commit': {'tree': {'sha': tree}}},
                             {'sha': x, 'commit': {'tree': {'sha': 'f' * 40}}}),
                            ({'sha': self.a, 'commit': {'tree': {'sha': tree}}}, {'sha': x}),
                            ({'sha': self.c, 'commit': {'tree': {'sha': tree}}},
                             {'sha': x, 'commit': {'tree': {'sha': tree}}})]:
            with self.subTest(base=base, merge_base=other):
                self.values[key] = {'status': 'diverged', 'base_commit': base, 'merge_base_commit': other}
                self.assertEqual(self.run_inventory()['plan'], {'kind': 'blocked', 'reason': 'candidate-missing-main'})

    def test_incomplete_compare_blocks_promotion(self):
        compare = self.values[f'/compare/{self.a}...{self.c}?per_page=100&page=1']
        compare['commits'].pop()
        with self.assertRaises(ValueError):
            self.run_inventory()

    def test_equal_heads_are_idle(self):
        self.values['/branches/smoke'] = {'commit': {'sha': self.a}}
        self.values[f'/compare/{self.a}...{self.a}?per_page=100&page=1'] = {
            'status': 'identical', 'ahead_by': 0, 'total_commits': 0,
            'merge_base_commit': {'sha': self.a}, 'commits': [],
        }
        self.assertEqual(self.run_inventory()['plan'], {'kind': 'idle'})

    def test_complete_paginated_compare_preserves_queue_and_rejects_duplicates(self):
        extra = [f'{number:040x}' for number in range(1, 100)]
        commits = [{'sha': sha} for sha in [self.b, self.c] + extra]
        key = f'/compare/{self.a}...{self.c}?per_page=100&page=1'
        page = {'status': 'ahead', 'ahead_by': 101, 'total_commits': 101,
                'merge_base_commit': {'sha': self.a}}
        self.values[key] = dict(page, commits=commits[:100])
        self.values[key.replace('&page=1', '&page=2')] = dict(page, commits=commits[100:])
        self.assertEqual(self.run_inventory()['plan'], {'kind': 'ready', 'sha': self.b, 'count': 1})
        self.values[key.replace('&page=1', '&page=2')]['commits'] = [commits[0]]
        with self.assertRaises(ValueError):
            self.run_inventory()

    def test_compare_missing_smoke_head_blocks(self):
        compare = self.values[f'/compare/{self.a}...{self.c}?per_page=100&page=1']
        compare['commits'] = [{'sha': self.b}, {'sha': 'd' * 40}]
        with self.assertRaises(ValueError):
            self.run_inventory()

    def test_current_rest_version_without_merge_commit_sha(self):
        for sha in (self.b, self.c):
            del self.values[f'/commits/{sha}/pulls?per_page=100'][0]['merge_commit_sha']
        self.assertEqual(self.run_inventory()['plan'], {'kind': 'ready', 'sha': self.b, 'count': 1})

    def test_missing_graphql_merge_commit_blocks(self):
        self.graphql_override = {'data': {'repository': {'pullRequest': {'number': 1, 'merged': True, 'mergeCommit': None}}}}
        with self.assertRaises(ValueError):
            self.run_inventory()

    def test_graphql_error_blocks(self):
        self.graphql_override = {'errors': [{'message': 'unavailable'}], 'data': None}
        with self.assertRaises(ValueError):
            self.run_inventory()

    def test_missing_or_ambiguous_mapping_blocks(self):
        path = f'/commits/{self.b}/pulls?per_page=100'
        self.values[path].append(self.values[path][0])
        with self.assertRaises(ValueError):
            self.run_inventory()

    def test_missing_reference_blocks(self):
        self.values[f'/commits/{self.b}/pulls?per_page=100'][0]['body'] = 'Changed issue'
        with self.assertRaises(ValueError):
            self.run_inventory()

    def test_cycles_in_history_block(self):
        self.values[f'/commits/{self.b}']['parents'][0]['sha'] = self.c
        with self.assertRaises(ValueError):
            self.run_inventory()


if __name__ == '__main__':
    unittest.main()
