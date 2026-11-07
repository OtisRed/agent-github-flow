"""Validate explicitly configured GitHub branch protection and CI checks."""


def protected_checks(protection, admission, tests):
    """Require all named check producers, including the admission App.

    Bare context names are insufficient: GitHub must bind each to the expected
    App. This is deliberately conservative; ruleset-only setups are unverified.
    """
    if (not isinstance(protection, dict) or not isinstance(admission, tuple) or len(admission) != 2
            or not isinstance(tests, tuple) or not tests or admission in tests
            or len(set((admission,) + tests)) != len(tests) + 1):
        return False
    configured = (admission,) + tests
    if any(not isinstance(name, str) or not name or type(app) is not int or app <= 0 for name, app in configured):
        return False
    admins = protection.get("enforce_admins")
    if not isinstance(admins, dict) or admins.get("enabled") is not True:
        return False
    rules = protection.get("required_status_checks")
    if not isinstance(rules, dict) or not isinstance(rules.get("checks"), list):
        return False
    actual = [(x.get("context"), x.get("app_id")) for x in rules["checks"] if isinstance(x, dict)]
    return all(actual.count(check) == 1 for check in configured)


def rulesets_do_not_bypass_smoke(rulesets):
    """Reject applicable rulesets with bypass actors or an unknown scope."""
    if not isinstance(rulesets, list):
        return False
    for ruleset in rulesets:
        if not isinstance(ruleset, dict) or ruleset.get("enforcement") not in ("active", "disabled", "evaluate"):
            return False
        if ruleset.get("target") not in ("branch", "tag", "push"):
            return False
        if ruleset["enforcement"] != "active" or ruleset["target"] != "branch":
            continue
        refs = (ruleset.get("conditions") or {}).get("ref_name")
        if not isinstance(refs, dict) or not isinstance(refs.get("include"), list) or not isinstance(refs.get("exclude"), list):
            return False
        include, exclude = refs["include"], refs["exclude"]
        if not include or any(not isinstance(x, str) for x in include + exclude):
            return False
        if "refs/heads/smoke" in exclude:
            continue
        # Exact unrelated branch names can be ignored. Special patterns and
        # wildcards are conservatively treated as potentially matching smoke.
        applies = any(x == "refs/heads/smoke" or not x.startswith("refs/heads/")
                      or any(c in x for c in "*?[]{}") for x in include)
        if applies and (not isinstance(ruleset.get("bypass_actors"), list) or ruleset["bypass_actors"]):
            return False
    return True


def tests_state(runs, head, required):
    """Require latest check run for every explicit name/App pair on the head."""
    if not isinstance(runs, list) or not isinstance(head, str) or not isinstance(required, tuple) or not required:
        return "unknown"
    latest = {}
    for run in runs:
        if not isinstance(run, dict) or type(run.get("id")) is not int or run["id"] <= 0:
            return "unknown"
        app = run.get("app")
        if not isinstance(app, dict):
            return "unknown"
        pair = (run.get("name"), app.get("id"))
        if pair not in required:
            continue
        if run.get("head_sha") != head:
            return "unknown"
        if pair not in latest or run["id"] > latest[pair]["id"]:
            latest[pair] = run
    for pair in required:
        run = latest.get(pair)
        if run is None or run.get("status") != "completed":
            return "pending"
        if run.get("conclusion") != "success":
            return "failure"
    return "success"
