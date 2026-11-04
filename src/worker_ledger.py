"""Experimental durable import of ingress IDs; no GitHub work is performed.

The separate ledger leaves the validated ingress schema intact. A caller must
hold the configured shared lock for a complete scan and restart scans from None.
This model can claim one ID and conservatively flag interrupted claims, but
does not execute a controller or authorize retries. A trusted caller may
record a verified no-op; the ledger cannot verify the caller's conclusion.
"""
import fcntl
import hmac
import json
import os
import re
import sqlite3
import stat
import tempfile
from pathlib import Path
from datetime import datetime

import webhook_ingress as ingress

APP_ID = 0x41474632
SCHEMA_VERSION = 9
TABLE_SQL = """CREATE TABLE pending_deliveries (
            delivery_id TEXT PRIMARY KEY,
            state TEXT NOT NULL CHECK (state IN ('pending','running','recovering','uncertain','completed')),
            ref_intent INTEGER NOT NULL CHECK (ref_intent IN (0,1)),
            status_intent INTEGER NOT NULL CHECK (status_intent IN (0,1)),
            status_key_id INTEGER,
            status_mac TEXT,
            ref_transition TEXT,
            CHECK (state NOT IN ('pending','completed') OR (ref_intent = 0 AND status_intent = 0)),
            CHECK ((status_intent = 0 AND status_key_id IS NULL AND status_mac IS NULL) OR
                   (status_intent = 1 AND typeof(status_key_id) = 'integer' AND status_key_id BETWEEN 1 AND 9007199254740991 AND
                    typeof(status_mac) = 'text' AND length(status_mac) = 64 AND status_mac NOT GLOB '*[^0-9a-f]*')),
            CHECK (ref_transition IS NULL OR (ref_intent = 1 AND status_intent = 1 AND
                   typeof(ref_transition) = 'text' AND length(ref_transition) <= 4096))
        )"""
ONE_ACTIVE_SQL = """CREATE UNIQUE INDEX ledger_one_active ON pending_deliveries ((1))
                    WHERE state IN ('running','recovering','uncertain')"""


class Busy(Exception):
    pass


def valid_status_commitment(value):
    return (type(value) is dict and set(value) == {'kind', 'keyId', 'mac'}
            and value['kind'] == 'worker-status-commitment'
            and type(value['keyId']) is int and 0 < value['keyId'] <= 2**53 - 1
            and isinstance(value['mac'], str) and re.fullmatch(r'[0-9a-f]{64}', value['mac']) is not None)


