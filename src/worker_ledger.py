"""Experimental durable import of ingress IDs; no GitHub work is performed.

The separate ledger leaves the validated ingress schema intact. A caller must
hold the configured shared lock for a complete scan and restart scans from None.
This model can claim one ID and conservatively flag interrupted claims, but
does not execute a controller, authorize retries or complete work.
"""
import fcntl
import hmac
import os
import re
import sqlite3
import stat
import tempfile
from pathlib import Path

import webhook_ingress as ingress

APP_ID = 0x41474632
SCHEMA_VERSION = 7
TABLE_SQL = """CREATE TABLE pending_deliveries (
            delivery_id TEXT PRIMARY KEY,
            state TEXT NOT NULL CHECK (state IN ('pending','running','recovering','uncertain')),
            ref_intent INTEGER NOT NULL CHECK (ref_intent IN (0,1)),
            status_intent INTEGER NOT NULL CHECK (status_intent IN (0,1)),
            status_key_id INTEGER,
            status_mac TEXT,
            CHECK (state != 'pending' OR (ref_intent = 0 AND status_intent = 0)),
            CHECK ((status_intent = 0 AND status_key_id IS NULL AND status_mac IS NULL) OR
                   (status_intent = 1 AND typeof(status_key_id) = 'integer' AND status_key_id BETWEEN 1 AND 9007199254740991 AND
                    typeof(status_mac) = 'text' AND length(status_mac) = 64 AND status_mac NOT GLOB '*[^0-9a-f]*'))
        )"""
ONE_ACTIVE_SQL = """CREATE UNIQUE INDEX ledger_one_active ON pending_deliveries ((1))
                    WHERE state != 'pending'"""


class Busy(Exception):
    pass


def valid_status_commitment(value):
    return (type(value) is dict and set(value) == {'kind', 'keyId', 'mac'}
            and value['kind'] == 'worker-status-commitment'
            and type(value['keyId']) is int and 0 < value['keyId'] <= 2**53 - 1
            and isinstance(value['mac'], str) and re.fullmatch(r'[0-9a-f]{64}', value['mac']) is not None)


