"""Compose the selective promotion steps without automatic scheduler enrollment."""
import subprocess
from copy import deepcopy

from promotion_plan import SHA
from selective_promotion_candidate import _git, _read_refs
from selective_promotion_ci import verify_candidate_ci
from selective_promotion_merge import selective_merge_step


def verify_and_squash(journal, manifest, pr, *, enabled, observe, squash,
                      repository, read_ci, policy, run_id, job_id):
    """Recheck CI and repo evidence on both reads before the guarded write.

    Observe supplies current sources, PR state, branch protections and merge
    readback independently of CI. The verifier supplies all CI evidence.
    """
    def read(repo, number):
        snapshot = observe(repo, number)
        if not isinstance(snapshot, dict) or snapshot.get("state") != "open":
            return snapshot
        if snapshot.get("draft") is not False:
            return None

        snapshot = deepcopy(snapshot)
        expected = {**manifest, "pr": number}
        proof = verify_candidate_ci(read_ci, repository, expected, policy, run_id, job_id)
        if proof["kind"] != "verified" or observe(repo, number) != snapshot:
            return None
        ci_fields = ("test_commit", "test_tree", "test_parents", "tested_revision_verified", "checks")
        return {**snapshot, **{key: proof[key] for key in ci_fields}}

    return selective_merge_step(journal, manifest, pr, enabled=enabled, read=read, squash=squash,
                                required=(("verify", policy.get("app_id")),))


def prepare_forward_sync(repo, journal, repository_id, promotion_pr, smoke):
    """Prepare a merge commit in a disposable Git repo without updating refs.

    Only join the confirmed squash history to smoke when Git produces the
    identical smoke tree. Other results require a separate reviewed sync.
    """
    attempt = journal.read(repository_id, promotion_pr)
    if not attempt or attempt[1] is None:
        return {"kind": "unconfirmed-promotion"}
    main = attempt[1]
    if not isinstance(smoke, str) or not SHA.fullmatch(smoke):
        return {"kind": "invalid-smoke"}
    try:
        if _read_refs(repo) != (main, smoke):
            return {"kind": "refs-changed"}
        try:
            _git(repo, "merge-base", "--is-ancestor", main, smoke)
        except subprocess.CalledProcessError as error:
            if error.returncode != 1:
                raise
        else:
            return {"kind": "already-synced", "main": main, "smoke": smoke}
        try:
            tree = _git(repo, "merge-tree", "--write-tree", smoke, main)
        except subprocess.CalledProcessError as error:
            if error.returncode == 1:
                return {"kind": "sync-conflict"}
            raise
        if tree != _git(repo, "rev-parse", f"{smoke}^{{tree}}"):
            return {"kind": "sync-changes-content"}
        candidate = _git(repo, "commit-tree", tree, "-p", smoke, "-p", main, "--no-gpg-sign",
                         input_text=f"Sync main {main} into smoke\n", author=True)
        if _read_refs(repo) != (main, smoke):
            return {"kind": "refs-changed"}
        return {"kind": "sync-ready", "main": main, "smoke": smoke, "head": candidate, "tree": tree}
    except subprocess.CalledProcessError:
        return {"kind": "unreadable-refs-or-git-failure"}
