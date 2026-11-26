"""Plan a selective promotion from a supplied observation, without I/O."""
import argparse
import json
import re
import sys
import subprocess
from copy import deepcopy
from pathlib import Path

from mvp_decision import _date, _id
from promotion_plan import SHA, closed_prefix, issue_reference


DEPENDENCIES = re.compile(r"Depends-on:[ \t]*(#[0-9]{1,19}(?:[ \t]*,[ \t]*#[0-9]{1,19})*)", re.IGNORECASE)


def _dependencies(body):
    lines = [line.strip() for line in body.splitlines()
             if re.match(r"^\s*Depends-on\b", line, re.IGNORECASE)]
    if not lines:
        return set()
    match = DEPENDENCIES.fullmatch(lines[0]) if len(lines) == 1 else None
    if not match:
        raise ValueError("invalid-dependencies")
    numbers = [int(number) for number in re.findall(r"#([0-9]+)", match[1])]
    if len(numbers) != len(set(numbers)) or not all(map(_id, numbers)):
        raise ValueError("invalid-dependencies")
    return set(numbers)


def _index(entries):
    groups, prs, shas = {}, set(), set()
    for entry in entries:
        number, pr, sha = entry["issue"], entry["pr"], entry["sha"]
        if (not _id(number) or not _id(pr) or pr in prs or not SHA.fullmatch(sha)
                or sha in shas or issue_reference(entry["body"]) != number):
            raise ValueError("ambiguous-pr")
        prs.add(pr)
        shas.add(sha)
        groups.setdefault(number, []).append(entry)
    return groups


def _qualification(issue, group, main):
    """Return the current cycle's disposition and declared dependencies."""
    if issue["state"] == "open":
        return "open-issue", set()
    if issue["state"] != "closed" or not _id(issue["cycle"]):
        return "unknown-issue-cycle", set()
    if issue["status"] != "done":
        return "issue-not-done", set()
    closed_at = _date(issue["closed_at"])
    expected = issue["prs"]
    if (not isinstance(expected, list) or not all(map(_id, expected))
            or sorted(expected) != sorted(entry["pr"] for entry in group)):
        return "incomplete-pr-set", set()
    if any(not _id(entry.get("cycle")) or entry["cycle"] != issue["cycle"] for entry in group):
        return "pr-cycle-mismatch", set()
    if any(_date(entry["merged_at"]) >= closed_at for entry in group):
        return "closure-before-last-merge", set()

    receipt = issue["published"]
    if receipt is not None:
        if (not isinstance(receipt, dict) or receipt.get("cycle") != issue["cycle"]
                or receipt.get("main") != main
                or receipt.get("commits") != {str(entry["pr"]): entry["sha"] for entry in group}
                or not group):
            return "unverified-promotion", set()
        return "already-promoted", set()
    if not group:
        return "no-pr", set()
    dependencies = set().union(*(_dependencies(entry["body"]) for entry in group))
    return "eligible", dependencies


