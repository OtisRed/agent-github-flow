#!/usr/bin/env python3
"""Rehearse an AGF self-deployment with transient, isolated systemd units."""
import json
import os
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1] / 'src'
BASELINE = 'a' * 40
RELEASE = 'b' * 40
BAD_RELEASE = 'c' * 40
REPOSITORY_ID = 1  # Synthetic identity, independent of the installed controller.
PREFIX = 'agf-deployment-rehearsal-'


def command(*args, required=True):
    return subprocess.run(args, check=required, capture_output=True, text=True, timeout=20)


def wait_for(probe, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = probe()
        if value:
            return value
        time.sleep(0.1)
    raise RuntimeError('Timed out waiting for rehearsal evidence')


def write_atomic(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(value, encoding='utf-8')
    temp.replace(path)


def unit(root, role):
    if not re.fullmatch(PREFIX + r'[a-z0-9_]{8}', root.name):
        raise ValueError('Invalid rehearsal directory')
    return root.name + '-' + role + '.service'


def runtime_file(root, sha):
    if sha not in (BASELINE, RELEASE, BAD_RELEASE):
        raise ValueError('Unknown fixture revision')
    return root / ('main-' + sha) / 'serve.py'


def running_sha(root):
    service = unit(root, 'controller')
    def state():
        return command('systemctl', 'show', service, '-p', 'MainPID',
                       '-p', 'InvocationID', '-p', 'ActiveState').stdout
    first = state()
    fields = dict(line.split('=', 1) for line in first.splitlines())
    if fields['ActiveState'] != 'active' or fields['MainPID'] == '0' or not fields['InvocationID']:
        return None
    try:
        argv = (Path('/proc') / fields['MainPID'] / 'cmdline').read_bytes().split(b'\0')
    except FileNotFoundError:
        return None
    for sha in (BASELINE, RELEASE):
        if os.fsencode(runtime_file(root, sha)) in argv and state() == first:
            return sha
    return None


def launch(root):
    sha = (root / 'current').read_text(encoding='utf-8')
    os.execv(sys.executable, [sys.executable, '-B', str(runtime_file(root, sha))])


def deployment_request(sha):
    return {'id': 'main-' + sha, 'repository_id': REPOSITORY_ID, 'target': 'main',
            'commit': sha, 'changes': ['issue-300']}


def project_executor(root, sha):
    wait_for(lambda: (root / 'allow-worker').exists())
    before = (root / 'current').read_text(encoding='utf-8')
    if running_sha(root) != before:
        raise RuntimeError('Rehearsal baseline is not running')
    write_atomic(root / 'current', sha)
    service = unit(root, 'controller')
    command('systemctl', 'restart', service, required=False)

    def activation_outcome():
        if running_sha(root) == sha:
            return 'succeeded'
        if command('systemctl', 'is-failed', service, required=False).returncode == 0:
            return 'failed'
        return None

    try:
        state = wait_for(activation_outcome)
    except RuntimeError:
        state = 'failed'
    if state == 'failed':
        write_atomic(root / 'current', before)
        command('systemctl', 'restart', service)
        wait_for(lambda: running_sha(root) == before)
        observed = before
    else:
        observed = sha
    request = deployment_request(sha)
    result = {key: request[key] for key in ('id', 'target', 'commit')}
    write_atomic(root / 'result.json', json.dumps(
        {**result, 'observed_commit': observed, 'status': state}))


def request_deployment(root, sha, source):
    sys.path.insert(0, source)
    from deployment_state import DeploymentState
    from deployment_worker import run_deployment_once

    def launch_executor(_request):
        command('systemd-run', '--quiet', '--collect', '--unit=' + unit(root, 'executor'),
                sys.executable, '-B', __file__, 'executor', str(root), sha)
        write_atomic(root / 'submitted', sha)
        while not (root / 'result.json').exists():
            time.sleep(0.1)
        return json.loads((root / 'result.json').read_text(encoding='utf-8'))

    run_deployment_once(DeploymentState(root / 'deployment.sqlite'), deployment_request(sha),
                        lambda _: True, launch_executor)


def rehearse(root):
    sys.path.insert(0, str(SOURCE))
    from deployment_state import DeploymentState
    from deployment_worker import reconcile_deployment, run_deployment_once

    shutil.copyfile(__file__, root / 'rehearsal.py')
    for sha in (BASELINE, RELEASE, BAD_RELEASE):
        fixture = runtime_file(root, sha)
        fixture.parent.mkdir()
        fixture.write_text('raise SystemExit(1)\n' if sha == BAD_RELEASE else
                           'import signal\nwhile True: signal.pause()\n', encoding='utf-8')
    write_atomic(root / 'current', BASELINE)
    command('systemd-run', '--quiet', '--unit=' + unit(root, 'controller'),
            sys.executable, '-B', str(root / 'rehearsal.py'), 'launch', str(root))
    wait_for(lambda: running_sha(root) == BASELINE)
    store = DeploymentState(root / 'deployment.sqlite')
    store.initialize()
    for sha, expected, observed in ((RELEASE, 'succeeded', RELEASE), (BAD_RELEASE, 'failed', RELEASE)):
        for name in ('submitted', 'allow-worker', 'result.json'):
            (root / name).unlink(missing_ok=True)
        process = subprocess.Popen([sys.executable, '-B', str(root / 'rehearsal.py'),
                                    'request', str(root), sha, str(SOURCE)])
        try:
            wait_for(lambda: (root / 'submitted').exists())
        finally:
            process.kill()
            process.wait(timeout=5)
        request = deployment_request(sha)
        if store.get_attempt(request)['status'] != 'running':
            raise RuntimeError('Expected a durable in-flight attempt')
        write_atomic(root / 'allow-worker', sha)
        wait_for(lambda: (root / 'result.json').exists(), timeout=40)
        response = json.loads((root / 'result.json').read_text(encoding='utf-8'))
        if response['status'] != expected or response['observed_commit'] != observed:
            raise RuntimeError('Unexpected result from independent executor')
        reconcile_deployment(store, request, response)
        if running_sha(root) != observed:
            raise RuntimeError('Running process does not match reconciled SHA')
        if expected == 'succeeded':
            def unexpected(_):
                raise AssertionError('A reconciled deployment was dispatched again')
            if run_deployment_once(store, request, lambda _: True, unexpected) != 'succeeded':
                raise RuntimeError('Reconciled result was not reused')
        wait_for(lambda: command('systemctl', 'is-active', unit(root, 'executor'), required=False)
                 .returncode != 0)
        print(f'{expected} observed={observed} request_client=stopped', flush=True)


def main(argv):
    if argv:
        action, location, *args = argv
        root = Path(location)
        if root.parent != Path('/tmp') or not root.is_dir() or root.resolve() != root:
            raise ValueError('Invalid fixture root')
        unit(root, 'controller')
        {'launch': launch, 'executor': project_executor, 'request': request_deployment}[action](root, *args)
        return
    if os.geteuid() != 0:
        raise ValueError('Systemd rehearsal requires an authorized local operator')
    with tempfile.TemporaryDirectory(dir='/tmp', prefix=PREFIX) as folder:
        root = Path(folder)
        try:
            rehearse(root)
        finally:
            for role in ('executor', 'controller'):
                command('systemctl', 'stop', unit(root, role), required=False)
                command('systemctl', 'reset-failed', unit(root, role), required=False)


if __name__ == '__main__':
    main(sys.argv[1:])
