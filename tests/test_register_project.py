"""Synthetic tests for safe controller registration; never touches systemd."""
import copy
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))


@unittest.skipUnless(os.name == 'posix', 'POSIX controller host required')
class RegisterProjectTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('register_project', ROOT / 'scripts/register_project.py')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.original_validate = self.module.validate_candidate
        self.original_backup = self.module.database_backup
        validator_spec = importlib.util.spec_from_file_location('validate_registration_test', ROOT / 'scripts/validate_registration.py')
        self.validator = importlib.util.module_from_spec(validator_spec)
        validator_spec.loader.exec_module(self.validator)
        from mvp_service import validate_config
        from pr_admission_github import AdmissionReader
        def local_validate(config, entry=None):
            validate_config(config)
            if entry is not None and entry['admission_enabled']:
                AdmissionReader(owner=entry['owner'], repository=entry['repository'],
                                repository_id=entry['repository_id'], token=lambda: None, transport=lambda *_: None,
                                workflow=entry.get('admission_workflow', 'ci.yml'),
                                gate_job=entry.get('admission_gate_job', 'verify'),
                                workflow_event=entry.get('admission_workflow_event', 'pull_request'),
                                sync_bot_id=entry.get('admission_sync_bot_id'),
                                required_tests=tuple((x['context'], x['app_id']) for x in entry['admission_tests']),
                                retry_targets=entry.get('admission_retry_targets'))
        from mvp_store import Store
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.config_file = self.root / 'config.json'
        self.state = self.root / 'state.sqlite'
        Store(self.state).initialize()
        self.state.chmod(0o600)
        (self.root / 'state.sqlite.lock').touch(mode=0o600)
        self.existing = {'repository_id': 10, 'owner': 'Owner', 'repository': 'existing',
                         'project_owner': 'Owner', 'project_number': 1,
                         'enrolled_at': '2026-11-01T00:00:00Z', 'trusted_author_ids': [2],
                         'status_enabled': True, 'pr_flow_enabled': False, 'admission_enabled': False,
                         'promotion_enabled': False, 'dependabot_enabled': False}
        self.config = {'app_id': 1, 'installation_id': 2, 'port': 9876, 'state_path': str(self.state),
                       'webhook_secret_path': '/synthetic/secret', 'project_token_path': '/synthetic/pat',
                       'app_key_path': '/synthetic/key', 'projects': [copy.deepcopy(self.existing)]}
        self.config_file.write_text(json.dumps(self.config), encoding='utf-8')
        self.config_file.chmod(0o600)
        self.request = {'repository_id': 20, 'owner': 'Owner', 'repository': 'new',
                        'project_owner': 'Owner', 'project_number': 2, 'trusted_author_ids': [2],
                        'status_enabled': False, 'pr_flow_enabled': False, 'admission_enabled': False,
                        'promotion_enabled': False, 'dependabot_enabled': False}
        self.active = True
        self.operations = []
        def ctl(action, *args):
            self.operations.append(action)
            if action == 'stop': self.active = False
            if action == 'start': self.active = True
        self.patches = [patch.object(self.module, 'systemctl', side_effect=ctl),
                        patch.object(self.module, 'healthy', side_effect=lambda: self.active),
                        patch.object(self.module, 'validate_candidate', side_effect=local_validate),
                        patch.object(self.module, 'database_backup', side_effect=self.validator.backup_database),
                        patch.object(self.module.time, 'sleep', return_value=None)]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()

    def run_registration(self):
        return self.module.enroll(self.config_file, self.request, os.geteuid(), os.getegid())

    def test_add_backup_and_repeat_without_restart(self):
        self.assertEqual(self.run_registration(), 'registered')
        after = json.loads(self.config_file.read_text(encoding='utf-8'))
        self.assertEqual(after['projects'][0], self.existing)
        self.assertEqual(after['projects'][1]['repository_id'], 20)
        self.assertEqual(self.operations, ['stop', 'start'])
        self.assertTrue(self.active)
        self.assertEqual(len(list(self.root.glob('onboarding-config-backup-*'))), 1)
        backups = list(self.root.glob('onboarding-state-*.sqlite'))
        self.assertEqual(len(backups), 1)
        with sqlite3.connect(backups[0]) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        original_bytes = self.config_file.read_bytes()
        self.assertEqual(self.run_registration(), 'exists')
        self.assertEqual(self.config_file.read_bytes(), original_bytes)
        self.assertEqual(self.operations, ['stop', 'start'])

    def test_existing_conflict_does_not_stop_or_write(self):
        self.request['repository_id'] = 10
        original = self.config_file.read_bytes()
        with self.assertRaisesRegex(ValueError, 'existing-conflict'): self.run_registration()
        self.assertEqual(self.config_file.read_bytes(), original)
        self.assertEqual(self.operations, [])

    def update_request(self):
        return {key: copy.deepcopy(self.existing[key]) for key in self.module.REQUIRED}

    def update(self, request, digest=None):
        digest = digest or hashlib.sha256(self.config_file.read_bytes()).hexdigest()
        return self.module.enroll(self.config_file, request, os.geteuid(), os.getegid(),
                                  update=True, expected_sha256=digest)

    def insert_existing_boundary(self, boundary=None):
        with sqlite3.connect(self.state) as db:
            db.execute('INSERT INTO project_boundaries VALUES (?, ?)',
                       (10, boundary or self.existing['enrolled_at']))

    def test_staged_activation_keeps_boundaries_and_other_projects(self):
        self.insert_existing_boundary()
        other = copy.deepcopy(self.existing)
        other.update(repository_id=11, repository='other', project_number=3)
        self.config['projects'].append(other)
        self.config_file.write_text(json.dumps(self.config))
        req = self.update_request()
        req.update(pr_flow_enabled=True, admission_enabled=True, pr_flow_app_author_id=2,
                   admission_tests=[{'context': 'verify', 'app_id': 15368}])
        candidate, result, changes = self.module.plan_update(self.config, req, '2026-11-13T10:00:00Z')
        self.assertEqual(result, 'updated')
        self.assertEqual(changes, ['pr_flow_enabled', 'admission_enabled'])
        self.assertEqual(candidate['projects'][0]['enrolled_at'], self.existing['enrolled_at'])
        self.assertEqual(candidate['projects'][0]['pr_flow_enrolled_at'], '2026-11-13T10:00:00Z')
        self.assertEqual(self.update(req), 'updated')
        current = json.loads(self.config_file.read_text())
        self.assertEqual(current['projects'][1], other)
        self.assertEqual(current['projects'][0]['enrolled_at'], self.existing['enrolled_at'])
        first_flow_boundary = current['projects'][0]['pr_flow_enrolled_at']
        self.assertEqual(self.update(req), 'exists')
        self.assertEqual(self.operations, ['stop', 'start'])
        req['promotion_enabled'] = True
        self.assertEqual(self.update(req), 'updated')
        current = json.loads(self.config_file.read_text())
        self.assertEqual(current['projects'][0]['pr_flow_enrolled_at'], first_flow_boundary)
        self.assertTrue(current['projects'][0]['promotion_enabled'])
        self.assertEqual(len(list(self.root.glob('onboarding-state-*.sqlite'))), 2)
        with sqlite3.connect(self.state) as db:
            self.assertEqual(db.execute('SELECT enrolled_at FROM project_boundaries WHERE repository_id=10').fetchone()[0],
                             self.existing['enrolled_at'])

    def test_update_rejects_stale_hash_and_identity_or_option_changes(self):
        self.insert_existing_boundary()
        req = self.update_request()
        req['promotion_enabled'] = True
        digest = hashlib.sha256(self.config_file.read_bytes()).hexdigest()
        self.config_file.write_text(json.dumps({**self.config, 'external': 'preserved'}))
        with self.assertRaisesRegex(ValueError, 'configuration-changed'):
            self.update(req, digest)
        self.assertEqual(self.operations, [])
        self.assertEqual(json.loads(self.config_file.read_text())['external'], 'preserved')
        req['trusted_author_ids'] = [2, 3]
        with self.assertRaisesRegex(ValueError, 'existing-conflict'):
            self.update(req)
        req = self.update_request()
        req['status_enabled'] = False
        with self.assertRaisesRegex(ValueError, 'existing-conflict'):
            self.update(req)
        self.assertEqual(self.operations, [])

    def test_update_blocks_missing_or_changed_database_boundary(self):
        req = self.update_request()
        req['promotion_enabled'] = True
        with self.assertRaisesRegex(ValueError, 'boundary-mismatch'):
            self.update(req)
        self.assertTrue(self.active)
        self.insert_existing_boundary('2026-11-02T00:00:00Z')
        with self.assertRaisesRegex(ValueError, 'boundary-mismatch'):
            self.update(req)
        self.assertEqual(json.loads(self.config_file.read_text()), self.config)
        self.assertTrue(self.active)

    def test_update_requires_dependencies_and_preserves_old_flow_boundary(self):
        self.insert_existing_boundary()
        req = self.update_request()
        req['dependabot_enabled'] = True
        with self.assertRaises(ValueError):
            self.update(req)
        self.assertEqual(self.operations, [])
        self.config['projects'][0]['pr_flow_enrolled_at'] = '2026-11-03T00:00:00Z'
        self.config_file.write_text(json.dumps(self.config))
        req = self.update_request()
        req.update(pr_flow_enabled=True, pr_flow_app_author_id=2)
        with self.assertRaisesRegex(ValueError, 'existing-conflict'):
            self.update(req)
        self.assertEqual(self.operations, [])

    def test_update_external_change_after_stop_and_failed_restart_are_safe(self):
        self.insert_existing_boundary()
        req = self.update_request()
        req['promotion_enabled'] = True
        def changed(action, *args):
            self.operations.append(action)
            if action == 'stop':
                self.active = False
                self.config_file.write_text(json.dumps({**self.config, 'external': 'keep'}))
            if action == 'start': self.active = True
        with patch.object(self.module, 'systemctl', side_effect=changed):
            with self.assertRaisesRegex(RuntimeError, 'configuration-changed'):
                self.update(req)
        self.assertEqual(json.loads(self.config_file.read_text())['external'], 'keep')
        self.assertTrue(self.active)
        self.config_file.write_text(json.dumps(self.config))
        original = self.config_file.read_bytes()
        starts = 0
        def restart_fails(action, *args):
            nonlocal starts
            if action == 'stop': self.active = False
            if action == 'start':
                starts += 1
                if starts == 1: raise RuntimeError('service-operation-failed')
                self.active = True
        with patch.object(self.module, 'systemctl', side_effect=restart_fails):
            with self.assertRaisesRegex(RuntimeError, 'service-operation-failed'):
                self.update(req)
        self.assertEqual(self.config_file.read_bytes(), original)
        self.assertTrue(self.active)
        with sqlite3.connect(self.state) as db:
            self.assertEqual(db.execute('SELECT enrolled_at FROM project_boundaries WHERE repository_id=10').fetchone()[0],
                             self.existing['enrolled_at'])

    def test_update_failed_stop_and_competing_lock_never_change_config(self):
        self.insert_existing_boundary()
        req = self.update_request()
        req['promotion_enabled'] = True
        original = self.config_file.read_bytes()
        def failed_stop(action, *args):
            self.operations.append(action)
            if action == 'stop':
                self.active = False
                raise RuntimeError('service-operation-failed')
            if action == 'start': self.active = True
        with patch.object(self.module, 'systemctl', side_effect=failed_stop):
            with self.assertRaisesRegex(RuntimeError, 'service-operation-failed'):
                self.update(req)
        self.assertEqual(self.config_file.read_bytes(), original)
        self.assertTrue(self.active)
        self.operations.clear()
        fd = self.module.registration_lock(self.root, os.geteuid(), os.getegid())
        try:
            with self.assertRaises(BlockingIOError): self.update(req)
        finally:
            os.close(fd)
        self.assertEqual(self.operations, [])
        self.assertEqual(self.config_file.read_bytes(), original)

    def test_update_can_enable_initial_status_only_without_previous_boundary(self):
        self.config['projects'][0]['status_enabled'] = False
        self.config_file.write_text(json.dumps(self.config))
        req = self.update_request()
        self.assertEqual(self.update(req), 'updated')
        after = json.loads(self.config_file.read_text())['projects'][0]
        self.assertTrue(after['status_enabled'])
        self.assertEqual(after['enrolled_at'], self.existing['enrolled_at'])

    def test_update_requires_a_current_plan_even_for_noop(self):
        req = self.update_request()
        with self.assertRaisesRegex(ValueError, 'configuration-changed'):
            self.module.enroll(self.config_file, req, os.geteuid(), os.getegid(), update=True)
        self.assertEqual(self.operations, [])

    def test_cli_plan_then_apply_then_new_plan_is_noop(self):
        self.insert_existing_boundary()
        req = self.update_request()
        req['promotion_enabled'] = True
        def invoke(args, payload):
            incoming = io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode('utf-8')), encoding='utf-8')
            output = io.StringIO()
            with patch.object(self.module, 'CONFIG', self.config_file), \
                 patch.object(self.module.sys, 'argv', ['register_project.py', *args]), \
                 patch.object(self.module.sys, 'stdin', incoming), \
                 patch.object(self.module.sys, 'stdout', output), \
                 patch.object(self.module.sys, 'flags', SimpleNamespace(isolated=1)), \
                 patch.object(self.module.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getegid())), \
                 patch.object(self.module, 'secure_tools'), patch.object(self.module, 'require_root'), \
                 patch.object(self.module.signal, 'signal'):
                self.module.main()
            return json.loads(output.getvalue())
        planned = invoke(['--plan', '--update'], req)
        self.assertEqual(planned['result'], 'updated')
        self.assertEqual(planned['changes'], ['promotion_enabled'])
        self.assertNotIn('Owner', json.dumps(planned))
        apply_req = {**req, 'expected_config_sha256': planned['config_sha256']}
        self.assertEqual(invoke(['--apply', '--update'], apply_req), {'result': 'updated'})
        with self.assertRaisesRegex(ValueError, 'configuration-changed'):
            invoke(['--apply', '--update'], apply_req)
        repeated = invoke(['--plan', '--update'], req)
        self.assertEqual(repeated['result'], 'exists')
        self.assertEqual(repeated['changes'], [])
        self.assertEqual(invoke(['--apply', '--update'], {**req, 'expected_config_sha256': repeated['config_sha256']}),
                         {'result': 'exists'})
        self.assertEqual(self.operations, ['stop', 'start'])

    def test_root_guard_remains_required(self):
        with patch.object(self.module.os, 'geteuid', return_value=1000):
            with self.assertRaisesRegex(RuntimeError, 'root-required'):
                self.module.require_root()

    def test_prior_database_boundary_blocks_registration_and_restarts(self):
        with sqlite3.connect(self.state) as db:
            db.execute('INSERT INTO project_boundaries VALUES (?, ?)', (20, '2026-11-01T00:00:00Z'))
        original = self.config_file.read_bytes()
        with self.assertRaisesRegex(ValueError, 'previous-boundary-exists'): self.run_registration()
        self.assertEqual(self.config_file.read_bytes(), original)
        self.assertEqual(self.operations, ['stop', 'start'])
        self.assertTrue(self.active)

    def test_external_config_change_stops_update_and_is_preserved(self):
        def ctl(action, *args):
            self.operations.append(action)
            if action == 'stop':
                self.active = False
                self.config_file.write_text(json.dumps({**self.config, 'extra': 'newer'}), encoding='utf-8')
            elif action == 'start': self.active = True
        with patch.object(self.module, 'systemctl', side_effect=ctl):
            with self.assertRaisesRegex(RuntimeError, 'configuration-changed'): self.run_registration()
        self.assertEqual(json.loads(self.config_file.read_text())['extra'], 'newer')
        self.assertTrue(self.active)

    def test_failed_new_start_restores_config_without_restoring_database(self):
        original = self.config_file.read_bytes()
        starts = 0
        def ctl(action, *args):
            nonlocal starts
            self.operations.append(action)
            if action == 'stop': self.active = False
            if action == 'start':
                starts += 1
                if starts == 1:
                    # A service may have written after loading the new config;
                    # rollback must not restore an older SQLite snapshot.
                    with sqlite3.connect(self.state) as db:
                        db.execute('INSERT INTO project_boundaries VALUES (?, ?)', (20, '2026-11-13T00:00:00Z'))
                    raise RuntimeError('service-operation-failed')
                self.active = True
        with patch.object(self.module, 'systemctl', side_effect=ctl):
            with self.assertRaisesRegex(RuntimeError, 'service-operation-failed'): self.run_registration()
        self.assertEqual(self.config_file.read_bytes(), original)
        self.assertTrue(self.active)
        self.assertEqual(self.operations, ['stop', 'start', 'stop', 'start'])
        with sqlite3.connect(self.state) as db:
            self.assertIsNotNone(db.execute('SELECT 1 FROM project_boundaries WHERE repository_id=20').fetchone())

    def test_failed_stop_still_recovers_previous_service(self):
        def ctl(action, *args):
            self.operations.append(action)
            if action == 'stop':
                self.active = False
                raise RuntimeError('service-operation-failed')
            if action == 'start': self.active = True
        original = self.config_file.read_bytes()
        with patch.object(self.module, 'systemctl', side_effect=ctl):
            with self.assertRaisesRegex(RuntimeError, 'service-operation-failed'): self.run_registration()
        self.assertEqual(self.config_file.read_bytes(), original)
        self.assertEqual(self.operations, ['stop', 'start'])
        self.assertTrue(self.active)

    def test_config_changed_during_start_is_not_overwritten_by_recovery(self):
        def ctl(action, *args):
            self.operations.append(action)
            if action == 'stop': self.active = False
            if action == 'start':
                self.active = True
                data = json.loads(self.config_file.read_text(encoding='utf-8'))
                data['external_update'] = 'keep'
                self.config_file.write_text(json.dumps(data), encoding='utf-8')
        with patch.object(self.module, 'systemctl', side_effect=ctl):
            with self.assertRaisesRegex(RuntimeError, 'manual-recovery-required'): self.run_registration()
        self.assertEqual(json.loads(self.config_file.read_text(encoding='utf-8'))['external_update'], 'keep')
        self.assertEqual(self.operations, ['stop', 'start', 'stop'])

    def test_concurrent_registration_does_not_stop_service(self):
        fd = self.module.registration_lock(self.root, os.geteuid(), os.getegid())
        try:
            with self.assertRaises(BlockingIOError): self.run_registration()
        finally:
            os.close(fd)
        self.assertEqual(self.operations, [])

    def test_invalid_request_cannot_enable_conflicting_owners(self):
        self.request.update(dependabot_enabled=True, admission_enabled=False)
        with self.assertRaises(ValueError): self.run_registration()
        self.assertEqual(self.operations, [])

    def test_real_validator_is_invoked_as_service_user_in_isolated_python(self):
        result = SimpleNamespace(returncode=0, stdout=b'ok\n')
        with patch.object(self.module.subprocess, 'run', return_value=result) as run:
            self.original_validate(self.config)
        command = run.call_args.args[0]
        self.assertEqual(command[:6], ['/usr/sbin/runuser', '-u', 'agent-flow', '--', '/usr/bin/python3', '-I'])
        self.assertEqual(Path(command[-1]).name, 'validate_registration.py')

    def test_real_database_backup_is_invoked_as_service_user(self):
        result = SimpleNamespace(returncode=0, stdout=b'ok\n')
        with patch.object(self.module.subprocess, 'run', return_value=result) as run:
            self.original_backup(self.state, 20)
        command = run.call_args.args[0]
        self.assertEqual(command[:6], ['/usr/sbin/runuser', '-u', 'agent-flow', '--', '/usr/bin/python3', '-I'])
        self.assertEqual(command[-1], '--backup')

    def test_installed_validator_selects_current_release_not_stale_root_source(self):
        spec = importlib.util.spec_from_file_location('validate_registration', ROOT / 'scripts/validate_registration.py')
        validator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(validator)
        tools = self.root / 'tools'
        tools.mkdir()
        script = tools / 'validate_registration.py'
        script.touch()
        (self.root / 'src').mkdir()
        self.assertEqual(validator.controller_source(script), self.root / 'current/src')


    def test_registers_explicitly_prepared_flow_and_preserves_one_boundary(self):
        self.request.update(status_enabled=True, pr_flow_enabled=True, admission_enabled=True,
                            promotion_enabled=True, dependabot_enabled=True,
                            trusted_author_ids=[2, 3], pr_flow_app_author_id=3,
                            admission_tests=[{'context': 'verify', 'app_id': 15368}])
        self.assertEqual(self.run_registration(), 'registered')
        record = json.loads(self.config_file.read_text(encoding='utf-8'))['projects'][1]
        self.assertTrue(all(record[flag] for flag in self.module.FLAGS))
        self.assertEqual(record['enrolled_at'], record['pr_flow_enrolled_at'])
        self.assertEqual(self.run_registration(), 'exists')
        self.assertEqual(self.operations, ['stop', 'start'])

    def test_inactive_service_never_writes_or_starts(self):
        self.active = False
        original = self.config_file.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'service-not-active'): self.run_registration()
        self.assertEqual(self.config_file.read_bytes(), original)
        self.assertEqual(self.operations, [])

    @unittest.skipUnless(hasattr(os, 'geteuid') and os.geteuid() == 0, 'root-owned temporary files required')
    def test_rejects_helper_writable_by_other_users(self):
        script = self.root / 'register_project.py'
        validator = self.root / 'validate_registration.py'
        script.write_text('fixture', encoding='utf-8')
        validator.write_text('fixture', encoding='utf-8')
        validator.chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'unsafe-helper'):
            self.module.secure_tools(script)

    @unittest.skipUnless(hasattr(os, 'geteuid') and os.geteuid() == 0, 'root process required')
    def test_validator_refuses_root_before_importing_controller(self):
        scripts = self.root / 'scripts'
        src = self.root / 'src'
        scripts.mkdir()
        src.mkdir()
        validator = scripts / 'validate_registration.py'
        validator.write_bytes((ROOT / 'scripts/validate_registration.py').read_bytes())
        marker = self.root / 'imported-as-root'
        (src / 'mvp_service.py').write_text(f"open({str(marker)!r}, 'w').write('bad')", encoding='utf-8')
        result = subprocess.run([sys.executable, '-I', str(validator)], input='{}',
                                text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
