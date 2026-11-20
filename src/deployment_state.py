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
            or not SHA.fullmatch(request['commit']) or not isinstance(request['changes'], list) or len(request['changes']) > 500
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
                if existing[1] in ('succeeded', 'superseded') and db.execute(
                        "SELECT 1 FROM deployment WHERE repository_id=? AND deployment_id<>? AND status NOT IN ('succeeded','superseded') LIMIT 1",
                        (request['repository_id'], request['id'])).fetchone():
                    raise ValueError('Previous deployment is unresolved')
                if existing[1] == 'superseded':
                    # Superseded is reachable only before dispatch. If the
                    # exact branch and request return, make this the newest
                    # attempt and require the caller to verify it again.
                    sequence = db.execute('SELECT COALESCE(MAX(sequence), 0) + 1 FROM deployment').fetchone()[0]
                    db.execute("UPDATE deployment SET sequence=?,status='reserved',result=NULL WHERE repository_id=? AND deployment_id=?",
                               (sequence, request['repository_id'], request['id']))
                    return 'reserved'
                return existing[1]
            row = db.execute("SELECT status FROM deployment WHERE repository_id=? AND status NOT IN ('succeeded','superseded') LIMIT 1",
                             (request['repository_id'],)).fetchone()
            if row:
                raise ValueError('Previous deployment is unresolved')
            db.execute('INSERT INTO deployment(repository_id,deployment_id,request,status,result) VALUES(?,?,?,?,NULL)',
                       (request['repository_id'], request['id'], encoded, 'reserved'))
            return 'reserved'

    def transition(self, request, old, new, result=None):
        encoded = _request(request)
        allowed = {('reserved', 'running'), ('reserved', 'superseded'), ('succeeded', 'unknown'), ('running', 'succeeded'), ('running', 'failed'),
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

    def requeue_unstarted(self, request):
        """Apply an operator-authorized retry to the exact unresolved dispatch."""
        encoded = _request(request)
        with closing(self._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            changed = db.execute(
                "UPDATE deployment SET status='reserved',result=NULL "
                "WHERE repository_id=? AND deployment_id=? AND request=? AND status='unknown' "
                "AND result IS NULL AND sequence=(SELECT MAX(sequence) FROM deployment WHERE repository_id=?)",
                (request['repository_id'], request['id'], encoded, request['repository_id']))
            if changed.rowcount != 1:
                raise ValueError('Deployment is no longer eligible for retry')
        return 'reserved'

    def get_attempt(self, request):
        encoded = _request(request)
        with closing(self._connect()) as db:
            row = db.execute('SELECT request,status,result FROM deployment WHERE repository_id=? AND deployment_id=?',
                             (request['repository_id'], request['id'])).fetchone()
        if row is None or row[0] != encoded:
            return None
        return {'request': json.loads(row[0]), 'status': row[1], 'result': row[2]}

    def unresolved(self, repository_id):
        if type(repository_id) is not int or repository_id <= 0:
            raise ValueError('Invalid repository')
        with closing(self._connect()) as db:
            row = db.execute("SELECT request,status,result FROM deployment WHERE repository_id=? AND status IN ('running','unknown','failed') ORDER BY sequence LIMIT 1", (repository_id,)).fetchone()
        return None if row is None else {'request': json.loads(row[0]), 'status': row[1], 'result': row[2]}

    def last_success(self, repository_id, target):
        if type(repository_id) is not int or repository_id <= 0 or target not in ('smoke', 'main'):
            raise ValueError('Invalid deployment lookup')
        with closing(self._connect()) as db:
            rows = db.execute("SELECT request FROM deployment WHERE repository_id=? AND status='succeeded' ORDER BY sequence DESC", (repository_id,)).fetchall()
        for row in rows:
            request = json.loads(row[0])
            if request['target'] == target:
                return request
        return None

    def has_uncertain(self, repository_id):
        if type(repository_id) is not int or repository_id <= 0:
            raise ValueError('Invalid repository')
        with closing(self._connect()) as db:
            row = db.execute("SELECT 1 FROM deployment WHERE repository_id=? AND status IN ('running','unknown','failed') LIMIT 1", (repository_id,)).fetchone()
        return row is not None

    def promotion_receipt(self, repository_id, candidate):
        if type(repository_id) is not int or repository_id <= 0 or not isinstance(candidate, str) or not SHA.fullmatch(candidate):
            raise ValueError('Invalid promotion identity')
        path = self.path.parent / f'promotion-{repository_id}-{candidate}.json'
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd, 'rb') as file:
            info = os.fstat(file.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_size > 100000
                    or (os.name == 'posix' and (info.st_uid != os.geteuid() or info.st_mode & 0o077))):
                raise ValueError('Invalid promotion receipt file')
            value = json.loads(file.read(100001).decode('utf-8'))
        if (not isinstance(value, dict) or set(value) != {'format', 'repository_id', 'base', 'candidate', 'pr_number', 'scope'}
                or value['format'] != 1 or value['repository_id'] != repository_id or value['candidate'] != candidate):
            raise ValueError('Invalid promotion receipt')
        return value

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
                if not rows or any(status not in ('succeeded', 'superseded') for _, status in rows):
                    return False
                for encoded, status in rows:
                    request = json.loads(encoded)
                    if request['target'] == 'main' and status != 'superseded':
                        return status == 'succeeded' and request['commit'] == main_sha
                return False
            def capture(plan, pr_number):
                """Durably record immutable accepted scope before GitHub merge."""
                if (not isinstance(plan, dict) or not isinstance(plan.get('main'), str) or not SHA.fullmatch(plan['main'])
                        or not isinstance(plan.get('plan'), dict) or plan['plan'].get('kind') != 'ready'
                        or not isinstance(plan['plan'].get('sha'), str) or not SHA.fullmatch(plan['plan']['sha'])
                        or type(pr_number) is not int or pr_number <= 0):
                    raise ValueError('Invalid promotion receipt')
                scope = plan.get('accepted_scope')
                if (not isinstance(scope, dict) or set(scope) != {'changes', 'commits'}
                        or not isinstance(scope['changes'], list) or not scope['changes']
                        or any(not isinstance(x, str) or not IDENT.fullmatch(x) for x in scope['changes'])
                        or len(set(scope['changes'])) != len(scope['changes'])
                        or not isinstance(scope['commits'], list) or not scope['commits']
                        or any(not isinstance(x, str) or not SHA.fullmatch(x) for x in scope['commits'])
                        or len(set(scope['commits'])) != len(scope['commits'])
                        or scope['commits'][-1] != plan['plan']['sha']
                        or len(scope['commits']) != plan['plan'].get('count')):
                    raise ValueError('Invalid promotion scope')
                receipt = {'format': 1, 'repository_id': repository_id, 'base': plan['main'],
                           'candidate': plan['plan']['sha'], 'pr_number': pr_number, 'scope': scope}
                data = json.dumps(receipt, sort_keys=True, separators=(',', ':')).encode('utf-8')
                path = self.path.parent / f'promotion-{repository_id}-{receipt["candidate"]}.json'
                try:
                    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
                except FileExistsError:
                    if self.promotion_receipt(repository_id, receipt['candidate']) != receipt:
                        raise ValueError('Conflicting promotion receipt') from None
                    return receipt
                with os.fdopen(fd, 'wb') as out:
                    out.write(data); out.flush(); os.fsync(out.fileno())
                if os.name == 'posix':
                    directory = os.open(self.path.parent, os.O_RDONLY)
                    try: os.fsync(directory)
                    finally: os.close(directory)
                return receipt
            ready.capture = capture
            yield ready
