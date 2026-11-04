"""Bounded in-memory scan progress; this is not a daemon or a writer.

The caller must keep the same exclusive ledger lock for each step and bind
this object to the same trusted ingress and ledger for its whole lifetime.
"""
import sqlite3
import threading
import webhook_ingress as ingress


class ScanScheduler:
    def __init__(self, ledger, ingress_path, fingerprint_key, *, page_size=100):
        if type(page_size) is not int or not 1 <= page_size <= 100:
            raise ValueError("Invalid page size")
        self.ledger = ledger
        self.ingress_path = ingress_path
        self.fingerprint_key = fingerprint_key
        self.page_size = page_size
        self._after = None
        self._step_lock = threading.Lock()

    def step(self):
        """Import one committed page, retaining the marker across bounded steps.

        A completed pass resets the in-memory marker. Restarting the process
        starts another pass from the beginning; no external mutation is sent.
        """
        if not self._step_lock.acquire(blocking=False):
            return {'kind': 'blocked'}
        try:
            return self._step_locked()
        finally:
            self._step_lock.release()

    def _step_locked(self):
        previous = self._after
        try:
            result = self.ledger.import_page(self.ingress_path, self.fingerprint_key,
                                             after=previous, limit=self.page_size)
        except (OSError, sqlite3.Error, ValueError, RuntimeError):
            return {'kind': 'blocked'}
        if (type(result) is not dict or result.get('kind') != 'page-imported'
                or type(result.get('more')) is not bool):
            return {'kind': 'blocked'}
        next_after = result.get('nextAfter')
        if (next_after is not None and (not ingress.canonical_delivery(next_after)
                                      or (previous is not None and next_after <= previous))):
            return {'kind': 'blocked'}
        if result['more'] and next_after is None:
            return {'kind': 'blocked'}
        self._after = next_after if result['more'] else None
        return {'kind': 'page-imported', 'passComplete': not result['more']}
