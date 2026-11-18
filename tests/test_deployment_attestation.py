"""Only the exact running attempt or explicit unknown-state recovery is attested."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from deployment_attestation import attest
from deployment_state import DeploymentState


class AttestationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store = DeploymentState(Path(self.temp.name) / 'state.sqlite'); self.store.initialize()
        self.config = {'projects': [{'repository_id': 42, 'owner': 'owner', 'repository': 'repo',
                                    'deployment_enabled': True, 'deployment_checks': [{'context': 'verify', 'app_id': 1}]}]}
        self.req = {'id': 'main-1', 'repository_id': 42, 'target': 'main', 'commit': 'a' * 40, 'changes': ['issue-1']}
        self.store.reserve(self.req)
        self.store.transition(self.req, 'reserved', 'running')

    def test_only_running_exact_request_and_scope_are_confirmed(self):
        with patch('deployment_attestation.verify_head_and_ci', return_value=True), \
             patch('deployment_attestation.promoted_scope', return_value={'changes': ['issue-1'], 'commits': ['b' * 40]}):
            self.assertTrue(attest(self.config, self.req, 'token', self.store))
            self.assertFalse(attest(self.config, {**self.req, 'changes': ['issue-2']}, 'token', self.store))
            self.store.transition(self.req, 'running', 'succeeded')
            self.assertFalse(attest(self.config, self.req, 'token', self.store))

    def test_stale_ci_or_mismatched_promotion_is_not_confirmed(self):
        with patch('deployment_attestation.verify_head_and_ci', return_value=False):
            self.assertFalse(attest(self.config, self.req, 'token', self.store))
        with patch('deployment_attestation.verify_head_and_ci', return_value=True), \
             patch('deployment_attestation.promoted_scope', return_value={'changes': ['issue-2'], 'commits': ['b' * 40]}):
            self.assertFalse(attest(self.config, self.req, 'token', self.store))

    def test_smoke_requires_empty_scope_and_enabled_project(self):
        self.store.transition(self.req, 'running', 'succeeded')
        smoke = {'id': 'smoke-1', 'repository_id': 42, 'target': 'smoke', 'commit': 'b' * 40, 'changes': []}
        self.store.reserve(smoke); self.store.transition(smoke, 'reserved', 'running')
        with patch('deployment_attestation.verify_head_and_ci', return_value=True):
            self.assertTrue(attest(self.config, smoke, 'token', self.store))
            self.config['projects'][0]['deployment_enabled'] = False
            self.assertFalse(attest(self.config, smoke, 'token', self.store))

    def test_unknown_attempt_requires_explicit_recovery_and_exact_ci(self):
        self.store.transition(self.req, 'running', 'unknown')
        with patch('deployment_attestation.verify_head_and_ci', return_value=True), \
             patch('deployment_attestation.promoted_scope', return_value={'changes': ['issue-1'], 'commits': ['b' * 40]}):
            self.assertFalse(attest(self.config, self.req, 'token', self.store))
            self.assertTrue(attest(self.config, self.req, 'token', self.store, recovery=True))
            self.assertFalse(attest(self.config, {**self.req, 'changes': ['issue-2']}, 'token', self.store, recovery=True))
        with patch('deployment_attestation.verify_head_and_ci', return_value=False):
            self.assertFalse(attest(self.config, self.req, 'token', self.store, recovery=True))


if __name__ == '__main__':
    unittest.main()
