"""Derive and dispatch one current trusted-branch deployment."""
from deployment_source import branch_head, promoted_scope, verify_head_and_ci
from deployment_worker import run_deployment_once
from deployment_worker import _result


def bootstrap_current_main(transport, token, owner, repository, repository_id, required, store, execute):
    """Record a baseline only after CI and the project attest the same live SHA."""
    if store.get(repository_id) is not None:
        return 'already-initialized'
    commit = branch_head(transport, token, owner, repository, 'main')
    request = {'id': f'bootstrap-main-{commit}', 'repository_id': repository_id,
               'target': 'main', 'commit': commit, 'changes': []}
    if not verify_head_and_ci(transport, token, owner, repository, 'main', commit, required):
        return 'not-verified'
    if not callable(getattr(execute, 'status', None)) or _result(request, execute.status(request)) != 'succeeded':
        return 'not-verified'
    if not verify_head_and_ci(transport, token, owner, repository, 'main', commit, required):
        return 'not-verified'
    if store.reserve(request) != 'reserved':
        return 'blocked'
    store.transition(request, 'reserved', 'running')
    store.transition(request, 'running', 'succeeded')
    return 'succeeded'


def dispatch_current(transport, token, owner, repository, repository_id, target, required, store, execute):
    commit = branch_head(transport, token, owner, repository, target)
    if store.has_uncertain(repository_id):
        return 'blocked'
    latest = store.get(repository_id)
    previous = store.last_success(repository_id, target)
    if previous and previous['commit'] == commit:
        if latest and latest['status'] not in ('succeeded', 'superseded'):
            return 'blocked'
        if not verify_head_and_ci(transport, token, owner, repository, target, commit, required):
            return 'not-verified'
        try:
            if not callable(getattr(execute, 'status', None)) or _result(previous, execute.status(previous)) != 'succeeded':
                raise ValueError('Runtime version unavailable')
        except Exception:
            store.transition(previous, 'succeeded', 'unknown', 'runtime-unconfirmed')
            return 'unknown'
        return 'succeeded'
    scope = promoted_scope(transport, token, owner, repository, repository_id, commit, store) if target == 'main' else {'changes': [], 'commits': []}
    request = {'id': f'{target}-{commit}', 'repository_id': repository_id, 'target': target,
               'commit': commit, 'changes': scope['changes']}

    def verify(candidate):
        if not verify_head_and_ci(transport, token, owner, repository, target, candidate['commit'], required):
            return False
        if target == 'main':
            return promoted_scope(transport, token, owner, repository, repository_id, commit, store) == scope
        return True

    return run_deployment_once(store, request, verify, execute)
