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

    def run_probe(self, *, active=True, scan=True, journal_error=False):
        original_connect = sqlite3.connect

        def fake_connect(_path, **_kwargs):
            return original_connect(self.path.resolve().as_uri() + '?mode=ro', uri=True)

        def fake_run(args, **_kwargs):
            if args[0] == 'systemctl':
                return subprocess.CompletedProcess(args, 0 if active else 3, 'active\n' if active else 'inactive\n', '')
            if args[0] == 'journalctl':
                return subprocess.CompletedProcess(args, 1 if journal_error else 0,
                    'FLOW scan: nightly candidates queued\n' if scan else '', '')
            raise AssertionError('Unexpected command')

        output = io.StringIO()
        with patch('sqlite3.connect', side_effect=fake_connect), patch('subprocess.run', side_effect=fake_run), \
                patch('time.time', return_value=1000), contextlib.redirect_stdout(output):
            exec(PROBE, {})
        return json.loads(output.getvalue())

    def test_healthy_controller(self):
        self.assertEqual(self.run_probe(), {'service_active': True, 'nightly_scan_recent': True,
                                          'queue': 0, 'errors': 0, 'uncertain': 0})

    def test_missing_scan_stopped_service_and_real_aggregate_state(self):
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO work_queue VALUES (1)')
            db.executemany('INSERT INTO issues VALUES (?, ?)', [('blocked', None), (None, 800), (None, 900)])
        self.assertEqual(self.run_probe(active=False, scan=False), {'service_active': False,
                         'nightly_scan_recent': False, 'queue': 1, 'errors': 1, 'uncertain': 1})

    def test_log_unavailable_is_not_reported_as_healthy(self):
        self.assertEqual(self.run_probe(journal_error=True), {'read_error': True})

    def test_unknown_database_schema_is_not_reported_as_healthy(self):
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            db.execute('PRAGMA user_version=99')
        self.assertEqual(self.run_probe(), {'read_error': True})


if __name__ == '__main__':
    unittest.main()
