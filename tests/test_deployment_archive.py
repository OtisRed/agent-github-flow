import io
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from deployment_archive import fetch_archive


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.req = {'id': 'smoke-test', 'repository_id': 42, 'target': 'smoke', 'commit': 'a' * 40, 'changes': []}
        self.config = {'projects': [{'repository_id': 42, 'owner': 'owner', 'repository': 'repo',
                                    'deployment_enabled': True, 'deployment_checks': [{'context': 'verify', 'app_id': 1}]}]}
        self.calls = []

    def run_git(self, args, **kwargs):
        self.calls.append((args, kwargs['env']))
        if 'rev-parse' in args:
            return SimpleNamespace(stdout=('a' * 40 + '\n').encode())
        if 'archive' in args:
            kwargs['stdout'].write(b'synthetic tar')
        return SimpleNamespace(stdout=b'')

    def test_emits_only_verified_sha_and_archive(self):
        output = io.BytesIO()
        with patch('deployment_archive.attest', return_value=True), patch('deployment_archive.verify_head_and_ci', return_value=True):
            fetch_archive(self.config, self.req, 'smoke', 'synthetic-token', object(), output, run=self.run_git)
        self.assertEqual(output.getvalue(), ('a' * 40 + '\n').encode() + b'synthetic tar')
        self.assertNotIn(b'synthetic-token', output.getvalue())
        self.assertTrue(any('fetch' in args for args, _ in self.calls))
        self.assertTrue(all('synthetic-token' not in ' '.join(args) for args, _ in self.calls))

    def test_changed_ref_or_stale_ci_produces_no_archive(self):
        output = io.BytesIO()
        def stale(args, **kwargs):
            if 'rev-parse' in args:
                return SimpleNamespace(stdout=('b' * 40 + '\n').encode())
            return self.run_git(args, **kwargs)
        with patch('deployment_archive.attest', return_value=True), patch('deployment_archive.verify_head_and_ci', return_value=True):
            with self.assertRaisesRegex(ValueError, 'differs'):
                fetch_archive(self.config, self.req, 'smoke', 'token', object(), output, run=stale)
        self.assertEqual(output.getvalue(), b'')
        with patch('deployment_archive.attest', return_value=False):
            with self.assertRaisesRegex(ValueError, 'Unconfirmed'):
                fetch_archive(self.config, self.req, 'smoke', 'token', object(), output, run=self.run_git)
        self.assertEqual(output.getvalue(), b'')


if __name__ == '__main__':
    unittest.main()
