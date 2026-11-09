"""Record issue-creation intent in the existing private controller database."""

from contextlib import closing
from mvp_store import _positive


class DependabotJournal:
    def __init__(self, store):
        self.store = store

    def initialize(self):
        # Additive and rollback-compatible: existing v2 state and backups stay
        # usable, and an older controller simply ignores this private table.
        with closing(self.store._connect()) as db, db:
            db.execute("""CREATE TABLE IF NOT EXISTS dependabot_intake (
                repository_id INTEGER NOT NULL,
                pr_number INTEGER NOT NULL,
                issue_number INTEGER,
                PRIMARY KEY (repository_id, pr_number)
            )""")

    def begin(self, repository_id, pr_number):
        key = (_positive(repository_id), _positive(pr_number))
        with closing(self.store._connect()) as db, db:
            result = db.execute("INSERT OR IGNORE INTO dependabot_intake VALUES (?, ?, NULL)", key)
            return result.rowcount == 1

    def read(self, repository_id, pr_number):
        key = (_positive(repository_id), _positive(pr_number))
        with closing(self.store._connect()) as db:
            row = db.execute("SELECT issue_number FROM dependabot_intake WHERE repository_id=? AND pr_number=?", key).fetchone()
            return None if row is None else {"issue_number": row[0]}

    def bind(self, repository_id, pr_number, issue_number):
        key = (_positive(repository_id), _positive(pr_number))
        _positive(issue_number)
        with closing(self.store._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT OR IGNORE INTO dependabot_intake VALUES (?, ?, NULL)", key)
            result = db.execute("""UPDATE dependabot_intake SET issue_number=?
                WHERE repository_id=? AND pr_number=? AND (issue_number IS NULL OR issue_number=?)""",
                (issue_number, *key, issue_number))
            if result.rowcount != 1:
                raise ValueError("Dependabot issue identity changed")
