"""Experimental durable import of ingress IDs; no GitHub work is performed.

The separate ledger leaves the validated ingress schema intact. A caller must
hold the configured shared lock for a complete scan and restart scans from None.
This model can claim one ID and conservatively flag interrupted claims, but
does not execute a controller, authorize retries or complete work.
"""
import fcntl
import os
import sqlite3
import stat
from pathlib import Path

import webhook_ingress as ingress

APP_ID = 0x41474632
SCHEMA_VERSION = 2
TABLE_SQL = """CREATE TABLE pending_deliveries (
            delivery_id TEXT PRIMARY KEY,
            state TEXT NOT NULL CHECK (state IN ('pending','running','uncertain'))
        )"""


class Busy(Exception):
    pass


class Ledger:
    """A POSIX owner and shared lock path; configuration must be trusted."""

    def __init__(self, path, lock_path):
        self.path = os.path.abspath(os.fspath(path))
        self.lock_path = os.path.abspath(os.fspath(lock_path))
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
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            except FileExistsError:
                new = False
            else:
                os.close(fd)
                new = True
            ingress.check_storage(self.path)
            self.db = sqlite3.connect(Path(self.path).as_uri() + "?mode=rw", uri=True, timeout=2)
            if new:
                if self.db.execute("PRAGMA journal_mode=DELETE").fetchone()[0] != "delete":
                    raise ValueError("Unexpected ledger journal")
                self.db.execute("PRAGMA synchronous=EXTRA")
                self.db.execute("BEGIN IMMEDIATE")
                self.db.execute(f"PRAGMA application_id={APP_ID}")
                self.db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
                self.db.execute(TABLE_SQL)
                self.db.commit()
            self.db.execute("PRAGMA synchronous=EXTRA")
            self._check()
            # Lock ownership changed. A previous owner might have performed an
            # external action before it died; never silently requeue a claim.
            self.db.execute("BEGIN IMMEDIATE")
            self._check()
            self.db.execute("UPDATE pending_deliveries SET state='uncertain' WHERE state='running'")
            self.db.commit()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

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
        if objects != [("table", "pending_deliveries", "pending_deliveries", TABLE_SQL),
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
            self.db.executemany("INSERT OR IGNORE INTO pending_deliveries VALUES (?, 'pending')", ((x,) for x in delivery_ids))
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
            busy = self.db.execute("SELECT 1 FROM pending_deliveries WHERE state IN ('running','uncertain') LIMIT 1").fetchone()
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
        return self.db.execute("SELECT delivery_id,state FROM pending_deliveries ORDER BY delivery_id LIMIT ?", (limit,)).fetchall()

    def blocking_preview(self, limit=100):
        """Expose bounded blocking records even behind many pending IDs."""
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Invalid preview limit")
        self._check()
        return self.db.execute("""SELECT delivery_id,state FROM pending_deliveries
                                  WHERE state IN ('running','uncertain')
                                  ORDER BY delivery_id LIMIT ?""", (limit,)).fetchall()

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
