import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from promotion_inventory import inventory


class InventoryTests(unittest.TestCase):
    def setUp(self):
        a, b, c = ('a' * 40, 'b' * 40, 'c' * 40)
        self.a, self.b, self.c = a, b, c
        self.values = {
            '/branches/main': {'commit': {'sha': a}},
            '/branches/smoke': {'commit': {'sha': c}},
            f'/compare/{a}...{c}?per_page=1': {'merge_base_commit': {'sha': a}},
            f'/commits/{c}': {'sha': c, 'parents': [{'sha': b}]},
            f'/commits/{b}': {'sha': b, 'parents': [{'sha': a}]},
            f'/commits/{b}/pulls?per_page=100': [self.pr(b, 1)],
            f'/commits/{c}/pulls?per_page=100': [self.pr(c, 2)],
            '/issues/1': {'number': 1, 'state': 'closed', 'closed_at': '2026-11-02T00:00:00Z'},
            '/issues/2': {'number': 2, 'state': 'open', 'closed_at': None},
        }

    @staticmethod
    def pr(sha, n):
        return {'merge_commit_sha': sha, 'base': {'ref': 'smoke'}, 'merged_at': '2026-11-01T00:00:00Z', 'body': f'Refs #{n}'}

    def transport(self, path, token):
        self.assertEqual(token, 'test-token')
        return self.values[path.removeprefix('/repos/example/repo')], None

    def run_inventory(self):
        return inventory(self.transport, 'test-token', 'example', 'repo')

    def test_selects_contiguous_prefix(self):
        self.assertEqual(self.run_inventory()['plan'], {'kind': 'ready', 'sha': self.b, 'count': 1})

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
