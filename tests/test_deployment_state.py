import tempfile
import concurrent.futures
import threading
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from deployment_state import DeploymentState


class DeploymentStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'deployment.sqlite'
        self.store = DeploymentState(self.path)
        self.store.initialize()
        self.req = {'id': 'one', 'repository_id': 1, 'target': 'smoke', 'commit': 'a'*40, 'changes': ['A']}

    def test_restart_and_duplicate_do_not_start_another_deployment(self):
        self.assertEqual(self.store.reserve(self.req), 'reserved')
        self.store.transition(self.req, 'reserved', 'running')
        restarted = DeploymentState(self.path)
        self.assertEqual(restarted.reserve(self.req), 'running')
        with self.assertRaisesRegex(ValueError, 'unresolved'):
            restarted.reserve({**self.req, 'id': 'two', 'target': 'main'})
        restarted.transition(self.req, 'running', 'unknown')
        with self.assertRaisesRegex(ValueError, 'unresolved'):
            restarted.reserve({**self.req, 'id': 'two'})
        restarted.transition(self.req, 'unknown', 'succeeded')
        self.assertEqual(restarted.reserve({**self.req, 'id': 'two'}), 'reserved')
        self.assertEqual(restarted.reserve(self.req), 'succeeded')
        with self.assertRaisesRegex(ValueError, 'identifier reused'):
            restarted.reserve({**self.req, 'commit': 'b'*40})

    def test_failed_or_mismatched_request_remains_blocked(self):
        self.store.reserve(self.req)
        self.store.transition(self.req, 'reserved', 'running')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.store.transition({**self.req, 'commit': 'b'*40}, 'running', 'succeeded')
        self.store.transition(self.req, 'running', 'failed', 'fixture')
        with self.assertRaisesRegex(ValueError, 'unresolved'):
            self.store.reserve({**self.req, 'id': 'two'})
        self.assertEqual(self.store.get(1)['status'], 'failed')

    def test_invalid_and_missing_state_fail_closed(self):
        with self.assertRaises(ValueError):
            self.store.reserve({**self.req, 'changes': ['A', 'A']})
        with self.assertRaises(FileNotFoundError):
            DeploymentState(self.path.parent / 'missing').get(1)

    def test_smoke_and_main_cannot_reserve_at_the_same_time(self):
        requests = [self.req, {**self.req, 'id': 'two', 'target': 'main'}]
        def reserve(req):
            try:
                return DeploymentState(self.path).reserve(req)
            except ValueError:
                return 'blocked'
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(reserve, requests)), ['blocked', 'reserved'])

    def test_promotion_requires_current_successful_main_and_no_unresolved_deploy(self):
        main = {**self.req, 'target': 'main'}
        with self.store.promotion_guard(1) as ready:
            self.assertFalse(ready(main['commit']))
        self.store.reserve(main); self.store.transition(main, 'reserved', 'running'); self.store.transition(main, 'running', 'succeeded')
        smoke = {**self.req, 'id': 'smoke'}
        self.store.reserve(smoke); self.store.transition(smoke, 'reserved', 'running')
        with self.store.promotion_guard(1) as ready:
            self.assertFalse(ready(main['commit']))
        self.store.transition(smoke, 'running', 'succeeded')
        with self.store.promotion_guard(1) as ready:
            self.assertTrue(ready(main['commit']))
            self.assertFalse(ready('b'*40))

    def test_promotion_lock_prevents_new_deploy_until_released(self):
        main = {**self.req, 'target': 'main'}
        self.store.reserve(main); self.store.transition(main, 'reserved', 'running'); self.store.transition(main, 'running', 'succeeded')
        started, finished = threading.Event(), threading.Event()
        def reserve():
            started.set()
            DeploymentState(self.path).reserve({**self.req, 'id': 'next'})
            finished.set()
        with self.store.promotion_guard(1) as ready:
            self.assertTrue(ready(main['commit']))
            worker = threading.Thread(target=reserve)
            worker.start()
            self.assertTrue(started.wait(2))
            self.assertFalse(finished.wait(0.2))
        worker.join(4)
        self.assertTrue(finished.is_set())

    def test_promotion_receipt_survives_interrupted_transaction_and_cannot_be_rewritten(self):
        candidate, base = 'b'*40, 'a'*40
        plan = {'main': base, 'plan': {'kind': 'ready', 'sha': candidate, 'count': 1},
                'accepted_scope': {'changes': ['issue-1'], 'commits': [candidate]}}
        with self.assertRaisesRegex(RuntimeError, 'interrupted'):
            with self.store.promotion_guard(1) as ready:
                ready.capture(plan, 17)
                raise RuntimeError('interrupted')
        self.assertEqual(self.store.promotion_receipt(1, candidate)['scope'], plan['accepted_scope'])
        with self.store.promotion_guard(1) as ready:
            with self.assertRaisesRegex(ValueError, 'Conflicting'):
                ready.capture(plan, 18)


if __name__ == '__main__':
    unittest.main()
