"""Small SQLite store for the MVP controller; it does not perform GitHub I/O.

The receiver and the single worker must use the same protected database. A
pending generation is acknowledged only after processing, so a crash or an
event arriving during work cannot silently acknowledge the newer event.
"""
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path

APPLICATION_ID = 0x4147464D
SCHEMA_VERSION = 1
UNCERTAIN_WAIT_SECONDS = 120


def _positive(value):
    if type(value) is not int or not 0 < value < 2**63:
        raise ValueError("Expected a positive integer identifier")
    return value


class Store:
    """A store with explicit initialization; a missing database is an error."""

    def __init__(self, path, *, clock=time.time):
        self.path = Path(path).absolute()
        self.clock = clock

    def initialize(self):
        """Create once, explicitly. Never use this to recover lost state."""
        fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        # If initialization is interrupted, leave the incomplete file in place:
        # opening it will fail rather than silently treating it as fresh state.
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("PRAGMA synchronous=FULL")
            db.execute("BEGIN IMMEDIATE")
            db.execute(f"PRAGMA application_id={APPLICATION_ID}")
            db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            db.execute("""CREATE TABLE issues (
                repository_id INTEGER NOT NULL,
                issue_number INTEGER NOT NULL,
                generation INTEGER NOT NULL DEFAULT 0,
                completed_generation INTEGER NOT NULL DEFAULT 0,
                comment_id INTEGER,
                comment_digest TEXT,
                uncertain_since REAL,
                uncertain_target TEXT,
                PRIMARY KEY (repository_id, issue_number),
                CHECK (generation >= completed_generation),
                CHECK ((comment_id IS NULL) = (comment_digest IS NULL)),
                CHECK ((uncertain_since IS NULL) = (uncertain_target IS NULL))
            )""")

    def _connect(self):
        # mode=rw is essential: an absent state file must never be recreated.
        db = sqlite3.connect(self.path.as_uri() + "?mode=rw", uri=True, timeout=10)
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA synchronous=FULL")
            if (db.execute("PRAGMA application_id").fetchone()[0] != APPLICATION_ID
                    or db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION):
                raise ValueError("Unknown or incomplete MVP database")
            return db
        except BaseException:
            db.close()
            raise

    def enqueue(self, repository_id, issue_number):
        """Commit a wakeup before the caller returns a successful response."""
        key = (_positive(repository_id), _positive(issue_number))
        with closing(self._connect()) as db, db:
            db.execute("""INSERT INTO issues (repository_id, issue_number, generation)
                          VALUES (?, ?, 1)
                          ON CONFLICT (repository_id, issue_number)
                          DO UPDATE SET generation = generation + 1""", key)

    def next_pending(self):
        """Return a generation to inspect; only one worker may call this."""
        with closing(self._connect()) as db, db:
            row = db.execute("""SELECT * FROM issues
                WHERE generation > completed_generation
                ORDER BY repository_id, issue_number LIMIT 1""").fetchone()
            return dict(row) if row else None

    def begin_status_write(self, repository_id, issue_number, target):
        """Persist uncertainty before the caller sends a status mutation."""
        key = (_positive(repository_id), _positive(issue_number))
        if not isinstance(target, str) or not target or len(target) > 128:
            raise ValueError("Invalid target")
        with closing(self._connect()) as db, db:
            result = db.execute("""UPDATE issues SET uncertain_since=?, uncertain_target=?
                WHERE repository_id=? AND issue_number=? AND uncertain_since IS NULL
                  AND generation > completed_generation""", (self.clock(), target, *key))
            if result.rowcount != 1:
                raise ValueError("No pending issue or existing uncertain write")

    def recovery_ready(self, repository_id, issue_number):
        """Time gate only; the caller must also re-read GitHub before retry."""
        key = (_positive(repository_id), _positive(issue_number))
        with closing(self._connect()) as db, db:
            row = db.execute("SELECT uncertain_since FROM issues WHERE repository_id=? AND issue_number=?", key).fetchone()
            return bool(row and row[0] is not None and self.clock() - row[0] >= UNCERTAIN_WAIT_SECONDS)

    def resolve_status_write(self, repository_id, issue_number, *, target_observed):
        """Resolve only after the caller has freshly read the actual status.

        A confirmed target may be resolved immediately. Otherwise the 120s
        safety interval must have elapsed. The caller must still decide whether
        the freshly observed state warrants a retry; this method cannot verify
        the observation or prevent an exceptionally late request completing.
        """
        key = (_positive(repository_id), _positive(issue_number))
        if type(target_observed) is not bool:
            raise ValueError("Expected a verified observation")
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("""SELECT uncertain_since FROM issues
                WHERE repository_id=? AND issue_number=?""", key).fetchone()
            if row is None or row[0] is None:
                raise ValueError("No uncertain write")
            if not target_observed and self.clock() - row[0] < UNCERTAIN_WAIT_SECONDS:
                raise ValueError("Uncertain write is still within the waiting interval")
            result = db.execute("""UPDATE issues SET uncertain_since=NULL, uncertain_target=NULL
                WHERE repository_id=? AND issue_number=? AND uncertain_since IS NOT NULL""", key)
            if result.rowcount != 1:
                raise ValueError("No uncertain write")

    def complete(self, repository_id, issue_number, generation, *, comment_id=None, comment_digest=None):
        """Commit checked work and checkpoint, leaving newer wakeups pending."""
        key = (_positive(repository_id), _positive(issue_number))
        _positive(generation)
        if (comment_id is None) != (comment_digest is None):
            raise ValueError("Incomplete checkpoint")
        if comment_id is not None:
            _positive(comment_id)
            if (not isinstance(comment_digest, str) or len(comment_digest) != 64
                    or any(c not in '0123456789abcdef' for c in comment_digest)):
                raise ValueError("Invalid checkpoint digest")
        with closing(self._connect()) as db, db:
            result = db.execute("""UPDATE issues SET completed_generation=?,
                comment_id=COALESCE(?, comment_id), comment_digest=COALESCE(?, comment_digest)
                WHERE repository_id=? AND issue_number=? AND completed_generation < ?
                  AND generation >= ? AND uncertain_since IS NULL""",
                (generation, comment_id, comment_digest, *key, generation, generation))
            if result.rowcount != 1:
                raise ValueError("Invalid generation or uncertain write")
