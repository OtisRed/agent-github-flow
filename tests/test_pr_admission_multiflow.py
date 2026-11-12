import copy
import os
import types
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_pr_admission_github as baseline
from pr_admission_github import normalize_retry_targets


class MultiWorkflowRetryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = baseline.ReaderTests('test_reruns_verified_green_run_shadowed_by_skipped_draft')
        self.fixture.setUp()
        self.writes = self.fixture.prepare_shadowed_ci()
        self.reader = self.fixture.reader
        self.reader.required_tests += (('preflight', 15368),)
        self.reader.retry_targets = (
            ('ci.yml', 'pull_request', 'verify'),
            ('preflight.yml', 'pull_request_target', 'preflight'),
        )
        self.path = f'/commits/{self.fixture.sha}/check-runs?per_page=100&page=1'
        self.query = f'/actions/workflows/preflight.yml/runs?event=pull_request_target&head_sha={self.fixture.sha}&per_page=100'
        self.green_run = {'id': 30, 'run_attempt': 1, 'status': 'completed', 'conclusion': 'success',
                          'event': 'pull_request_target', 'head_sha': self.fixture.sha, 'head_repository': {'id': 20},
                          'head_branch': 'codex/4-agent', 'created_at': '2026-11-07T09:01:00Z', 'pull_requests': []}
        self.fixture.rows[self.query] = {'total_count': 1, 'workflow_runs': [copy.deepcopy(self.green_run)]}
        self.fixture.rows[self.path]['check_runs'].append(self.check(150, 30, 'success'))
        self.fixture.rows[self.path]['total_count'] += 1
        self.fixture.rows['/actions/runs/30/attempts/1/jobs?per_page=100'] = self.jobs(150, 'success')

    def check(self, check_id, run_id, conclusion):
        return {'id': check_id, 'name': 'preflight', 'app': {'id': 15368}, 'head_sha': self.fixture.sha,
                'status': 'completed', 'conclusion': conclusion,
                'details_url': f'https://github.com/owner/repo/actions/runs/{run_id}/job/{check_id}'}

    def jobs(self, check_id, conclusion):
        return {'total_count': 1, 'jobs': [{'id': check_id, 'name': 'preflight', 'status': 'completed',
                 'conclusion': conclusion, 'steps': [{'name': 'Check', 'conclusion': 'success'}] if conclusion == 'success' else []}]}

    def test_reruns_one_shadowed_run_with_other_workflow_green(self):
        self.assertEqual(self.reader.rerun_blocked_ci(4), 'rerun-requested')
        self.assertEqual(self.writes, [{}])
        self.reader._requested_ci_attempts.clear()
        self.assertNotEqual(self.reader.rerun_blocked_ci(4), 'rerun-requested')
        self.assertEqual(self.writes, [{}])

    def test_two_shadowed_workflows_still_rerun_only_one(self):
        skipped = dict(self.green_run, id=31, conclusion='skipped')
        self.fixture.rows[self.query]['workflow_runs'].append(skipped)
        self.fixture.rows[self.query]['total_count'] += 1
        self.fixture.rows[self.path]['check_runs'].append(self.check(151, 31, 'skipped'))
        self.fixture.rows[self.path]['total_count'] += 1
        self.fixture.rows['/actions/runs/31/attempts/1/jobs?per_page=100'] = self.jobs(151, 'skipped')
        self.assertEqual(self.reader.rerun_blocked_ci(4), 'rerun-requested')
        self.assertEqual(self.writes, [{}])

    def test_second_workflow_is_retried_after_first_is_green(self):
        checks = self.fixture.rows[self.path]['check_runs']
        checks[:] = [check for check in checks if check['id'] != 101]
        self.fixture.rows[self.path]['total_count'] -= 1
        skipped = dict(self.green_run, id=31, conclusion='skipped')
        self.fixture.rows[self.query]['workflow_runs'].append(skipped)
        self.fixture.rows[self.query]['total_count'] += 1
        checks.append(self.check(151, 31, 'skipped'))
        self.fixture.rows[self.path]['total_count'] += 1
        self.fixture.rows['/actions/runs/31/attempts/1/jobs?per_page=100'] = self.jobs(151, 'skipped')
        previous = self.reader.transport
        def transport(path, token, *, body=None):
            if path.endswith('/actions/runs/30/rerun'):
                self.writes.append(body)
                return None, None
            return previous(path, token, body=body)
        self.reader.transport = transport
        self.assertEqual(self.reader.rerun_blocked_ci(4), 'rerun-requested')
        self.assertEqual(self.writes, [{}])

    def test_newer_red_run_blocks_retry(self):
        red = dict(self.green_run, id=32, conclusion='failure')
        self.fixture.rows[self.query]['workflow_runs'].append(red)
        self.fixture.rows[self.query]['total_count'] += 1
        self.fixture.rows['/actions/runs/32/attempts/1/jobs?per_page=100'] = {
            'total_count': 1, 'jobs': [{'name': 'preflight', 'conclusion': 'failure',
                'steps': [{'name': 'Actual verification', 'conclusion': 'failure'}]}]}
        self.assertNotEqual(self.reader.rerun_blocked_ci(4), 'rerun-requested')
        self.assertEqual(self.writes, [])

    def test_admission_wait_retry_survives_lost_response_and_restart(self):
        query = f'/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.fixture.sha}&per_page=100'
        run = self.fixture.rows[query]['workflow_runs'][0]
        run['conclusion'] = 'failure'
        self.fixture.rows[query]['workflow_runs'] = [run]
        self.fixture.rows[query]['total_count'] = 1
        checks = self.fixture.rows[self.path]['check_runs']
        checks[:] = [check for check in checks if check['id'] != 101]
        next(check for check in checks if check['id'] == 100)['conclusion'] = 'failure'
        self.fixture.rows[self.path]['total_count'] -= 1
        self.fixture.rows['/actions/runs/19/attempts/1/jobs?per_page=100'] = {
            'total_count': 1, 'jobs': [{'id': 100, 'name': 'verify', 'status': 'completed', 'conclusion': 'failure',
                'steps': [{'name': 'Wait for flow admission', 'conclusion': 'failure'}]}]}
        previous = self.reader.transport
        attempts = []
        def lost(path, token, *, body=None):
            if path.endswith('/actions/runs/19/rerun-failed-jobs'):
                attempts.append(path)
                raise TimeoutError('synthetic uncertain response')
            return previous(path, token, body=body)
        self.reader.transport = lost
        gate_check = next(check for check in checks if check['id'] == 100)
        gate_check['conclusion'] = 'success'
        self.assertNotEqual(self.reader.rerun_blocked_ci(4), 'rerun-requested')
        self.assertEqual(attempts, [])
        gate_check['conclusion'] = 'failure'
        other = self.fixture.rows[self.query]['workflow_runs'][0]
        other['head_repository']['id'] = 99
        self.assertEqual(self.reader.rerun_blocked_ci(4), 'other-checks-blocked')
        self.assertEqual(attempts, [])
        other['head_repository']['id'] = 20
        with self.assertRaises(TimeoutError):
            self.reader.rerun_blocked_ci(4)
        self.reader._requested_ci_attempts.clear()
        self.assertEqual(self.reader.rerun_blocked_ci(4), 'already-requested')
        self.assertEqual(len(attempts), 1)

    def test_default_single_workflow_still_rejects_another_green_run(self):
        self.reader.retry_targets = None
        query = f'/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.fixture.sha}&per_page=100'
        extra_run = dict(self.fixture.rows[query]['workflow_runs'][0], id=21)
        self.fixture.rows[query]['workflow_runs'].append(extra_run)
        self.fixture.rows[query]['total_count'] += 1
        self.fixture.rows[self.path]['check_runs'][-1]['details_url'] = 'https://github.com/owner/repo/actions/runs/21/job/150'
        self.assertNotEqual(self.reader.rerun_blocked_ci(4), 'rerun-requested')
        self.assertEqual(self.writes, [])

    def test_no_durable_journal_means_no_retry(self):
        self.reader.ci_retry_journal = None
        self.assertNotEqual(self.reader.rerun_blocked_ci(4), 'rerun-requested')
        self.assertEqual(self.writes, [])

    def test_gate_retry_does_not_run_while_another_product_test_is_red(self):
        query = f'/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.fixture.sha}&per_page=100'
        run = self.fixture.rows[query]['workflow_runs'][0]
        run['conclusion'] = 'failure'
        self.fixture.rows[query] = {'total_count': 1, 'workflow_runs': [run]}
        checks = self.fixture.rows[self.path]['check_runs']
        checks[:] = [check for check in checks if check['id'] != 101]
        next(check for check in checks if check['id'] == 100)['conclusion'] = 'failure'
        checks[-1]['conclusion'] = 'failure'
        self.fixture.rows[self.path]['total_count'] -= 1
        self.fixture.rows['/actions/runs/19/attempts/1/jobs?per_page=100'] = {
            'total_count': 1, 'jobs': [{'id': 100, 'name': 'verify', 'status': 'completed', 'conclusion': 'failure',
                'steps': [{'name': 'Wait for flow admission', 'conclusion': 'failure'}]}]}
        other = self.fixture.rows[self.query]['workflow_runs'][0]
        other['conclusion'] = 'failure'
        self.fixture.rows['/actions/runs/30/attempts/1/jobs?per_page=100'] = {
            'total_count': 1, 'jobs': [{'id': 150, 'name': 'preflight', 'status': 'completed', 'conclusion': 'failure',
                'steps': [{'name': 'Actual product tests', 'conclusion': 'failure'}]}]}
        self.assertEqual(self.reader.rerun_blocked_ci(4), 'other-checks-blocked')
        self.assertEqual(self.writes, [])
        self.fixture.rows['/actions/runs/30/attempts/1/jobs?per_page=100']['jobs'][0]['steps'] = [
            {'name': 'Wait for flow admission', 'conclusion': 'failure'}]
        previous = self.reader.transport
        def capture(path, token, *, body=None):
            if path.endswith('/actions/runs/19/rerun-failed-jobs'):
                self.writes.append(body)
                return None, None
            return previous(path, token, body=body)
        self.reader.transport = capture
        self.assertEqual(self.reader.rerun_blocked_ci(4), 'rerun-requested')
        self.assertEqual(self.writes, [{}])

    def test_admission_failure_with_skipped_dependent_canary_is_retried(self):
        query = f'/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.fixture.sha}&per_page=100'
        run = self.fixture.rows[query]['workflow_runs'][0]
        run['conclusion'] = 'failure'
        self.fixture.rows[query] = {'total_count': 1, 'workflow_runs': [run]}
        checks = self.fixture.rows[self.path]['check_runs']
        checks[:] = [check for check in checks if check['id'] != 101]
        next(check for check in checks if check['id'] == 100)['conclusion'] = 'failure'
        checks.append({'id': 152, 'name': 'old-canary', 'app': {'id': 15368},
                       'head_sha': self.fixture.sha, 'status': 'completed', 'conclusion': 'skipped',
                       'details_url': 'https://github.com/owner/repo/actions/runs/19/job/152'})
        self.fixture.rows[self.path]['total_count'] = len(checks)
        self.reader.required_tests += (('old-canary', 15368),)
        self.reader.retry_targets += (('ci.yml', 'pull_request', 'old-canary'),)
        self.fixture.rows['/actions/runs/19/attempts/1/jobs?per_page=100'] = {'total_count': 2, 'jobs': [
            {'id': 100, 'name': 'verify', 'status': 'completed', 'conclusion': 'failure',
             'steps': [{'name': 'Wait for flow admission', 'conclusion': 'failure'}]},
            {'id': 152, 'name': 'old-canary', 'status': 'completed', 'conclusion': 'skipped', 'steps': []}]}
        previous = self.reader.transport
        def capture(path, token, *, body=None):
            if path.endswith('/actions/runs/19/rerun-failed-jobs'):
                self.writes.append(body)
                return None, None
            return previous(path, token, body=body)
        self.reader.transport = capture
        jobs = self.fixture.rows['/actions/runs/19/attempts/1/jobs?per_page=100']['jobs']
        jobs.append({'id': 153, 'name': 'product', 'status': 'completed', 'conclusion': 'failure',
                     'steps': [{'name': 'Test product', 'conclusion': 'failure'}]})
        self.fixture.rows['/actions/runs/19/attempts/1/jobs?per_page=100']['total_count'] += 1
        self.assertEqual(self.reader.rerun_blocked_ci(4), 'other-checks-blocked')
        self.assertEqual(self.writes, [])
        jobs.pop()
        self.fixture.rows['/actions/runs/19/attempts/1/jobs?per_page=100']['total_count'] -= 1
        jobs.append({'id': 153, 'name': 'product', 'status': 'completed', 'conclusion': 'cancelled', 'steps': []})
        self.fixture.rows['/actions/runs/19/attempts/1/jobs?per_page=100']['total_count'] += 1
        self.assertEqual(self.reader.rerun_blocked_ci(4), 'other-checks-blocked')
        self.assertEqual(self.writes, [])
        jobs.pop()
        self.fixture.rows['/actions/runs/19/attempts/1/jobs?per_page=100']['total_count'] -= 1
        self.assertEqual(self.reader.rerun_blocked_ci(4), 'rerun-requested')
        self.assertEqual(self.writes, [{}])
        self.reader._requested_ci_attempts.clear()
        self.assertEqual(self.reader.rerun_blocked_ci(4), 'already-requested')
        self.assertEqual(self.writes, [{}])

    def test_pr_changed_before_shadow_retry_is_blocked(self):
        previous = self.reader.transport
        reads = 0
        def changed(path, token, *, body=None):
            nonlocal reads
            result, link = previous(path, token, body=body)
            if path.endswith('/pulls/4'):
                reads += 1
                if reads == 2:
                    result['head']['sha'] = 'b' * 40
            return result, link
        self.reader.transport = changed
        self.assertEqual(self.reader.rerun_blocked_ci(4), 'pr-changed')
        self.assertEqual(self.writes, [])

    def test_retry_configuration_requires_exact_complete_mapping(self):
        required = (('verify', 15368), ('preflight', 15368))
        valid = [{'workflow': 'ci.yml', 'event': 'pull_request', 'job': 'verify'},
                 {'workflow': 'preflight.yml', 'event': 'pull_request_target', 'job': 'preflight'}]
        self.assertEqual(normalize_retry_targets(valid, required), self.reader.retry_targets)
        self.assertIsNone(normalize_retry_targets(None, required))
        for invalid in ([], valid[:1], valid + valid[:1],
                        [dict(valid[0], workflow='../evil.yml'), valid[1]],
                        [dict(valid[0], event='workflow_dispatch'), valid[1]],
                        [dict(valid[0], job='preflight'), valid[1]]):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    normalize_retry_targets(invalid, required)

    def test_service_passes_mapping_to_reader(self):
        from pr_admission_service import build_readers
        mapping = [{'workflow': 'ci.yml', 'event': 'pull_request', 'job': 'verify'},
                   {'workflow': 'preflight.yml', 'event': 'pull_request_target', 'job': 'preflight'}]
        config = {'app_id': 10, 'installation_id': 11, 'state_path': 'synthetic/state.sqlite',
                  'projects': [{'admission_enabled': True, 'owner': 'owner', 'repository': 'repo',
                                'repository_id': 20, 'trusted_author_ids': [7],
                                'admission_tests': [{'context': 'verify', 'app_id': 15368},
                                                    {'context': 'preflight', 'app_id': 15368}],
                                'admission_retry_targets': mapping}]}
        with patch('pr_admission_service.AppToken', return_value=lambda: 'synthetic'):
            readers = build_readers(config, b'synthetic')
        self.assertEqual(readers[0][0].retry_targets, self.reader.retry_targets)
        self.assertEqual(readers[0][1], frozenset({7}))

    def test_service_config_rejects_incomplete_mapping_at_startup(self):
        from unittest.mock import patch as mock_patch
        modules = {'fcntl': types.ModuleType('fcntl')} if os.name == 'nt' else {}
        with mock_patch.dict(sys.modules, modules):
            from mvp_service import validate_config
            root = os.path.abspath('synthetic')
            project = {'repository_id': 20, 'owner': 'owner', 'repository': 'repo',
                       'project_owner': 'owner', 'project_number': 1,
                       'trusted_author_ids': [7], 'enrolled_at': '2026-11-01T00:00:00Z',
                       'admission_enabled': True,
                       'admission_tests': [{'context': 'verify', 'app_id': 15368},
                                           {'context': 'preflight', 'app_id': 15368}],
                       'admission_retry_targets': [{'workflow': 'ci.yml', 'event': 'pull_request', 'job': 'verify'}]}
            config = {'app_id': 10, 'installation_id': 11, 'port': 8080,
                      'projects': [project], **{key: os.path.join(root, key) for key in
                         ('state_path', 'webhook_secret_path', 'project_token_path', 'app_key_path')}}
            with self.assertRaises(ValueError):
                validate_config(config)
            project['admission_retry_targets'].append(
                {'workflow': 'preflight.yml', 'event': 'pull_request_target', 'job': 'preflight'})
            self.assertIs(validate_config(config), config)

    def test_rejects_bad_or_ambiguous_other_workflow(self):
        for condition in ('red', 'wrong_repo', 'in_progress', 'wrong_job', 'wrong_event',
                          'wrong_sha', 'bad_url', 'ambiguous_pr', 'newer_running'):
            with self.subTest(condition=condition):
                self.setUp()
                run = self.fixture.rows[self.query]['workflow_runs'][0]
                check = self.fixture.rows[self.path]['check_runs'][-1]
                if condition == 'red': check['conclusion'] = 'failure'
                if condition == 'wrong_repo': run['head_repository']['id'] = 99
                if condition == 'in_progress': run['status'] = 'in_progress'
                if condition == 'wrong_job': self.fixture.rows['/actions/runs/30/attempts/1/jobs?per_page=100']['jobs'][0]['id'] = 151
                if condition == 'wrong_event': run['event'] = 'workflow_dispatch'
                if condition == 'wrong_sha': check['head_sha'] = 'b' * 40
                if condition == 'bad_url': check['details_url'] = 'https://elsewhere.invalid/runs/30/job/150'
                if condition == 'ambiguous_pr': run['pull_requests'] = [{'number': 4}, {'number': 5}]
                if condition == 'newer_running':
                    self.fixture.rows[self.query]['workflow_runs'].append(dict(run, id=32, status='in_progress'))
                    self.fixture.rows[self.query]['total_count'] += 1
                self.assertNotEqual(self.reader.rerun_blocked_ci(4), 'rerun-requested')
                self.assertEqual(self.writes, [])


if __name__ == '__main__':
    unittest.main()
