import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from selective_promotion_plan import derive_receipts, plan_selective


def sample():
    refs = {"main": "a" * 40, "smoke": "b" * 40}
    entries = [
        {"issue": n, "pr": n + 10, "cycle": n + 100, "sha": f"{n:040x}", "body": f"Refs #{n}",
         "merged_at": "2026-11-24T00:00:00Z"}
        for n in (1, 2, 3)
    ]
    entries[2]["body"] += "\nDepends-on: #1"
    issues = {
        str(n): {"state": "closed", "status": "done", "cycle": n + 100,
                 "closed_at": "2026-11-25T00:00:00Z", "prs": [n + 10], "published": None}
        for n in (1, 2, 3)
    }
    issues["1"]["state"] = "open"
    return {"repository_id": 123, "before": refs, "after": dict(refs),
            "complete": True, "entries": entries, "issues": issues}


class SelectivePlanTests(unittest.TestCase):
    def setUp(self):
        self.observation = sample()

    def selected(self):
        return [item["issue"] for item in plan_selective(self.observation)["selected"]]

    def reasons(self):
        return {item["issue"]: item["reason"] for item in plan_selective(self.observation)["excluded"]}

    def test_selects_only_the_independent_done_issue(self):
        result = plan_selective(self.observation)
        self.assertEqual(result["closed_prefix"]["kind"], "waiting")
        self.assertEqual(result["selected"], [{"issue": 2, "cycle": 102,
                                               "prs": [{"pr": 12, "sha": f"{2:040x}"}]}])
        self.assertEqual(self.reasons(), {1: "open-issue", 3: "unsatisfied-dependencies"})

    def test_prs_of_one_issue_form_one_indivisible_set(self):
        issue = self.observation["issues"]["2"]
        issue["prs"].append(14)
        self.assertEqual(self.reasons()[2], "incomplete-pr-set")
        extra = dict(self.observation["entries"][1], pr=14, sha="4" * 40)
        self.observation["entries"].append(extra)
        result = plan_selective(self.observation)
        self.assertEqual([item["pr"] for item in result["selected"][0]["prs"]], [12, 14])
        extra["body"] += "\nDepends-on: #1"
        self.assertEqual(self.selected(), [])

    def test_orders_dependencies_and_keeps_unrelated_work_when_there_is_a_cycle(self):
        self.observation["issues"]["1"]["state"] = "closed"
        self.observation["entries"][0]["body"] += "\nDepends-on: #3"
        self.assertEqual(self.selected(), [2])
        self.observation["entries"][2]["body"] = "Refs #3"
        self.assertEqual(self.selected(), [2, 3, 1])

    def test_prior_promotion_satisfies_dependency_and_is_not_selected_twice(self):
        issue = self.observation["issues"]["1"]
        issue["state"] = "closed"
        issue["published"] = {"cycle": 101, "main": "a" * 40, "commits": {"11": f"{1:040x}"}}
        self.assertEqual(self.selected(), [2, 3])
        self.assertEqual(self.reasons()[1], "already-promoted")
        issue["published"]["main"] = "c" * 40
        self.assertEqual(self.selected(), [2])
        self.assertEqual(self.reasons()[1], "unverified-promotion")

    def test_reopened_issue_and_close_before_merge(self):
        issue = self.observation["issues"]["2"]
        issue["state"] = "open"
        self.assertEqual(self.selected(), [])
        issue.update(state="closed", cycle=102, closed_at="2026-11-23T00:00:00Z")
        self.assertEqual(self.reasons()[2], "closure-before-last-merge")
        issue.update(cycle=202, closed_at="2026-11-25T00:00:00Z")
        self.assertEqual(self.reasons()[2], "pr-cycle-mismatch")

    def test_missing_pr_and_unverified_issue(self):
        self.observation["issues"]["4"] = dict(self.observation["issues"]["2"], prs=[], cycle=104)
        del self.observation["issues"]["3"]
        self.assertEqual(self.reasons(), {1: "open-issue", 3: "unknown-issue-cycle", 4: "no-pr"})
        self.assertEqual(self.selected(), [2])

    def test_bad_dependency_syntax_blocks_only_affected_work(self):
        for line in ("Depends-on #1", "Depends-on: #1,#1", "Depends-on: other/repo#1",
                     "Depends-on: #1\nDepends-on: #2"):
            with self.subTest(line=line):
                self.observation["entries"][2]["body"] = "Refs #3\n" + line
                self.assertEqual(self.reasons()[3], "invalid-dependencies")
                self.assertEqual(self.selected(), [2])

    def test_incomplete_or_changed_input_withdraws_entire_report(self):
        for field, value in (("complete", False), ("after", {"main": "c" * 40, "smoke": "b" * 40})):
            with self.subTest(field=field):
                self.assertEqual(plan_selective(dict(self.observation, **{field: value}))["kind"], "blocked")
        self.observation["entries"][0]["body"] = "Refs #1\nRefs #3"
        self.assertEqual(plan_selective(self.observation)["kind"], "blocked")

    def test_planning_preserves_input_and_is_repeatable(self):
        before = copy.deepcopy(self.observation)
        self.assertEqual(plan_selective(self.observation), plan_selective(self.observation))
        self.assertEqual(self.observation, before)
