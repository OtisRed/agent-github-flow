"""Feed reconciliation into the regular FIFO one candidate at a time."""
import queue
import threading
import time


def stage_one(store, backlog):
    if not backlog:
        return False
    repository_id, issue_number = backlog[0]
    store.enqueue(repository_id, issue_number)
    backlog.popleft()
    return True


def collect_in_background(store, clients, repository_ids, stop):
    """Collect candidates read-only without holding up the sole issue worker."""
    results = queue.SimpleQueue()

    def collect():
        try:
            for repository_id in repository_ids:
                if stop.is_set():
                    break
                client, enrolled_at = clients[repository_id]
                started = time.monotonic()
                try:
                    known = store.known_issue_numbers(repository_id)
                    candidates = client.reconciliation_candidates(enrolled_at, known)
                except Exception:
                    results.put((repository_id, None, time.monotonic() - started))
                else:
                    results.put((repository_id, candidates, time.monotonic() - started))
        finally:
            results.put(None)

    threading.Thread(target=collect, daemon=True, name="flow-scan").start()
    return results