def valid_ref_transition(value, delivery_id):
    keys = {'kind', 'operation', 'deliveryId', 'keyId', 'oldMac', 'nextMac',
            'oldOid', 'newOid', 'treeOid', 'reservedAt', 'mac'}
    if (type(value) is not dict or set(value) != keys or value['kind'] != 'worker-ref-transition'
            or value['operation'] != 'reservation' or value['deliveryId'] != delivery_id
            or type(value['keyId']) is not int or not 0 < value['keyId'] <= 2**53 - 1
            or any(not isinstance(value[k], str) or re.fullmatch(r'[0-9a-f]{64}', value[k]) is None
                   for k in ('oldMac', 'nextMac', 'mac'))
            or any(not isinstance(value[k], str) or re.fullmatch(r'[0-9a-f]{40}', value[k]) is None
                   or value[k] == '0' * 40 for k in ('oldOid', 'newOid', 'treeOid'))
            or value['oldOid'] == value['newOid'] or not isinstance(value['reservedAt'], str)):
        return False
    try:
        parsed = datetime.strptime(value['reservedAt'], '%Y-%m-%dT%H:%M:%SZ')
        canonical = (f"{parsed.year:04d}-{parsed.month:02d}-{parsed.day:02d}T"
                     f"{parsed.hour:02d}:{parsed.minute:02d}:{parsed.second:02d}Z")
        return canonical == value['reservedAt']
    except ValueError:
        return False


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
            self.db.executemany("INSERT OR IGNORE INTO pending_deliveries VALUES (?, 'pending', 0, 0, NULL, NULL, NULL)", ((x,) for x in delivery_ids))
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
            busy = self.db.execute("SELECT 1 FROM pending_deliveries WHERE state IN ('running','recovering','uncertain') LIMIT 1").fetchone()
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
                                  WHERE state IN ('running','recovering','uncertain')
                                  ORDER BY delivery_id LIMIT ?""", (limit,)).fetchall()

    def _record_verified_noop(self, delivery_id):
        """Record a no-op verified by a trusted caller, not by this ledger.

        This operation cannot resolve a potentially sent external mutation.
        The completed ID remains present for idempotent future imports.
        """
        if not ingress.canonical_delivery(delivery_id):
            raise ValueError("Invalid delivery ID")
        self._check()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._check()
            updated = self.db.execute("""UPDATE pending_deliveries SET state='completed'
                                         WHERE delivery_id=? AND state='running'
                                           AND ref_intent=0 AND status_intent=0""", (delivery_id,))
            if updated.rowcount != 1:
                raise ValueError("No eligible running no-op")
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def record_intent(self, delivery_id, operation, commitment=None):
        """Record intent and its trusted status binding; perform no mutation."""
        if type(commitment) is dict:
            commitment = commitment.copy()
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
        if type(commitment) is dict:
            commitment = commitment.copy()
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

    def record_recovery_ref_intent(self, delivery_id, transition):
        """Persist the supplied planned transition before any attempted write.

        This only checks its shape and old commitment. The trusted caller must
        verify the HMAC, plan, protection and GitHub evidence independently.
        """
        if type(transition) is dict:
            transition = transition.copy()
        if not ingress.canonical_delivery(delivery_id) or not valid_ref_transition(transition, delivery_id):
            raise ValueError("Invalid recovery ID")
        self._check()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._check()
            row = self.db.execute("""SELECT status_key_id,status_mac FROM pending_deliveries
                                     WHERE delivery_id=? AND state='recovering' AND ref_intent=0 AND status_intent=1""",
                                  (delivery_id,)).fetchone()
            if row is None or row[0] != transition['keyId'] or not hmac.compare_digest(row[1], transition['oldMac']):
                raise ValueError("Ref transition does not match status binding")
            encoded = json.dumps(transition, sort_keys=True, separators=(',', ':'))
            updated = self.db.execute("""UPDATE pending_deliveries SET ref_intent=1,ref_transition=?
                                         WHERE delivery_id=? AND state='recovering'
                                           AND ref_intent=0 AND status_intent=1""", (encoded, delivery_id))
            if updated.rowcount != 1:
                raise ValueError("Ref intent not applicable")
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def recovery_ref_transition(self, delivery_id):
        """Read private transition metadata for independent verification."""
        if not ingress.canonical_delivery(delivery_id):
            raise ValueError("Invalid recovery ID")
        self._check()
        row = self.db.execute("""SELECT status_key_id,status_mac,ref_transition FROM pending_deliveries
                                 WHERE delivery_id=? AND ref_intent=1 AND status_intent=1""", (delivery_id,)).fetchone()
        if row is None or row[2] is None:
            return None
        try:
            value = json.loads(row[2])
        except (ValueError, TypeError):
            raise ValueError("Invalid ref transition") from None
        if (not valid_ref_transition(value, delivery_id) or value['keyId'] != row[0]
                or not hmac.compare_digest(value['oldMac'], row[1])):
            raise ValueError("Invalid ref transition")
        return value

    def _record_verified_recovery_ref(self, delivery_id, transition):
        """Persist a trusted supervisor's fully verified ref observation.

        This method compares a plan; it does NOT verify HMAC, ACK, GitHub,
        tree, parent, protection or fresh snapshots. It must not be exposed to
        an untrusted caller or used until a verified adapter provides those.
        """
        if type(transition) is dict:
            transition = transition.copy()
        if not ingress.canonical_delivery(delivery_id) or not valid_ref_transition(transition, delivery_id):
            raise ValueError("Invalid ref transition")
        self._check()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._check()
            row = self.db.execute("""SELECT status_key_id,status_mac,ref_transition FROM pending_deliveries
                                     WHERE delivery_id=? AND state='recovering' AND ref_intent=1 AND status_intent=1""",
                                  (delivery_id,)).fetchone()
            encoded = json.dumps(transition, sort_keys=True, separators=(',', ':'))
            if (row is None or row[0] != transition['keyId'] or not hmac.compare_digest(row[1], transition['oldMac'])
                    or not isinstance(row[2], str) or not row[2].isascii() or not hmac.compare_digest(row[2], encoded)):
                raise ValueError("Ref transition mismatch")
            updated = self.db.execute("""UPDATE pending_deliveries SET status_mac=?,ref_intent=0,ref_transition=NULL
                                         WHERE delivery_id=? AND state='recovering' AND ref_intent=1 AND status_intent=1""",
                                      (transition['nextMac'], delivery_id))
            if updated.rowcount != 1:
                raise ValueError("Ref observation not applicable")
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
