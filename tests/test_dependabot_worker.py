import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pr_admission_service import run_admission


class WorkerTests(unittest.TestCase):
    def test_one_bot_pr_per_pass_and_intake_failure_does_not_stop_admission(self):
        stop = threading.Event()
        wake = SimpleNamespace(wait=lambda _: stop.set(), clear=lambda: None)
        gateway = SimpleNamespace(candidates=lambda: [1, 2], client=SimpleNamespace(owner="o", repository="r"))
        calls = []
        reader = SimpleNamespace(repository_id=20, dependabot=(gateway, object()),
                                 reconcile_merges=lambda: calls.append("admission") or [],
                                 open_pr_numbers=lambda: [])
        with patch("pr_admission_service.intake_step", side_effect=RuntimeError("failure")) as intake:
            run_admission(stop, wake, [(reader, frozenset())])
        self.assertEqual(intake.call_count, 1)
        self.assertEqual(calls, ["admission"])
