"""Synthetic tests for safe controller registration; never touches systemd."""
import copy
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
