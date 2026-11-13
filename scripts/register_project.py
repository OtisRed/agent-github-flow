#!/usr/bin/python3 -I
"""Register one explicitly selected project in the existing controller.

Run on the controller host as root from a reviewed, root-owned release. The
request is JSON on stdin, not shell arguments; output contains no project data.
"""
import argparse
import contextlib
import copy
import fcntl
import json
import os
import pwd
import re
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

CONFIG = Path('/etc/agent-github-flow-mvp/config.json')
SERVICE = 'agent-github-flow-mvp.service'
FLAGS = ('status_enabled', 'pr_flow_enabled', 'admission_enabled', 'promotion_enabled', 'dependabot_enabled')
REQUIRED = {'repository_id', 'owner', 'repository', 'project_owner', 'project_number', 'trusted_author_ids', *FLAGS}
OPTIONAL = {'pr_flow_app_author_id', 'admission_tests', 'admission_sync_bot_id', 'admission_workflow',
            'admission_gate_job', 'admission_workflow_event', 'admission_retry_targets'}


def validate_candidate(config, entry=None):
    """Run the deployed controller's validators only as its unprivileged user."""
    helper = Path(__file__).resolve().with_name('validate_registration.py')
    result = subprocess.run(['/usr/sbin/runuser', '-u', 'agent-flow', '--', '/usr/bin/python3', '-I', str(helper)],
                            input=json.dumps({'config': config, 'entry': entry}).encode('utf-8'),
                            capture_output=True, timeout=30, check=False,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'})
    if result.returncode != 0 or result.stdout.strip() != b'ok':
        raise ValueError('validation-failed')


def plan(config, request, now):
    """Return an unchanged config for an existing match; never move a boundary."""
    validate_candidate(config)
    if not isinstance(request, dict) or not REQUIRED <= request.keys() or request.keys() - REQUIRED - OPTIONAL:
        raise ValueError('invalid-request')
    for field in ('owner', 'project_owner'):
        if not isinstance(request[field], str) or not re.fullmatch(r'[A-Za-z0-9-]{1,39}', request[field]):
            raise ValueError('invalid-identity')
    if (not isinstance(request['repository'], str)
            or not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', request['repository'])
            or request['repository'] in ('.', '..')
            or type(request['repository_id']) is not int or request['repository_id'] <= 0
            or type(request['project_number']) is not int or request['project_number'] <= 0
            or any(type(request[flag]) is not bool for flag in FLAGS)):
        raise ValueError('invalid-identity')
    authors = request['trusted_author_ids']
    if (not isinstance(authors, list) or not authors or any(type(a) is not int or a <= 0 for a in authors)
            or len(set(authors)) != len(authors)):
        raise ValueError('invalid-authors')
    if request['pr_flow_enabled'] is not True and 'pr_flow_app_author_id' in request:
        raise ValueError('invalid-pr-flow')
    admission_fields = OPTIONAL - {'pr_flow_app_author_id'}
    if not request['admission_enabled'] and request.keys() & admission_fields:
        raise ValueError('invalid-admission')
    matches = [p for p in config['projects'] if p['repository_id'] == request['repository_id']
               or (str(p.get('owner', '')).lower(), str(p.get('repository', '')).lower())
               == (request['owner'].lower(), request['repository'].lower())]
    if matches:
        if len(matches) != 1:
            raise ValueError('existing-conflict')
        existing = matches[0]
        for key, value in request.items():
            old = existing.get(key, key == 'status_enabled') if key in FLAGS else existing.get(key)
            if key in ('owner', 'repository', 'project_owner') and isinstance(old, str):
                old, value = old.lower(), value.lower()
            if old != value:
                raise ValueError('existing-conflict')
        return config, 'exists'
    entry = copy.deepcopy(request)
    entry['enrolled_at'] = now
    if entry['pr_flow_enabled']:
        entry['pr_flow_enrolled_at'] = now
    candidate = copy.deepcopy(config)
    candidate['projects'].append(entry)
    validate_candidate(candidate, entry)
    return candidate, 'new'


def private_file(path, uid):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
            raise ValueError('unsafe-file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(65537)
        if not data or len(data) > 65536:
            raise ValueError('invalid-file')
        return data
    finally:
        os.close(fd)


def private_dir(path, uid):
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
        raise ValueError('unsafe-directory')


def save_private(directory, prefix, data, uid, gid):
    fd, filename = tempfile.mkstemp(prefix=prefix, dir=directory)
    try:
        os.fchmod(fd, 0o600)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(fd)
    return Path(filename)


def systemctl(*args):
    result = subprocess.run(['/usr/bin/systemctl', *args, SERVICE], capture_output=True, timeout=30, check=False,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'})
    if result.returncode != 0:
        raise RuntimeError('service-operation-failed')


def healthy():
    try:
        systemctl('is-active', '--quiet')
        return True
    except (RuntimeError, subprocess.TimeoutExpired):
        return False


def database_backup(state, directory, uid, gid, repository_id):
    private_file_info = os.stat(state, follow_symlinks=False)
    if not stat.S_ISREG(private_file_info.st_mode) or private_file_info.st_uid != uid or private_file_info.st_mode & 0o077:
        raise ValueError('unsafe-state')
    source = sqlite3.connect(state.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    try:
        if source.execute('PRAGMA application_id').fetchone()[0] != 0x4147464D or source.execute('PRAGMA user_version').fetchone()[0] != 2:
            raise ValueError('invalid-state')
        if source.execute('SELECT 1 FROM project_boundaries WHERE repository_id=?', (repository_id,)).fetchone():
            raise ValueError('previous-boundary-exists')
        fd, target = tempfile.mkstemp(prefix='onboarding-state-', suffix='.sqlite', dir=directory)
        os.fchmod(fd, 0o600)
        os.fchown(fd, uid, gid)
        os.close(fd)
        with contextlib.closing(sqlite3.connect(target)) as copy_db:
            source.backup(copy_db)
            if copy_db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('invalid-backup')
        backup_fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(backup_fd)
        finally:
            os.close(backup_fd)
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        source.close()


def registration_lock(directory, uid, gid):
    path = directory / '.onboarding.lock'
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        fd = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.fchown(fd, uid, gid)
        except Exception:
            os.close(fd)
            raise
    except FileExistsError:
        fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
            raise ValueError('unsafe-registration-lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except Exception:
        os.close(fd)
        raise


def enroll(config_path, request, uid, gid):
    """Make one guarded update. Do not restore a SQLite snapshot automatically."""
    private_dir(config_path.parent, uid)
    original = private_file(config_path, uid)
    config = json.loads(original)
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    candidate, action = plan(config, request, now)
    if action == 'exists':
        return 'exists'
    state = Path(config['state_path'])
    private_dir(state.parent, uid)
    if not healthy():
        raise RuntimeError('service-not-active')
    registration_fd = registration_lock(state.parent, uid, gid)
    try:
        if private_file(config_path, uid) != original:
            raise RuntimeError('configuration-changed')
        return apply_candidate(config_path, request, config, candidate, original, state, uid, gid)
    finally:
        os.close(registration_fd)


def apply_candidate(config_path, request, config, candidate, original, state, uid, gid):
    if not healthy():
        raise RuntimeError('service-not-active')
    lock_path = str(state) + '.lock'
    # The same lock as the controller ensures no second instance is running.
    stopped = False
    changed = False
    new_bytes = (json.dumps(candidate, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if len(new_bytes) > 65536:
        raise ValueError('config-too-large')
    try:
        # A failed or timed-out stop can still take effect; always attempt to
        # restart the previously active service on the recovery path.
        stopped = True
        systemctl('stop')
        if healthy():
            raise RuntimeError('service-stop-unconfirmed')
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            info = os.fstat(lock_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
                raise ValueError('unsafe-lock')
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if private_file(config_path, uid) != original:
                raise RuntimeError('configuration-changed')
            database_backup(state, state.parent, uid, gid, request['repository_id'])
            save_private(config_path.parent, 'onboarding-config-backup-', original, uid, gid)
            staged = save_private(config_path.parent, '.onboarding-config-', new_bytes, uid, gid)
            if private_file(config_path, uid) != original:
                raise RuntimeError('configuration-changed')
            os.replace(staged, config_path)
            changed = True
            directory_fd = os.open(config_path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            os.close(lock_fd)
        systemctl('start')
        time.sleep(2)
        if not healthy():
            raise RuntimeError('service-start-unconfirmed')
        if private_file(config_path, uid) != new_bytes:
            raise RuntimeError('configuration-changed')
        return 'registered'
    except Exception:
        # Restore only the exact candidate we wrote, never a changed file or DB.
        if stopped:
            try:
                if changed:
                    systemctl('stop')
                    if healthy() or private_file(config_path, uid) != new_bytes:
                        raise RuntimeError('manual-recovery-required')
                    restored = save_private(config_path.parent, '.onboarding-restore-', original, uid, gid)
                    os.replace(restored, config_path)
                systemctl('start')
                if not healthy():
                    raise RuntimeError('manual-recovery-required')
            except Exception:
                raise RuntimeError('manual-recovery-required') from None
        raise


def secure_tools(script):
    """Root may execute only non-writable, root-owned helper code and parents."""
    script = Path(script)
    for file in (script, script.with_name('validate_registration.py')):
        info = os.stat(file, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('unsafe-helper')
    for directory in (script.parent, *script.parent.parents):
        info = os.stat(directory, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('unsafe-helper')


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--plan', action='store_true')
    mode.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('root-required')
    if not sys.flags.isolated:
        raise RuntimeError('isolated-mode-required')
    secure_tools(Path(__file__).absolute())
    def interrupted(_signum, _frame):
        raise RuntimeError('interrupted')
    for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)
    raw = sys.stdin.buffer.read(65537)
    if not raw or len(raw) > 65536:
        raise ValueError('invalid-request')
    account = pwd.getpwnam('agent-flow')
    request = json.loads(raw)
    if args.plan:
        private_dir(CONFIG.parent, account.pw_uid)
        config = json.loads(private_file(CONFIG, account.pw_uid))
        _, result = plan(config, request, datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
    else:
        result = enroll(CONFIG, request, account.pw_uid, account.pw_gid)
    print(json.dumps({'result': result}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Only closed-set codes are allowed; arbitrary exception text may be private.
        allowed = {'invalid-request', 'invalid-identity', 'invalid-authors', 'invalid-pr-flow',
                   'invalid-admission', 'existing-conflict', 'unsafe-file', 'unsafe-directory',
                   'invalid-file', 'service-not-active', 'service-operation-failed',
                   'service-stop-unconfirmed', 'service-start-unconfirmed', 'configuration-changed',
                   'manual-recovery-required', 'unsafe-state', 'invalid-state', 'previous-boundary-exists',
                   'invalid-backup', 'unsafe-lock', 'unsafe-registration-lock', 'config-too-large', 'root-required',
                   'validation-failed', 'unsafe-helper', 'isolated-mode-required', 'interrupted'}
        code = str(exc) if str(exc) in allowed else type(exc).__name__
        print(json.dumps({'result': 'failed', 'code': code}), file=sys.stderr)
        sys.exit(1)
