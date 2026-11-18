"""Durable deployment coordination, independent of any project runtime.

This ledger does not choose promotions or run project commands. Callers must
verify branch and CI before reserving work and must authenticate the executor.
"""
import json
import os
import re
import sqlite3
import stat
from contextlib import closing, contextmanager
from pathlib import Path

SHA = re.compile(r'^[0-9a-f]{40}$')
IDENT = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$')
APPLICATION_ID = 0x41474450


def _request(request):
    if not isinstance(request, dict) or set(request) != {'id', 'repository_id', 'target', 'commit', 'changes'}:
        raise ValueError('Invalid deployment request')
    if (not isinstance(request['id'], str) or not IDENT.fullmatch(request['id'])
            or type(request['repository_id']) is not int or request['repository_id'] <= 0
            or request['target'] not in ('smoke', 'main') or not isinstance(request['commit'], str)
            or not SHA.fullmatch(request['commit']) or not isinstance(request['changes'], list)
            or any(not isinstance(x, str) or not IDENT.fullmatch(x) for x in request['changes'])
            or len(set(request['changes'])) != len(request['changes'])):
        raise ValueError('Invalid deployment request')
    return json.dumps(request, sort_keys=True, separators=(',', ':'))


class DeploymentState:
    def __init__(self, path):
        self.path = Path(path).absolute()

    def initialize(self):
        # Explicit bootstrap only. Never silently replace lost deployment state.
        fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('PRAGMA synchronous=FULL')
            db.execute(f'PRAGMA application_id={APPLICATION_ID}')
            db.execute('PRAGMA user_version=1')
            db.execute('CREATE TABLE deployment (sequence INTEGER PRIMARY KEY AUTOINCREMENT, repository_id INTEGER NOT NULL, '
                       'deployment_id TEXT NOT NULL, request TEXT NOT NULL, '
                       "status TEXT NOT NULL CHECK(status IN ('reserved','running','succeeded','failed','unknown','superseded')), "
                       'result TEXT, UNIQUE(repository_id,deployment_id))')

    def _connect(self):
        info = os.lstat(self.path)
        if not stat.S_ISREG(info.st_mode) or (os.name == 'posix' and (info.st_uid != os.geteuid() or info.st_mode & 0o077)):
            raise ValueError('Deployment state must be a private service-owned file')
        db = sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True, timeout=5)
        if (db.execute('PRAGMA application_id').fetchone()[0] != APPLICATION_ID
                or db.execute('PRAGMA user_version').fetchone()[0] != 1):
            db.close()
            raise ValueError('Invalid deployment state')
        db.execute('PRAGMA synchronous=FULL')
        return db

    def reserve(self, request):
        encoded = _request(request)
        with closing(self._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute('SELECT request,status FROM deployment WHERE repository_id=? AND deployment_id=?',
                                  (request['repository_id'], request['id'])).fetchone()
            if existing:
                if existing[0] != encoded:
                    raise ValueError('Deployment identifier reused')
                return existing[1]
            row = db.execute('SELECT request,status FROM deployment WHERE repository_id=? ORDER BY sequence DESC LIMIT 1',
                             (request['repository_id'],)).fetchone()
            if row and row[1] not in ('succeeded', 'superseded'):
                raise ValueError('Previous deployment is unresolved')
            db.execute('INSERT INTO deployment(repository_id,deployment_id,request,status,result) VALUES(?,?,?,?,NULL)',
                       (request['repository_id'], request['id'], encoded, 'reserved'))
            return 'reserved'

    def transition(self, request, old, new, result=None):
        encoded = _request(request)
        allowed = {('reserved', 'running'), ('reserved', 'superseded'), ('running', 'succeeded'), ('running', 'failed'),
                   ('running', 'unknown'), ('unknown', 'succeeded'), ('unknown', 'failed')}
        if (old, new) not in allowed or (result is not None and (not isinstance(result, str) or len(result) > 500)):
            raise ValueError('Invalid deployment transition')
        with closing(self._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            cur = db.execute('UPDATE deployment SET status=?,result=? WHERE repository_id=? AND deployment_id=? AND request=? AND status=?',
                             (new, result, request['repository_id'], request['id'], encoded, old))
            if cur.rowcount != 1:
                raise ValueError('Deployment state changed')
            return new

    def get(self, repository_id):
        if type(repository_id) is not int or repository_id <= 0:
            raise ValueError('Invalid repository')
        with closing(self._connect()) as db:
            row = db.execute('SELECT request,status,result FROM deployment WHERE repository_id=? ORDER BY sequence DESC LIMIT 1', (repository_id,)).fetchone()
        return None if row is None else {'request': json.loads(row[0]), 'status': row[1], 'result': row[2]}

    @contextmanager
    def promotion_guard(self, repository_id):
        """Hold the ledger write lock across a promotion step for this project."""
        if type(repository_id) is not int or repository_id <= 0:
            raise ValueError('Invalid repository')
        with closing(self._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            def ready(main_sha):
                if not isinstance(main_sha, str) or not SHA.fullmatch(main_sha):
                    return False
                rows = db.execute('SELECT request,status FROM deployment WHERE repository_id=? ORDER BY sequence DESC',
                                  (repository_id,)).fetchall()
                if not rows or rows[0][1] not in ('succeeded', 'superseded'):
                    return False
                for encoded, status in rows:
                    request = json.loads(encoded)
                    if request['target'] == 'main' and status == 'succeeded':
                        return request['commit'] == main_sha
                return False
            yield ready
