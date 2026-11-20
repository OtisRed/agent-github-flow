"""One deployment attempt; the executor remains owned by the project.

The caller supplies authenticated GitHub verification and a fixed trusted
executor. An exception after dispatch is uncertain, not a reason to retry.
"""
from deployment_state import SHA, _request


def _result(request, result):
    if (not isinstance(result, dict) or set(result) != {'id', 'target', 'commit', 'observed_commit', 'status'}
            or result['id'] != request['id'] or result['target'] != request['target']
            or result['commit'] != request['commit'] or result['status'] not in ('succeeded', 'failed')
            or (result['status'] == 'succeeded' and result['observed_commit'] != request['commit'])
            or (result['status'] == 'failed' and result['observed_commit'] is not None
                and (not isinstance(result['observed_commit'], str) or not SHA.fullmatch(result['observed_commit'])))):
        raise ValueError('Unconfirmed executor result')
    return result['status']


def validate_unstarted_proof(request, proof):
    if (not isinstance(proof, dict) or set(proof) != {'request', 'status'}
            or proof['status'] != 'not-started' or _request(proof['request']) != _request(request)):
        raise ValueError('No proof that the exact dispatch can be retried')


def run_deployment_once(store, request, verify, execute):
    if not callable(verify) or not callable(execute):
        raise ValueError('Missing deployment dependencies')
    if verify(request) is not True:
        return 'not-verified'
    status = store.reserve(request)
    if status != 'reserved':
        return status
    # A queued request is not proof that branch head and CI remain current.
    if verify(request) is not True:
        store.transition(request, 'reserved', 'superseded')
        return 'not-verified'
    store.transition(request, 'reserved', 'running')
    try:
        result = _result(request, execute(request))
    except Exception:
        store.transition(request, 'running', 'unknown')
        return 'unknown'
    store.transition(request, 'running', result)
    return result


def reconcile_deployment(store, request, observed):
    """Accept only a confirmed result for the same persisted attempt."""
    status = _result(request, observed)
    current = store.get_attempt(request)
    if current is None or current['request'] != request or current['status'] not in ('running', 'unknown'):
        raise ValueError('No matching unresolved deployment')
    return store.transition(request, current['status'], status)
