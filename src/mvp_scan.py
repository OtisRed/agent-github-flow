"""Feed reconciliation into the regular FIFO one candidate at a time."""


def stage_one(store, backlog):
    if not backlog:
        return False
    repository_id, issue_number = backlog[0]
    store.enqueue(repository_id, issue_number)
    backlog.popleft()
    return True
