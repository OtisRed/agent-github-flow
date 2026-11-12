"""Regression checks for the standard AGF CI trust boundary.

These checks describe the maintained workflow; a PR can alter the workflow
itself, so they do not establish independent enforcement against its author.
"""
import unittest
from pathlib import Path


class AdmissionSourceTests(unittest.TestCase):
    def test_default_branch_gate_precedes_candidate_checkout(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        trusted = workflow.index("      - name: Check out trusted admission from default branch")
        wait = workflow.index("      - name: Wait for flow admission")
        candidate = workflow.index("      - name: Check out event revision")
        test = workflow.index("      - name: Verify Node tests")
        self.assertLess(trusted, wait)
        self.assertLess(wait, candidate)
        self.assertLess(candidate, test)
        checkout = workflow[trusted:wait]
        gate = workflow[wait:candidate]
        condition = "github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'smoke' && vars.FLOW_ADMISSION_ENABLED == 'true'"
        self.assertIn(condition, checkout)
        self.assertIn(condition, gate)
        self.assertIn("ref: ${{ github.event.repository.default_branch }}", checkout)
        self.assertIn("path: .trusted-admission", checkout)
        self.assertIn("persist-credentials: false", checkout)
        self.assertIn("PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}", gate)
        self.assertIn("python3 .trusted-admission/scripts/wait_admission.py", gate)
        self.assertNotIn("python3 scripts/wait_admission.py", gate)


if __name__ == "__main__":
    unittest.main()
