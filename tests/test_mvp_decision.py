import unittest
import json
import shutil
import subprocess
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_decision import decide, parse_flow
from mvp_store import comment_digest

BOUNDARY = "2026-11-01T00:00:00Z"
FLOW = "[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Projekt\nNastępny krok: Kod"


def comment(number, body=FLOW, when="2026-11-02T00:00:00Z", author=10):
    return {"id": number, "body": body, "created_at": when, "updated_at": when, "author_id": author}


def snapshot(**changes):
    data = {"complete": True, "state": "OPEN", "status": "needs-design",
            "created_at": "2026-10-01T00:00:00Z", "comments": [], "latest_reopen": None}
    data.update(changes)
    return data


def run(data, checkpoint=None):
    return decide(data, checkpoint or {}, enrolled_at=BOUNDARY, trusted_authors=frozenset({10}))


class DecisionTests(unittest.TestCase):
    def test_standard_format_and_untrusted_author(self):
        self.assertEqual(parse_flow(FLOW), "agent-ready")
        self.assertIsNone(parse_flow(FLOW + "\nextra"))
        self.assertEqual(run(snapshot(comments=[comment(5, author=11)])), {"kind": "no-change"})
        result = run(snapshot(comments=[comment(5)]))
        self.assertEqual((result["status"], result["comment_id"]), ("agent-ready", 5))

    @unittest.skipUnless(shutil.which("node"), "Node is needed only to compare the existing parser")
    def test_python_parser_matches_existing_javascript_parser(self):
        samples = [FLOW, FLOW + "\n", FLOW + "\n\n", FLOW.replace("\n", "\r\n"),
                   FLOW.replace("Designer", "\ufeff \ufeffDesigner\ufeff"),
                   FLOW.replace("Designer", "\x85"), FLOW.replace("agent-ready", "done"),
                   FLOW.replace("Rola:", "rola:"), FLOW.replace("Projekt", ""), "[FLOW]"]
        script = ("import {parseFlowComment} from './src/flow.mjs'; "
                  "let s=''; for await (const c of process.stdin) s+=c; "
                  "console.log(JSON.stringify(JSON.parse(s).map(x=>{const r=parseFlowComment(x);return r.ok?r.targetStatus:null})));" )
        result = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(samples),
                                text=True, capture_output=True, check=True, cwd=Path(__file__).resolve().parents[1])
        self.assertEqual([parse_flow(value) for value in samples], json.loads(result.stdout))

    def test_new_issue_closed_issue_and_old_issue(self):
        self.assertEqual(run(snapshot(created_at="2026-11-02T00:00:00Z"))["status"], "needs-design")
        self.assertEqual(run(snapshot(state="CLOSED"))["status"], "done")
        self.assertEqual(run(snapshot()), {"kind": "no-change"})

    def test_missing_or_changed_checkpoint_blocks_even_if_older_handoff_exists(self):
        checkpoint = {"comment_id": 2, "comment_digest": comment_digest(FLOW, "2026-11-02T00:00:00Z")}
        self.assertEqual(run(snapshot(comments=[comment(1)]), checkpoint)["reason"], "checkpoint-missing")
        self.assertEqual(run(snapshot(comments=[comment(1), comment(2, body=FLOW + "X")]), checkpoint)["reason"], "checkpoint-changed")

    def test_edited_and_restored_text_with_new_update_time_is_detected(self):
        checkpoint = {"comment_id": 2, "comment_digest": comment_digest(FLOW, "2026-11-02T00:00:00Z")}
        restored = comment(2)
        restored["updated_at"] = "2026-11-02T01:00:00Z"
        self.assertEqual(run(snapshot(comments=[restored]), checkpoint)["reason"], "checkpoint-changed")

    def test_reopen_resets_then_post_reopen_handoff_can_be_taken(self):
        reopen = {"id": 55, "created_at": "2026-11-02T10:00:00Z"}
        old = comment(1, when="2026-11-02T09:00:00Z")
        new = comment(2, when="2026-11-02T11:00:00Z")
        data = snapshot(latest_reopen=reopen, comments=[new, old])
        first = run(data)
        self.assertEqual(first, {"kind": "target", "status": "needs-design", "reopen_id": 55, "recheck": True})
        self.assertEqual(run(data, {"reopen_id": 55})["comment_id"], 2)
        self.assertEqual(run(snapshot(latest_reopen=reopen, comments=[old]), {"reopen_id": 55}), {"kind": "no-change"})

    def test_old_reopen_and_comments_before_onboarding_do_not_reset(self):
        reopen = {"id": 55, "created_at": "2026-10-02T00:00:00Z"}
        result = run(snapshot(latest_reopen=reopen, comments=[comment(1, when="2026-10-03T00:00:00Z")]))
        self.assertEqual(result, {"kind": "no-change"})

    def test_incomplete_data_malformed_comment_and_open_done_block(self):
        self.assertEqual(run(snapshot(complete=False))["kind"], "blocked")
        self.assertEqual(run(snapshot(comments=[comment(1, body="not a FLOW comment")]))["reason"], "invalid-flow-comment")
        self.assertEqual(run(snapshot(comments=[comment(1, body=FLOW.replace("agent-ready", "done"))]))["reason"], "open-issue-cannot-be-done")

    def test_ambiguous_boundary_and_missing_reopen_history_block(self):
        self.assertEqual(run(snapshot(comments=[comment(1, when=BOUNDARY)]))["reason"], "ambiguous-comment-boundary")
        self.assertEqual(run(snapshot(), {"reopen_id": 55})["reason"], "reopen-history-missing")


if __name__ == "__main__":
    unittest.main()
