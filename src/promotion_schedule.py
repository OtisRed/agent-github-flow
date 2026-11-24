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


def run_promotions(stop, config, private_key, *, transport=request, quickfix_queue=None):
    """Resume night work from GitHub state; never run two attempts in parallel."""
    projects = []
    for project in config['projects']:
        if project.get('promotion_enabled') is True:
            token = AppToken(config['app_id'], config['installation_id'], project['repository_id'], private_key,
                             purpose='promotion', transport=transport)
            projects.append((project, token))
    zone = ZoneInfo('Europe/Warsaw')
    previous = {}
    requested = set()
    while not stop.is_set():
        now = datetime.now(zone)
        nightly = 3 <= now.hour < 5
        if quickfix_queue is not None:
            while True:
                try:
                    requested.add(quickfix_queue.get_nowait())
                except queue.Empty:
                    break
        if nightly or requested:
            for project, token in projects:
                if stop.is_set():
                    break
                repository_id = project['repository_id']
                if not nightly and repository_id not in requested:
                    continue
                try:
                    if project.get('deployment_guarded') is True:
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
                    alert = result in ('failed', 'protection-required', 'blocked', 'deployment-blocked')
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
