"""Assemble and test an offline promotion candidate on an exact main commit."""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from mvp_decision import _id
from promotion_plan import SHA


class CandidateError(ValueError):
    """The observation cannot produce a trustworthy candidate."""


def _git(repo, *args, input_text=None, author=False):
    env = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    if author:
        env.update(GIT_AUTHOR_NAME="AGF candidate", GIT_AUTHOR_EMAIL="agf@example.invalid",
                   GIT_COMMITTER_NAME="AGF candidate", GIT_COMMITTER_EMAIL="agf@example.invalid",
                   GIT_AUTHOR_DATE="2000-01-01T00:00:00+00:00", GIT_COMMITTER_DATE="2000-01-01T00:00:00+00:00")
    return subprocess.check_output(["git", "-c", f"core.hooksPath={os.devnull}", "-C", str(repo), *args],
                                   input=input_text, encoding="utf-8", env=env,
                                   stderr=subprocess.PIPE).strip()


def _read_refs(repo):
    return tuple(_git(repo, "rev-parse", "--verify", f"refs/remotes/origin/{ref}^{{commit}}")
                 for ref in ("main", "smoke"))


def _deltas(source, plan, methods):
    main, smoke = plan["main"], plan["smoke"]
    _git(source, "merge-base", main, smoke)
    integrated = set(_git(source, "rev-list", "--first-parent", smoke, "--not", main).splitlines())
    seen_issues, seen_prs, seen_commits = set(), set(), set()
    deltas = []
    for group in plan["selected"]:
        issue, cycle = group["issue"], group["cycle"]
        if not _id(issue) or issue in seen_issues or not _id(cycle) or not isinstance(group["prs"], list) or not group["prs"]:
            raise CandidateError("invalid-issue-set")
        seen_issues.add(issue)
        for entry in group["prs"]:
            pr, sha = entry["pr"], entry["sha"]
            if not _id(pr) or pr in seen_prs or sha not in integrated or sha in seen_commits:
                raise CandidateError("source-not-unique-on-smoke")
            seen_prs.add(pr)
            seen_commits.add(sha)
            parents = _git(source, "show", "-s", "--format=%P", sha).split()
            method = methods.get(str(pr))
            if (method, len(parents)) not in {("merge", 2), ("squash", 1)}:
                raise CandidateError("unsupported-or-unverified-merge-method")
            deltas.append((issue, cycle, pr, sha, method))
    if not deltas:
        raise CandidateError("empty-selection")
    return deltas


def build_candidate(source, plan, methods, verify):
    """Return a manifest only when the exact candidate passes the supplied check."""
    source = Path(source).resolve(strict=True)
    try:
        if plan["kind"] != "report" or not _id(plan["repository_id"]):
            raise CandidateError("invalid-plan")
        main, smoke = plan["main"], plan["smoke"]
        if not SHA.fullmatch(main) or not SHA.fullmatch(smoke):
            raise CandidateError("invalid-plan-refs")
        if _read_refs(source) != (main, smoke):
            raise CandidateError("refs-changed-before-build")
        deltas = _deltas(source, plan, methods)
    except (KeyError, TypeError, AttributeError) as error:
        raise CandidateError("invalid-plan") from error
    except subprocess.CalledProcessError as error:
        raise CandidateError("unreadable-source") from error

    manifest = {"repository_id": plan["repository_id"], "main": main, "smoke": smoke,
                "sources": [dict(issue=issue, cycle=cycle, pr=pr, sha=sha, method=method)
                            for issue, cycle, pr, sha, method in deltas]}
    with tempfile.TemporaryDirectory(prefix="agf-candidate-") as directory:
        checkout = Path(directory) / "checkout"
        try:
            _git(directory, "clone", "--shared", "--no-checkout", "--", str(source), str(checkout))
            _git(checkout, "checkout", "--detach", main)
            for _, _, pr, sha, method in deltas:
                options = ("-m", "1") if method == "merge" else ()
                try:
                    _git(checkout, "cherry-pick", "--no-commit", *options, sha, author=True)
                except subprocess.CalledProcessError as error:
                    raise CandidateError(f"delta-failed:{pr}") from error
            tree = _git(checkout, "write-tree")
            if tree == _git(checkout, "rev-parse", f"{main}^{{tree}}"):
                raise CandidateError("empty-candidate")
            manifest["tree"] = tree
            candidate = _git(checkout, "commit-tree", tree, "-p", main, "--no-gpg-sign",
                             input_text=json.dumps(manifest, sort_keys=True) + "\n", author=True)
            _git(checkout, "checkout", "--detach", candidate)
            verify(checkout, candidate)
            if _read_refs(source) != (main, smoke):
                raise CandidateError("refs-changed-during-checks")
            if (_git(checkout, "rev-parse", "HEAD") != candidate
                    or _git(checkout, "status", "--porcelain", "--untracked-files=no")):
                raise CandidateError("candidate-changed-during-checks")
        except subprocess.CalledProcessError as error:
            raise CandidateError("git-or-check-failed") from error
    return {**manifest, "candidate": candidate}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("input", type=Path, help="JSON with plan and verified methods keyed by PR number")
    parser.add_argument("--check", nargs=argparse.REMAINDER, required=True,
                        help="Trusted local test command run inside the temporary candidate checkout")
    args = parser.parse_args()
    if not args.check:
        parser.error("--check requires a command")

    def verify(checkout, _candidate):
        subprocess.run(args.check, cwd=checkout, check=True, stdout=sys.stderr)

    try:
        with args.input.open(encoding="utf-8") as source:
            observation = json.load(source)
        result = build_candidate(args.repo, observation["plan"], observation["methods"], verify)
    except (CandidateError, ValueError, KeyError, OSError) as error:
        parser.exit(1, f"Candidate blocked: {error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