def plan_selective(snapshot):
    """Compare the old prefix and the proposed selection on one complete observation."""
    try:
        before, after = snapshot["before"], snapshot["after"]
        main, smoke = before["main"], before["smoke"]
        if before != after:
            return {"kind": "blocked", "reason": "branches-changed"}
        entries, issues = snapshot["entries"], snapshot["issues"]
        if (snapshot["complete"] is not True or not _id(snapshot["repository_id"])
                or not SHA.fullmatch(main) or not SHA.fullmatch(smoke)
                or not isinstance(entries, list) or not isinstance(issues, dict)
                or any(not isinstance(key, str) or not re.fullmatch(r"[1-9][0-9]{0,18}", key)
                       or not _id(int(key)) for key in issues)):
            return {"kind": "blocked", "reason": "incomplete-observation"}
        groups = _index(entries)
    except (KeyError, TypeError, AttributeError, ValueError):
        return {"kind": "blocked", "reason": "incomplete-or-ambiguous-inventory"}

    prefix = closed_prefix(entries, {number: issues.get(str(number)) for number in groups})
    dispositions, pending, accepted = {}, {}, set()
    # Dict insertion order retains the first occurrence of each issue on smoke.
    all_numbers = dict.fromkeys(groups)
    all_numbers.update(dict.fromkeys(map(int, issues)))
    for number in all_numbers:
        try:
            issue = issues[str(number)]
            result, dependencies = _qualification(issue, groups.get(number, []), main)
        except (KeyError, TypeError, AttributeError, ValueError, OverflowError) as error:
            result = "invalid-dependencies" if str(error) == "invalid-dependencies" else "unknown-issue-cycle"
        if result == "eligible":
            pending[number] = dependencies
        else:
            dispositions[number] = {"issue": number, "reason": result}
            if result == "already-promoted":
                accepted.add(number)

    selected = []
    while pending:
        ready = next((number for number, deps in pending.items() if deps <= accepted), None)
        if ready is None:
            break
        del pending[ready]
        accepted.add(ready)
        selected.append({"issue": ready, "cycle": issues[str(ready)]["cycle"],
                         "prs": [{"pr": entry["pr"], "sha": entry["sha"]}
                                 for entry in groups[ready]]})

    for number, deps in pending.items():
        dispositions[number] = {"issue": number, "reason": "unsatisfied-dependencies",
                                "dependencies": sorted(deps - accepted)}
    return {"kind": "report", "repository_id": snapshot["repository_id"], "main": main,
            "smoke": smoke, "closed_prefix": prefix, "selected": selected,
            "excluded": list(dispositions.values())}


def derive_receipts(snapshot, confirmed, reachable):
    """Bind journal receipts to the observed head and the original closed issue cycle."""
    observation = deepcopy(snapshot)
    main = observation["before"]["main"]
    receipts = {}
    try:
        for sources, result in confirmed:
            if not reachable(result, main):
                raise ValueError("confirmed-result-not-on-main")
            for source in sources:
                key = str(source["issue"]), source["cycle"]
                receipt = receipts.setdefault(key, {"cycle": key[1], "main": main, "commits": {}})
                pr = str(source["pr"])
                if pr in receipt["commits"]:
                    raise ValueError("duplicate-confirmed-source")
                receipt["commits"][pr] = source["sha"]
        for number, issue in observation["issues"].items():
            issue["published"] = receipts.get((number, issue["cycle"]))
        return observation
    except (OSError, KeyError, TypeError, ValueError, subprocess.SubprocessError):
        raise ValueError("Cannot verify confirmed promotion history") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("observation", type=Path, help="JSON observation or synthetic fixture")
    parser.add_argument("--journal", type=Path, help="Private SQLite promotion journal")
    parser.add_argument("--refs-repository", type=Path, help="Disposable repository with freshly fetched origin refs")
    args = parser.parse_args()
    if bool(args.journal) != bool(args.refs_repository):
        parser.error("--journal and --refs-repository must be used together")
    with args.observation.open(encoding="utf-8") as source:
        observation = json.load(source)
    if args.journal:
        from selective_promotion_candidate import _git, _read_refs
        from selective_promotion_merge import SelectiveMergeJournal

        def reachable(commit, main):
            return _git(args.refs_repository, "merge-base", commit, main) == commit

        refs = tuple(observation["before"][name] for name in ("main", "smoke"))
        if not args.journal.is_file() or _read_refs(args.refs_repository) != refs:
            parser.error("Journal missing or fetched branch heads do not match the observation")
        try:
            confirmed = SelectiveMergeJournal(args.journal).confirmed_sources(observation["repository_id"])
            observation = derive_receipts(observation, confirmed, reachable)
        except ValueError as error:
            parser.error(str(error))
        if _read_refs(args.refs_repository) != refs:
            parser.error("Fetched branch heads changed while planning")
    result = plan_selective(observation)
    print(json.dumps(result, indent=2))
    return int(result["kind"] == "blocked")


if __name__ == "__main__":
    sys.exit(main())