class Ledger:
    """A POSIX owner and shared lock path; configuration must be trusted."""

    def __init__(self, path, lock_path, *, allow_create=False):
        if type(allow_create) is not bool:
            raise ValueError("Invalid bootstrap mode")
        self.path = os.path.abspath(os.fspath(path))
        self.lock_path = os.path.abspath(os.fspath(lock_path))
        self.allow_create = allow_create
        if self.path == self.lock_path:
            raise ValueError("Ledger and lock paths must differ")
        self.lock_fd = None
        self.db = None

    def __enter__(self):
        if self.lock_fd is not None or self.db is not None:
            raise RuntimeError("Ledger is already entered")
        parent = os.lstat(os.path.dirname(self.path))
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o077:
            raise ValueError("Unsafe ledger directory")
        lock_parent = os.lstat(os.path.dirname(self.lock_path))
        if not stat.S_ISDIR(lock_parent.st_mode) or lock_parent.st_uid != os.geteuid() or lock_parent.st_mode & 0o077:
            raise ValueError("Unsafe lock directory")
        self.lock_fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            lock_stat = os.fstat(self.lock_fd)
            if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_uid != os.geteuid() or lock_stat.st_mode & 0o077:
                raise ValueError("Unsafe lock file")
            try:
                fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise Busy("Worker already running") from exc
            try:
                ingress.check_storage(self.path)
            except FileNotFoundError:
                if not self.allow_create:
                    raise
                self._create_new()
                ingress.check_storage(self.path)
            self.db = sqlite3.connect(Path(self.path).as_uri() + "?mode=rw", uri=True, timeout=2)
            self.db.execute("PRAGMA synchronous=EXTRA")
            self._check()
            # Lock ownership changed. A previous owner might have performed an
            # external action before it died; never silently requeue a claim.
            self.db.execute("BEGIN IMMEDIATE")
            self._check()
            self.db.execute("UPDATE pending_deliveries SET state='uncertain' WHERE state IN ('running','recovering')")
            self.db.commit()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def _create_new(self):
        """Publish a complete new database without replacing an existing path."""
        directory = os.path.dirname(self.path)
        if any(os.path.lexists(self.path + suffix) for suffix in ("-journal", "-wal", "-shm")):
            raise ValueError("Unexpected orphan ledger sidecar")
        fd, temporary = tempfile.mkstemp(prefix=".agf-ledger-init-", dir=directory)
        os.close(fd)
        try:
            db = sqlite3.connect(Path(temporary).as_uri() + "?mode=rw", uri=True, timeout=2)
            try:
                if db.execute("PRAGMA journal_mode=DELETE").fetchone()[0] != "delete":
                    raise ValueError("Unexpected ledger journal")
                db.execute("PRAGMA synchronous=EXTRA")
                db.execute("BEGIN IMMEDIATE")
                db.execute(f"PRAGMA application_id={APP_ID}")
                db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
                db.execute(TABLE_SQL)
                db.execute(ONE_ACTIVE_SQL)
                db.commit()
            finally:
                db.close()
            fd = os.open(temporary, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            os.link(temporary, self.path, follow_symlinks=False)
            dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        finally:
            os.unlink(temporary)

    def _check(self):
        if self.db is None or self.lock_fd is None:
            raise RuntimeError("Ledger not locked")
        current = os.stat(self.lock_path, follow_symlinks=False)
        held = os.fstat(self.lock_fd)
        if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino):
            raise ValueError("Ledger lock replaced")
        if (self.db.execute("PRAGMA application_id").fetchone()[0] != APP_ID
                or self.db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION
                or self.db.execute("PRAGMA journal_mode").fetchone()[0] != "delete"
                or self.db.execute("PRAGMA synchronous").fetchone()[0] != 3):
            raise ValueError("Unknown ledger")
        objects = self.db.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").fetchall()
        if objects != [("index", "ledger_one_active", "pending_deliveries", ONE_ACTIVE_SQL),
                       ("table", "pending_deliveries", "pending_deliveries", TABLE_SQL),
                       ("index", "sqlite_autoindex_pending_deliveries_1", "pending_deliveries", None)]:
            raise ValueError("Unknown ledger schema")

    def import_ids(self, delivery_ids):
        """Idempotently import a bounded observed page; not a claim or ack."""
        if (not isinstance(delivery_ids, list) or len(delivery_ids) > 100
                or not all(ingress.canonical_delivery(value) for value in delivery_ids)):
            raise ValueError("Invalid delivery IDs")
        self._check()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._check()
            self.db.executemany("INSERT OR IGNORE INTO pending_deliveries VALUES (?, 'pending', 0, 0, NULL, NULL)", ((x,) for x in delivery_ids))
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def pending_preview(self, limit=100):
        """Return at most one bounded preview, not an exhaustive work scan."""
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Invalid preview limit")
        self._check()
        values = [row[0] for row in self.db.execute("SELECT delivery_id FROM pending_deliveries WHERE state='pending' ORDER BY delivery_id LIMIT ?", (limit,))]
        if not all(ingress.canonical_delivery(value) for value in values):
            raise ValueError("Invalid stored delivery ID")
        return values

    def claim_next(self):
        """Durably claim one pending ID; do not proceed past uncertain work."""
        self._check()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._check()
            busy = self.db.execute("SELECT 1 FROM pending_deliveries WHERE state != 'pending' LIMIT 1").fetchone()
            if busy:
                self.db.commit()
                return {"kind": "blocked"}
            row = self.db.execute("SELECT delivery_id FROM pending_deliveries WHERE state='pending' ORDER BY delivery_id LIMIT 1").fetchone()
            if row is None:
                self.db.commit()
                return {"kind": "empty"}
            if not ingress.canonical_delivery(row[0]):
                raise ValueError("Invalid stored delivery ID")
            self.db.execute("UPDATE pending_deliveries SET state='running' WHERE delivery_id=? AND state='pending'", (row[0],))
            self.db.commit()
            return {"kind": "claimed", "deliveryId": row[0]}
        except BaseException:
            self.db.rollback()
            raise

    def states_preview(self, limit=100):
        """Bounded diagnostics; these IDs are private metadata."""
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Invalid preview limit")
        self._check()
        return self.db.execute("SELECT delivery_id,state,ref_intent,status_intent FROM pending_deliveries ORDER BY delivery_id LIMIT ?", (limit,)).fetchall()

    def blocking_preview(self, limit=100):
        """Expose bounded blocking records even behind many pending IDs."""
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Invalid preview limit")
        self._check()
        return self.db.execute("""SELECT delivery_id,state,ref_intent,status_intent FROM pending_deliveries
                                  WHERE state != 'pending'
                                  ORDER BY delivery_id LIMIT ?""", (limit,)).fetchall()

    def record_intent(self, delivery_id, operation, commitment=None):
        """Record intent and its trusted status binding; perform no mutation."""
        if (not ingress.canonical_delivery(delivery_id) or operation not in ('ref', 'status')
                or (operation == 'status' and not valid_status_commitment(commitment))
                or (operation == 'ref' and commitment is not None)):
            raise ValueError("Invalid intent")
        self._check()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._check()
            if operation == 'ref':
                updated = self.db.execute("""UPDATE pending_deliveries SET ref_intent=1
                                              WHERE delivery_id=? AND state='running' AND ref_intent=0""", (delivery_id,))
            else:
                updated = self.db.execute("""UPDATE pending_deliveries SET status_intent=1,status_key_id=?,status_mac=?
                                              WHERE delivery_id=? AND state='running' AND status_intent=0""",
                                          (commitment['keyId'], commitment['mac'], delivery_id))
            if updated.rowcount != 1:
                raise ValueError("No running claim")
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def status_key_id(self, delivery_id):
        """Return the historical key ID, not the private stored commitment."""
        if not ingress.canonical_delivery(delivery_id):
            raise ValueError("Invalid recovery ID")
        self._check()
        row = self.db.execute("SELECT status_key_id FROM pending_deliveries WHERE delivery_id=? AND status_intent=1",
                              (delivery_id,)).fetchone()
        return None if row is None else row[0]

    def begin_status_recovery(self, delivery_id, commitment):
        """Reserve inspection only; this grants no write or retry permission.

        An uncertain ref or missing status intent requires a different recovery
        path. A fresh full wait and GitHub/checkpoint reads remain mandatory in
        the future controller adapter; this storage method performs none.
        """
        if not ingress.canonical_delivery(delivery_id) or not valid_status_commitment(commitment):
            raise ValueError("Invalid recovery ID")
        self._check()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._check()
            row = self.db.execute("""SELECT status_key_id,status_mac FROM pending_deliveries
                                     WHERE delivery_id=? AND state='uncertain' AND ref_intent=0 AND status_intent=1""",
                                  (delivery_id,)).fetchone()
            if row is None or row[0] != commitment['keyId'] or not hmac.compare_digest(row[1], commitment['mac']):
                raise ValueError("Status binding mismatch")
            updated = self.db.execute("""UPDATE pending_deliveries SET state='recovering'
                                         WHERE delivery_id=? AND state='uncertain'
                                           AND ref_intent=0 AND status_intent=1""", (delivery_id,))
            if updated.rowcount != 1:
                raise ValueError("Status recovery not applicable")
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def record_recovery_ref_intent(self, delivery_id):
        """Preserve both risks; the caller must separately authorize the write.

        No waiting, snapshot verification or GitHub operation occurs here.
        """
        if not ingress.canonical_delivery(delivery_id):
            raise ValueError("Invalid recovery ID")
        self._check()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._check()
            updated = self.db.execute("""UPDATE pending_deliveries SET ref_intent=1
                                         WHERE delivery_id=? AND state='recovering'
                                           AND ref_intent=0 AND status_intent=1""", (delivery_id,))
            if updated.rowcount != 1:
                raise ValueError("Ref intent not applicable")
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def import_page(self, ingress_path, fingerprint_key, after=None, limit=100):
        """Import one current page; caller restarts the next pass at None."""
        self._check()
        page = ingress.scan_delivery_ids(ingress_path, fingerprint_key, after=after, limit=limit)
        if page.get("kind") != "page":
            return {"kind": "blocked"}
        self.import_ids(page["deliveryIds"])
        ids = page["deliveryIds"]
        return {"kind": "page-imported", "nextAfter": ids[-1] if ids else None, "more": page["more"]}

    def __exit__(self, *_):
        try:
            if self.db is not None:
                self.db.close()
        finally:
            self.db = None
            if self.lock_fd is not None:
                os.close(self.lock_fd)
                self.lock_fd = None
