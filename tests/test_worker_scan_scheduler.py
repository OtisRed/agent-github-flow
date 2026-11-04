import sys
import unittest
import hashlib
import hmac
import json
import os
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from worker_scan_scheduler import ScanScheduler
import webhook_ingress as ingress
import worker_ledger


def delivery(n):
    return f'00000000-0000-4000-8000-{n:012x}'


class FakeLedger:
    def __init__(self, ids):
        self.source = set(ids)
        self.imported = set()
        self.calls = []
        self.fail = False

    def import_page(self, path, key, *, after, limit):
        self.calls.append(after)
        if self.fail:
            return {'kind': 'blocked'}
        remaining = sorted(x for x in self.source if after is None or x > after)
        page = remaining[:limit]
        self.imported.update(page)
        return {'kind': 'page-imported', 'nextAfter': page[-1] if page else None,
                'more': len(remaining) > limit}


class ScanSchedulerTests(unittest.TestCase):
    def test_bounded_steps_finish_pass_then_find_earlier_new_arrival(self):
        ledger = FakeLedger([delivery(2), delivery(3), delivery(4)])
        scheduler = ScanScheduler(ledger, 'queue', b'key', page_size=1)
        self.assertEqual(scheduler.step(), {'kind': 'page-imported', 'passComplete': False})
        ledger.source.add(delivery(1))
        self.assertFalse(scheduler.step()['passComplete'])
        self.assertTrue(scheduler.step()['passComplete'])
        self.assertNotIn(delivery(1), ledger.imported)
        self.assertFalse(scheduler.step()['passComplete'])
        self.assertIn(delivery(1), ledger.imported)
        self.assertEqual(ledger.calls, [None, delivery(2), delivery(3), None])

    def test_blocked_step_preserves_marker_and_restart_starts_at_beginning(self):
        ledger = FakeLedger([delivery(1), delivery(2), delivery(3)])
        scheduler = ScanScheduler(ledger, 'queue', b'key', page_size=1)
        scheduler.step()
        ledger.fail = True
        self.assertEqual(scheduler.step(), {'kind': 'blocked'})
        ledger.fail = False
        self.assertEqual(scheduler.step(), {'kind': 'page-imported', 'passComplete': False})
        self.assertEqual(ledger.calls, [None, delivery(1), delivery(1)])
        restarted = ScanScheduler(ledger, 'queue', b'key', page_size=1)
        restarted.step()
        self.assertIsNone(ledger.calls[-1])

    def test_invalid_or_nonadvancing_page_never_advances_marker(self):
        class InvalidLedger:
            def __init__(self): self.calls = []
            def import_page(self, path, key, *, after, limit):
                self.calls.append(after)
                return {'kind': 'page-imported', 'nextAfter': None, 'more': True}
        ledger = InvalidLedger()
        scheduler = ScanScheduler(ledger, 'queue', b'key')
        self.assertEqual(scheduler.step(), {'kind': 'blocked'})
        self.assertEqual(scheduler.step(), {'kind': 'blocked'})
        self.assertEqual(ledger.calls, [None, None])

    def test_storage_exception_keeps_marker_even_after_import(self):
        class FailingLedger(FakeLedger):
            def __init__(self, ids):
                super().__init__(ids)
                self.mode = 'before'
            def import_page(self, path, key, *, after, limit):
                if self.mode == 'before':
                    self.calls.append(after)
                    raise OSError('synthetic failure')
                result = super().import_page(path, key, after=after, limit=limit)
                if self.mode == 'after': raise RuntimeError('synthetic failure after commit')
                return result
        ledger = FailingLedger([delivery(1), delivery(2)])
        scheduler = ScanScheduler(ledger, 'queue', b'key', page_size=1)
        self.assertEqual(scheduler.step(), {'kind': 'blocked'})
        ledger.mode = 'after'
        self.assertEqual(scheduler.step(), {'kind': 'blocked'})
        ledger.mode = None
        self.assertFalse(scheduler.step()['passComplete'])
        self.assertEqual(ledger.calls, [None, None, None])
        self.assertEqual(ledger.imported, {delivery(1)})

    def test_reentrant_step_is_blocked_without_resetting_marker(self):
        class ReentrantLedger(FakeLedger):
            def import_page(self, path, key, *, after, limit):
                self.nested = self.scheduler.step()
                return super().import_page(path, key, after=after, limit=limit)
        ledger = ReentrantLedger([delivery(1), delivery(2)])
        scheduler = ScanScheduler(ledger, 'queue', b'key', page_size=1)
        ledger.scheduler = scheduler
        self.assertFalse(scheduler.step()['passComplete'])
        self.assertEqual(ledger.nested, {'kind': 'blocked'})
        self.assertTrue(scheduler.step()['passComplete'])
        self.assertEqual(ledger.calls, [None, delivery(1)])

    @unittest.skipUnless(os.name == 'posix', 'Worker lock requires POSIX')
    def test_real_ingress_and_ledger_find_arrival_before_marker(self):
        with tempfile.TemporaryDirectory(prefix='agf-scan-test-') as directory:
            queue = Path(directory) / 'ingress.sqlite'
            ledger_path = Path(directory) / 'worker.sqlite'
            lock_path = Path(directory) / 'worker.lock'
            key = b'synthetic-fingerprint-key-for-the-tests-only'
            secret = b'synthetic-webhook-secret-for-the-tests-only'
            registry = ingress.validate_registry([(11, 22)])
            body = json.dumps({'action': 'created', 'installation': {'id': 11}, 'repository': {'id': 22},
                               'issue': {'number': 8}, 'comment': {'id': 77}}).encode()
            signature = 'sha256=' + hmac.new(secret, body, hashlib.sha256).hexdigest()
            ingress.initialize(queue, key)
            for item in (delivery(2), delivery(3)):
                self.assertEqual(ingress.receive(queue, secret, key, registry, item, 'issue_comment', signature, body), 'accepted')
            with worker_ledger.Ledger(ledger_path, lock_path, allow_create=True) as ledger:
                scheduler = ScanScheduler(ledger, queue, key, page_size=1)
                self.assertFalse(scheduler.step()['passComplete'])
                self.assertEqual(ingress.receive(queue, secret, key, registry, delivery(1), 'issue_comment', signature, body), 'accepted')
                self.assertTrue(scheduler.step()['passComplete'])
                self.assertEqual(ledger.pending_preview(), [delivery(2), delivery(3)])
                self.assertFalse(scheduler.step()['passComplete'])
                self.assertEqual(ledger.pending_preview(), [delivery(2), delivery(3), delivery(1)])


if __name__ == '__main__':
    unittest.main()
