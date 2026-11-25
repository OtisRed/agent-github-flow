"""Guard an opt-in squash request and reconcile its result without blind retries."""
import json
import sqlite3
from contextlib import closing

from mvp_decision import _id
from pr_admission_checks import tests_state
from promotion_plan import SHA


def _sha(value):
    return isinstance(value, str) and SHA.fullmatch(value) is not None


def _encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


class SelectiveMergeJournal:
    """Durable ownership of one in-flight promotion per repository."""

    def __init__(self, path):
        self.path = path
        with closing(sqlite3.connect(path)) as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS attempt (
                    repo INTEGER NOT NULL, pr INTEGER NOT NULL,
                    manifest TEXT NOT NULL, result TEXT,
                    PRIMARY KEY (repo, pr)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS attempt_pending
                    ON attempt (repo) WHERE result IS NULL;
                CREATE TABLE IF NOT EXISTS source_pr (
                    repo INTEGER NOT NULL, pr INTEGER NOT NULL,
                    PRIMARY KEY (repo, pr)
                );
            """)

    def read(self, repo, pr):
        with closing(sqlite3.connect(self.path)) as db:
            return db.execute("SELECT manifest,result FROM attempt WHERE repo=? AND pr=?",
                              (repo, pr)).fetchone()

    def reserve(self, repo, pr, manifest):
        try:
            with closing(sqlite3.connect(self.path)) as db, db:
                db.execute("INSERT INTO attempt VALUES (?, ?, ?, NULL)", (repo, pr, _encode(manifest)))
                db.executemany("INSERT INTO source_pr VALUES (?, ?)",
                               ((repo, source["pr"]) for source in manifest["sources"]))
        except sqlite3.IntegrityError:
            return False
        return True

    def cancel_before_send(self, repo, pr, manifest):
        """Only the caller that reserved this attempt may cancel before sending."""
        with closing(sqlite3.connect(self.path)) as db, db:
            deleted = db.execute("DELETE FROM attempt WHERE repo=? AND pr=? AND manifest=? AND result IS NULL",
                                 (repo, pr, _encode(manifest)))
            if deleted.rowcount == 1:
                db.executemany("DELETE FROM source_pr WHERE repo=? AND pr=?",
                               ((repo, source["pr"]) for source in manifest["sources"]))

    def confirm(self, repo, pr, commit):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE attempt SET result=? WHERE repo=? AND pr=? AND result IS NULL",
                       (commit, repo, pr))
            (observed,) = db.execute("SELECT result FROM attempt WHERE repo=? AND pr=?",
                                     (repo, pr)).fetchone()
        return observed == commit


def _validated_manifest(manifest, pr):
    if not (isinstance(manifest, dict) and _id(pr) and _id(manifest.get("repository_id"))
            and all(_sha(manifest.get(key)) for key in ("main", "smoke", "candidate", "tree"))
            and isinstance(manifest.get("sources"), list) and manifest["sources"]):
        return False
    for source in manifest["sources"]:
        if (not isinstance(source, dict)
                or not all(_id(source.get(key)) for key in ("pr", "issue", "cycle"))
                or source["pr"] == pr or not _sha(source.get("sha"))
                or source.get("method") not in ("merge", "squash")):
            return False
    return (len({s["pr"] for s in manifest["sources"]}) == len(manifest["sources"])
            and len({s["sha"] for s in manifest["sources"]}) == len(manifest["sources"]))


def _ready(observed, repo, pr, manifest, required):
    """The reader derives source and protection evidence independently of the PR body."""
    if not isinstance(observed, dict):
        return False
    if any(observed.get(key) != value for key, value in {
        "repository_id": repo, "pr": pr, "state": "open", "head": manifest["candidate"],
        "base": manifest["main"], "main": manifest["main"], "smoke": manifest["smoke"],
        "sources": manifest["sources"], "test_tree": manifest["tree"],
        "test_parents": [manifest["main"], manifest["candidate"]],
    }.items()):
        return False
    tested_commit = observed.get("test_commit")
    return (observed.get("draft") is False and observed.get("clean") is True
            and observed.get("protection_verified") is True and _sha(tested_commit)
            and observed.get("tested_revision_verified") is True
            and tests_state(observed.get("checks"), manifest["candidate"], required) == "success")


def _reconcile(read, journal, repo, pr, manifest):
    proof = read(repo, pr)
    if not isinstance(proof, dict):
        return "unknown"
    oid = proof.get("merge_commit")
    if (proof.get("merged") is not True or proof.get("repository_id") != repo
            or proof.get("pr") != pr or proof.get("head") != manifest["candidate"]
            or not _sha(oid) or proof.get("result_parents") != [manifest["main"]]
            or proof.get("result_tree") != manifest["tree"] or proof.get("reachable_from_main") is not True):
        return "unknown"
    return "merged" if journal.confirm(repo, pr, oid) else "unknown"


def selective_merge_step(journal, manifest, pr, *, enabled, read, squash, required):
    """Check a trusted snapshot, reserve before sending, and validate GitHub's outcome.

    The squash adapter must use expectedHeadOid. Errors from adapters propagate
    to the caller; a durable reservation already exists for any attempted write.
    A later call can validate a successful merge, but cannot send it again.
    """
    if not _validated_manifest(manifest, pr):
        return "invalid-manifest"
    manifest = json.loads(_encode(manifest))
    repo = manifest["repository_id"]
    existing = journal.read(repo, pr)
    if existing is not None:
        encoded, result = existing
        if encoded != _encode(manifest):
            return "manifest-mismatch"
        if result is not None:
            return "merged"
        return _reconcile(read, journal, repo, pr, manifest)

    if enabled is not True:
        return "disabled"
    if (not isinstance(required, tuple) or not required
            or any(not isinstance(pair, tuple) or len(pair) != 2
                   or not isinstance(pair[0], str) or not pair[0] or not _id(pair[1])
                   for pair in required) or len(set(required)) != len(required)):
        return "invalid-checks"
    if not _ready(read(repo, pr), repo, pr, manifest, required):
        return "waiting-or-stale"
    if not journal.reserve(repo, pr, manifest):
        return "already-reserved"
    # A final fresh read narrows the gap between the persisted intent and write.
    if not _ready(read(repo, pr), repo, pr, manifest, required):
        journal.cancel_before_send(repo, pr, manifest)
        return "waiting-or-stale"
    squash(repo, pr, manifest["candidate"])
    return _reconcile(read, journal, repo, pr, manifest)


_SQUASH = """
mutation($pr: ID!, $head: GitObjectID!) {
  mergePullRequest(input: {pullRequestId: $pr, mergeMethod: SQUASH, expectedHeadOid: $head}) {
    pullRequest { merged }
  }
}
"""


def request_github_squash(transport, token, node_id, head):
    """Send one GraphQL mutation; the caller reconciles using a fresh read."""
    if not isinstance(node_id, str) or not node_id.strip() or not _sha(head):
        raise ValueError("Invalid squash identity")
    result, _ = transport("/graphql", token, body={
        "query": _SQUASH, "variables": {"pr": node_id, "head": head},
    })
    if (not isinstance(result, dict) or result.get("errors")
            or ((result.get("data") or {}).get("mergePullRequest") or {})
            .get("pullRequest", {}).get("merged") is not True):
        raise ValueError("Unconfirmed squash response")
