import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import agf_pilot_executor as pilot


BASELINE = 'a' * 40
CANDIDATE = 'b' * 40
REQUEST = {'id': 'main-' + CANDIDATE, 'repository_id': pilot.REPOSITORY,
           'target': 'main', 'commit': CANDIDATE, 'changes': ['issue-300']}
PERMIT = {'baseline': BASELINE, 'request': REQUEST}


class PilotExecutorTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name)
        self.pin = path / 'pin'
        self.pin.write_bytes(pilot.pin_text(BASELINE))
        self.receipt = path / 'receipt.json'
        self.enterContext(patch.multiple(pilot, STATE=path, PIN=self.pin))
        self.enterContext(patch.object(pilot, 'check_release'))
        self.enterContext(patch.object(pilot, '_trusted_path'))
        self.enterContext(patch.object(pilot, 'atomic_write', side_effect=lambda p, b: p.write_bytes(b)))
        self.attestor = self.enterContext(patch.object(pilot, 'command', return_value=b'{"confirmed":true}'))
        self.restart = self.enterContext(patch.object(pilot, 'restart'))
        self.ready = self.enterContext(patch.object(pilot, 'ready', return_value=True))

    def test_only_agf_main_and_exact_permit(self):
        for request in ({**REQUEST, 'repository_id': 5}, {**REQUEST, 'target': 'smoke'}):
            with self.assertRaises(ValueError):
                pilot.target_request(request)
        with self.assertRaises(ValueError):
            pilot.execute('deploy', {**REQUEST, 'changes': ['issue-301']}, PERMIT, port=4333)
        self.restart.assert_not_called()

    def test_attestation_failure_never_restarts(self):
        self.attestor.return_value = b'{"confirmed":false}'
        with self.assertRaises(ValueError):
            pilot.execute('deploy', REQUEST, PERMIT, port=4333)
        self.assertFalse(self.receipt.exists())
        self.restart.assert_not_called()

    def test_restart_requires_confirmed_commit_and_does_not_repeat(self):
        self.restart.side_effect = lambda: self.assertEqual(
            json.loads(self.receipt.read_bytes())['status'], 'running')
        result = pilot.execute('deploy', REQUEST, PERMIT, port=4333)
        self.assertEqual(result, pilot.result(REQUEST, 'succeeded', CANDIDATE))
        self.assertEqual(self.pin.read_bytes(), pilot.pin_text(CANDIDATE))
        self.assertEqual(pilot.execute('status', REQUEST, PERMIT, port=4333), result)
        self.assertEqual(pilot.execute('deploy', REQUEST, PERMIT, port=4333), result)
        self.restart.assert_called_once_with()

    def test_failed_readiness_restores_exact_baseline(self):
        self.ready.side_effect = lambda sha, *_: sha == BASELINE
        result = pilot.execute('deploy', REQUEST, PERMIT, port=4333)
        self.assertEqual(result, pilot.result(REQUEST, 'failed', BASELINE))
        self.assertEqual(self.pin.read_bytes(), pilot.pin_text(BASELINE))
        self.assertEqual(self.restart.call_count, 2)

    def test_unresolved_attempt_never_runs_again(self):
        self.receipt.write_text(json.dumps(pilot.result(REQUEST, 'running', None)))
        with self.assertRaises(RuntimeError):
            pilot.execute('deploy', REQUEST, PERMIT, port=4333)
        self.restart.assert_not_called()
