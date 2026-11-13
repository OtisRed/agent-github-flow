#!/usr/bin/env python3
"""Validate a candidate using controller code, always as the service user."""
import json
import contextlib
import os
import sqlite3
import stat
import tempfile
from pathlib import Path
import sys

def controller_source(script):
    location = Path(script).resolve()
    root = location.parents[1]
    # Installed tools live alongside the current release symlink. A stale
    # root/src from an older deployment must not shadow the running release.
    return root / 'current/src' if location.parent.name == 'tools' else root / 'src'


def backup_database(state, repository_id):
    """Read and copy the SQLite state using only service-user privileges."""
    state = Path(state)
    if type(repository_id) is not int or repository_id <= 0:
        raise ValueError('invalid-backup')
    info = os.stat(state, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError('unsafe-state')
    source = sqlite3.connect(state.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    try:
        if source.execute('PRAGMA application_id').fetchone()[0] != 0x4147464D or source.execute('PRAGMA user_version').fetchone()[0] != 2:
            raise ValueError('invalid-state')
        if source.execute('SELECT 1 FROM project_boundaries WHERE repository_id=?', (repository_id,)).fetchone():
            raise ValueError('previous-boundary-exists')
        fd, target = tempfile.mkstemp(prefix='onboarding-state-', suffix='.sqlite', dir=state.parent)
        os.fchmod(fd, 0o600)
        os.close(fd)
        with contextlib.closing(sqlite3.connect(target)) as copy_db:
            source.backup(copy_db)
            if copy_db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('invalid-backup')
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        fd = os.open(state.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        source.close()


def main():
    if os.geteuid() == 0:
        raise RuntimeError('service-user-required')
    raw = sys.stdin.buffer.read(131073)
    if not raw or len(raw) > 131072:
        raise ValueError('invalid')
    payload = json.loads(raw)
    if sys.argv[1:] == ['--backup']:
        backup_database(payload['state'], payload['repository_id'])
        print('ok')
        return
    if sys.argv[1:]:
        raise ValueError('invalid')
    sys.path.insert(0, str(controller_source(__file__)))
    from mvp_service import validate_config
    from pr_admission_github import AdmissionReader
    validate_config(payload['config'])
    entry = payload['entry']
    if entry is not None and entry['admission_enabled']:
        AdmissionReader(owner=entry['owner'], repository=entry['repository'], repository_id=entry['repository_id'],
                        token=lambda: None, transport=lambda *_: None,
                        workflow=entry.get('admission_workflow', 'ci.yml'),
                        gate_job=entry.get('admission_gate_job', 'verify'),
                        workflow_event=entry.get('admission_workflow_event', 'pull_request'),
                        sync_bot_id=entry.get('admission_sync_bot_id'),
                        required_tests=tuple((x['context'], x['app_id']) for x in entry['admission_tests']),
                        retry_targets=entry.get('admission_retry_targets'))
    print('ok')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        if str(exc) == 'previous-boundary-exists':
            print('previous-boundary-exists')
        sys.exit(1)
