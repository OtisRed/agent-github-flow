import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from deployment_source import approved_scope, branch_head, verify_head_and_ci


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.sha = 'a'*40
        self.heads = [self.sha, self.sha]
        self.runs = [{'id': 1, 'name': 'verify', 'app': {'id': 42}, 'head_sha': self.sha,
                      'status': 'completed', 'conclusion': 'success'}]
        self.required = (('verify', 42),)

    def transport(self, path, token):
        if '/branches/' in path:
            return {'commit': {'sha': self.heads.pop(0)}}, None
        return {'total_count': len(self.runs), 'check_runs': self.runs}, None

    def verify(self):
        return verify_head_and_ci(self.transport, 'token', 'example', 'repo', 'smoke', self.sha, self.required)

    def test_exact_head_and_latest_trusted_ci(self):
        self.assertTrue(self.verify())
        self.heads = [self.sha, 'b'*40]
        self.assertFalse(self.verify())
        self.heads = [self.sha, self.sha]
        self.runs.append({**self.runs[0], 'id': 2, 'conclusion': 'failure'})
        self.assertFalse(self.verify())

    def test_missing_wrong_app_or_head_and_duplicate_are_not_success(self):
        for changes in ({'app': {'id': 99}}, {'head_sha': 'b'*40}, {'status': 'in_progress'}):
            self.heads = [self.sha, self.sha]
            self.runs = [{**self.runs[0], **changes}]
            self.assertFalse(self.verify())
        self.heads = [self.sha, self.sha]
        self.runs = [self.runs[0], self.runs[0]]
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.verify()

    def test_prefix_excludes_later_changes_and_deduplicates_issue(self):
        entries = [{'sha': 'a'*40, 'issue': 1}, {'sha': 'b'*40, 'issue': 1},
                   {'sha': 'c'*40, 'issue': 2}, {'sha': 'd'*40, 'issue': 3}]
        result = approved_scope(entries, {'kind': 'ready', 'count': 3, 'sha': 'c'*40})
        self.assertEqual(result, {'changes': ['issue-1', 'issue-2'], 'commits': ['a'*40, 'b'*40, 'c'*40]})
        with self.assertRaises(ValueError):
            approved_scope(entries, {'kind': 'ready', 'count': 3, 'sha': 'd'*40})

    def test_incomplete_check_run_pagination_fails_closed(self):
        def incomplete(path, token):
            if '/branches/' in path:
                return {'commit': {'sha': self.sha}}, None
            return {'total_count': 101, 'check_runs': self.runs}, None
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            verify_head_and_ci(incomplete, 'fixture', 'example', 'repo', 'smoke', self.sha, self.required)
