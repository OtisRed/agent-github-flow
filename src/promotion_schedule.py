"""Nightly promotion on the existing controller host."""
import queue
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from mvp_credentials import AppToken
from mvp_github import request
from promotion_runner import promotion_step
from deployment_state import DeploymentState
from deployment_schedule import trusted_executor
from deployment_worker import _result


def promotion_mode(project):
    """Keep existing enrollment semantics and select one route for the process lifetime."""
    if type(project.get('promotion_enabled', False)) is not bool:
        raise ValueError("Invalid promotion setting")
    mode = project.get('promotion_mode', 'prefix')
    if mode not in ('prefix', 'paused', 'selective'):
        raise ValueError("Invalid promotion mode")
    return mode if project.get('promotion_enabled') is True else 'paused'


def run_promotions(stop, config, private_key, *, transport=request, quickfix_queue=None, selective_step=None):
    """Dispatch nightly and quickfix work through the same selected route."""
    projects = {}
    for project in config['projects']:
        mode = promotion_mode(project)
        if mode == 'paused':
            continue
        repository_id = project['repository_id']
        if repository_id in projects:
            raise ValueError("Duplicate promotion repository")
        token = None
        if mode == 'prefix' or (callable(selective_step) and not project.get('deployment_guarded')):
            token = AppToken(config['app_id'], config['installation_id'], repository_id, private_key,
                             purpose='promotion', transport=transport)
        projects[repository_id] = (project, mode, token)
    zone = ZoneInfo('Europe/Warsaw')
    previous = {}
    requested = set()
    while not stop.is_set():
        now = datetime.now(zone)
        nightly = 3 <= now.hour < 5
        if quickfix_queue is not None:
            while True:
                try:
                    repository_id = quickfix_queue.get_nowait()
                    if repository_id in projects:
                        requested.add(repository_id)
                except queue.Empty:
                    break
        if nightly or requested:
            for repository_id, (project, mode, token) in projects.items():
                if stop.is_set():
                    break
                if not nightly and repository_id not in requested:
                    continue
                try:
                    if mode == 'selective':
                        result = 'selective-unavailable' if token is None else selective_step(transport, token(), project)
                    elif project.get('deployment_guarded') is True:
                        store = DeploymentState(config['deployment_state_path'])
                        with store.promotion_guard(project['repository_id']) as ready:
                            executor = trusted_executor(project['deployment_executor'])
                            def guarded_ready(sha):
                                if not ready(sha):
                                    return False
                                previous = store.last_success(project['repository_id'], 'main')
                                if previous is None or previous['commit'] != sha:
                                    return False
                                try:
                                    return _result(previous, executor.status(previous)) == 'succeeded'
                                except Exception:
                                    return False
                            guarded_ready.capture = ready.capture
                            result = promotion_step(transport, token(), project['owner'], project['repository'], deployment_ready=guarded_ready)
                    else:
                        result = promotion_step(transport, token(), project['owner'], project['repository'])
                except Exception:
                    result = 'failed'
                if result not in ('branch-created', 'pull-request-created', 'waiting-checks', 'changed', 'merged'):
                    requested.discard(repository_id)
                if previous.get(project['repository_id']) != result:
                    alert = result in ('failed', 'protection-required', 'blocked', 'deployment-blocked',
                                       'selective-unavailable')
                    print(('FLOW attention: promotion-' if alert else 'FLOW promotion: ') + result
                          + ' repo=' + str(project['repository_id']),
                          file=sys.stderr if alert else sys.stdout, flush=True)
                    previous[project['repository_id']] = result
        else:
            for repository_id, result in previous.items():
                if result in ('branch-created', 'pull-request-created', 'waiting-checks', 'changed'):
                    print('FLOW attention: promotion-incomplete repo=' + str(repository_id), file=sys.stderr, flush=True)
            previous.clear()
        stop.wait(60)
