"""Exercise the exact remote health probe using a private temporary database."""
import contextlib
import io
import json
import pathlib
import re
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'backup-state-to-windows.ps1'
match = re.search(r"\$healthCode = @'\r?\n(.*?)\r?\n'@", SOURCE.read_text(encoding='utf-8'), re.S)
if not match:
    raise RuntimeError('Embedded backup health probe was not found')
PROBE = compile(match.group(1), 'backup-health-probe', 'exec')


class BackupHealthProbeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = pathlib.Path(self.directory.name) / 'state.sqlite'
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            db.execute('PRAGMA application_id=1095190093')  # 0x4147464D
            db.execute('PRAGMA user_version=2')
            db.execute('CREATE TABLE work_queue (position INTEGER)')
            db.execute('CREATE TABLE issues (error_code TEXT, uncertain_since REAL)')

    def run_probe(self, *, active=True, scan=True, journal_error=False, promotion_log='', promotion_no_match=False,
                  enabled=(10, 20), config_age=0, archive_enabled=False, archive_log=''):
        original_connect = sqlite3.connect
        config = json.dumps({'archive_enabled': archive_enabled,
                             'projects': [{'repository_id': n, 'promotion_enabled': True} for n in enabled]})

        def fake_connect(_path, **_kwargs):
            return original_connect(self.path.resolve().as_uri() + '?mode=ro', uri=True)

        def fake_run(args, **_kwargs):
            if args[0] == 'systemctl':
                return subprocess.CompletedProcess(args, 0 if active else 3, 'active\n' if active else 'inactive\n', '')
            if args[0] == 'journalctl':
                if 'FLOW archive:' in args[args.index('--grep') + 1]:
                    return subprocess.CompletedProcess(args, 0 if archive_log else 1, archive_log, '')
                if 'promotion' in args[args.index('--grep') + 1]:
                    return subprocess.CompletedProcess(args, 1 if journal_error or promotion_no_match else 0, promotion_log, '')
                return subprocess.CompletedProcess(args, 1 if journal_error else 0,
                    'FLOW scan: nightly candidates queued\n' if scan else '', '')
            raise AssertionError('Unexpected command')

        output = io.StringIO()
        with patch('sqlite3.connect', side_effect=fake_connect), patch('subprocess.run', side_effect=fake_run), \
                patch('time.time', return_value=1000), patch('os.path.getmtime', return_value=1000-config_age), \
                patch('builtins.open', return_value=io.StringIO(config)), contextlib.redirect_stdout(output):
            exec(PROBE, {})
        return json.loads(output.getvalue())

    def test_healthy_controller(self):
        self.assertEqual(self.run_probe(), {'service_active': True, 'nightly_scan_recent': True,
                                          'archive_state': 'off', 'queue': 0, 'errors': 0, 'uncertain': 0, 'promotion_errors': 0, 'promotion_missing': 0})

    def test_missing_scan_stopped_service_and_real_aggregate_state(self):
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO work_queue VALUES (1)')
            db.executemany('INSERT INTO issues VALUES (?, ?)', [('blocked', None), (None, 800), (None, 900)])
        self.assertEqual(self.run_probe(active=False, scan=False), {'service_active': False,
                         'nightly_scan_recent': False, 'archive_state': 'off', 'queue': 1, 'errors': 1, 'uncertain': 1, 'promotion_errors': 0, 'promotion_missing': 0})

    def test_archive_monitor_distinguishes_result_and_missing_run(self):
        self.assertEqual(self.run_probe(archive_enabled=True, config_age=172799)['archive_state'], 'pending')
        self.assertEqual(self.run_probe(archive_enabled=True, config_age=172800)['archive_state'], 'missing')
        self.assertEqual(self.run_probe(archive_enabled=True, archive_log='FLOW archive: nightly complete\n')['archive_state'], 'ok')
        self.assertEqual(self.run_probe(archive_enabled=True, archive_log='FLOW archive: nightly failed\n')['archive_state'], 'failed')
        self.assertEqual(self.run_probe(archive_enabled=True, archive_log='unexpected\n'), {'read_error': True})

    def test_promotion_errors_use_latest_result_for_each_repository(self):
        logs = ('FLOW attention: promotion-failed repo=10\n'
                'FLOW promotion: waiting repo=10\n'
                'FLOW attention: promotion-protection-required repo=20\n')
        self.assertEqual(self.run_probe(promotion_log=logs)['promotion_errors'], 1)

    def test_no_promotion_entries_is_not_a_read_error(self):
        self.assertEqual(self.run_probe(promotion_no_match=True)['promotion_errors'], 0)

    def test_missing_promotion_is_reported_after_48_hours(self):
        self.assertEqual(self.run_probe(enabled=(10,), config_age=172799)['promotion_missing'], 0)
        self.assertEqual(self.run_probe(enabled=(10,), config_age=172800)['promotion_missing'], 1)
        self.assertEqual(self.run_probe(enabled=(10,), config_age=172800,
                                       promotion_log='FLOW promotion: waiting repo=10\n')['promotion_missing'], 0)

    def test_disabled_project_does_not_raise_promotion_alarm(self):
        logs = 'FLOW attention: promotion-failed repo=20\n'
        self.assertEqual(self.run_probe(enabled=(10,), promotion_log=logs)['promotion_errors'], 0)

    def test_incomplete_promotion_is_reported(self):
        logs = 'FLOW attention: promotion-incomplete repo=10\n'
        self.assertEqual(self.run_probe(enabled=(10,), promotion_log=logs)['promotion_errors'], 1)

    def test_log_unavailable_is_not_reported_as_healthy(self):
        self.assertEqual(self.run_probe(journal_error=True), {'read_error': True})

    def test_unknown_database_schema_is_not_reported_as_healthy(self):
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            db.execute('PRAGMA user_version=99')
        self.assertEqual(self.run_probe(), {'read_error': True})


if __name__ == '__main__':
    unittest.main()
