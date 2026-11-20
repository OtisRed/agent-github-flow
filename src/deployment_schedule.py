"""Opt-in polling of trusted branch heads; no webhook payload is executable."""
import os
import stat
import sys
from pathlib import Path

from deployment_dispatch import bootstrap_current_main, dispatch_current
from deployment_executor import ProjectExecutor
from deployment_source import branch_head, deployment_checks
from deployment_state import DeploymentState
from deployment_worker import reconcile_deployment
from mvp_credentials import AppToken
from mvp_github import request


def trusted_executor(path):
    """Require a root-owned executable and non-writable, non-symlink parents."""
    if not isinstance(path, str) or not os.path.isabs(path) or os.path.realpath(path) != path:
        raise ValueError('Invalid executor path')
    current = Path(path)
    while True:
        info = os.lstat(current)
        if (info.st_uid != 0 or info.st_mode & 0o022
                or (current == Path(path) and not stat.S_ISREG(info.st_mode))
                or (current != Path(path) and not stat.S_ISDIR(info.st_mode))):
            raise ValueError('Executor path is not root controlled')
        if current.parent == current:
            break
        current = current.parent
    if not os.access(path, os.X_OK):
        raise ValueError('Executor is not executable')
    return ProjectExecutor((path,), timeout=1200)


def run_deployments(stop, config, private_key, *, transport=request, executor_factory=trusted_executor):
    projects = []
    for project in config['projects']:
        if project.get('deployment_enabled') is True:
            token = AppToken(config['app_id'], config['installation_id'], project['repository_id'], private_key,
                             purpose='deployment', transport=transport)
            projects.append((project, token))
    store = DeploymentState(config['deployment_state_path'])
    previous = {}
    while not stop.is_set():
        for project, token in projects:
            smoke_only = project.get('deployment_smoke_only') is True
            try:
                executor = executor_factory(project['deployment_executor'])
                unresolved = store.unresolved(project['repository_id'])
                current = store.get(project['repository_id'])
            except Exception:
                key = (project['repository_id'], 'setup')
                if previous.get(key) != 'blocked':
                    print('FLOW attention: deployment-blocked repo=' + str(key[0]) + ' target=setup', file=sys.stderr, flush=True)
                    previous[key] = 'blocked'
                continue
            if unresolved and unresolved['status'] in ('running', 'unknown'):
                if smoke_only and unresolved['request']['target'] != 'smoke':
                    continue
                try:
                    reconcile_deployment(store, unresolved['request'], executor.status(unresolved['request']))
                except Exception:
                    pass  # An unconfirmed result remains durably blocked.
            # A reservation has not dispatched any project command. After a
            # restart, either retry its still-current target first, or retire
            # it when the trusted branch has moved. Never discard it merely
            # because GitHub is unavailable or CI cannot be checked.
            if current and current['status'] == 'reserved':
                pending = current['request']
                if smoke_only and pending['target'] != 'smoke':
                    continue
                try:
                    head = branch_head(transport, token(), project['owner'], project['repository'], pending['target'])
                    if head != pending['commit']:
                        store.transition(pending, 'reserved', 'superseded')
                    elif pending['id'] == f"bootstrap-main-{pending['commit']}":
                        result = bootstrap_current_main(transport, token(), project['owner'], project['repository'],
                                                        project['repository_id'], deployment_checks(project, 'main'),
                                                        store, executor)
                        if result != 'succeeded':
                            continue
                    else:
                        result = dispatch_current(transport, token(), project['owner'], project['repository'],
                                                  project['repository_id'], pending['target'],
                                                  deployment_checks(project, pending['target']), store, executor)
                        if result != 'succeeded':
                            continue
                except Exception:
                    print('FLOW attention: deployment-blocked repo=' + str(project['repository_id'])
                          + ' target=reservation', file=sys.stderr, flush=True)
                    continue
            if not smoke_only:
                try:
                    baseline = bootstrap_current_main(transport, token(), project['owner'], project['repository'],
                                                      project['repository_id'], deployment_checks(project, 'main'),
                                                      store, executor)
                except Exception:
                    baseline = 'blocked'
                if baseline not in ('succeeded', 'already-initialized'):
                    key = (project['repository_id'], 'bootstrap')
                    if previous.get(key) != baseline:
                        print('FLOW attention: deployment-' + baseline + ' repo=' + str(key[0]) + ' target=bootstrap', file=sys.stderr, flush=True)
                        previous[key] = baseline
                    continue
            for target in (('smoke',) if smoke_only else ('main', 'smoke')):
                if stop.is_set():
                    break
                try:
                    result = dispatch_current(transport, token(), project['owner'], project['repository'],
                                              project['repository_id'], target, deployment_checks(project, target),
                                              store, executor)
                except Exception:
                    result = 'blocked'
                key = (project['repository_id'], target)
                if previous.get(key) != result:
                    attention = result in ('blocked', 'unknown', 'failed', 'running')
                    print(('FLOW attention: deployment-' if attention else 'FLOW deployment: ') + result
                          + ' repo=' + str(key[0]) + ' target=' + target,
                          file=sys.stderr if attention else sys.stdout, flush=True)
                    previous[key] = result
                if result != 'succeeded':
                    break
        stop.wait(60)
