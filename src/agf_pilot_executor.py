"""Socket-activated one-release executor for the AGF controller only."""
import fcntl
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from deployment_state import SHA, _request
from ondemand_executor import _trusted_path


UNIT = 'agent-github-flow-mvp.service'
REPOSITORY = 1441717950
RELEASES = Path('/opt/agent-github-flow-mvp/releases')
PIN = Path('/etc/systemd/system/agent-github-flow-mvp.service.d/60-release.conf')
CONFIG = Path('/etc/agent-github-flow-mvp/config.json')
PILOT = Path('/etc/agf-controller-pilot.json')
STATE = Path('/var/lib/agf-controller-pilot')
MAX_INPUT = 8192


def load_json(path):
    _trusted_path(str(path))
    with path.open('rb') as stream:
        return json.loads(stream.read(MAX_INPUT + 1))


def command(*args, input_data=None, timeout=20):
    return subprocess.check_output(args, input=input_data, stderr=subprocess.DEVNULL,
                                   timeout=timeout, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})


def release(sha):
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise ValueError('Invalid release SHA')
    return RELEASES / f'main-{sha}'


def entry(sha):
    return release(sha) / 'src/mvp_service.py'


def running(sha):
    def service():
        return command('systemctl', 'show', UNIT, '-p', 'MainPID',
                       '-p', 'ActiveState', '-p', 'InvocationID')
    before = service()
    fields = dict(line.split('=', 1) for line in before.decode().splitlines())
    pid = int(fields['MainPID'])
    if pid <= 0 or fields['ActiveState'] != 'active' or not fields['InvocationID']:
        return False
    argv = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
    return argv[1:5] == [os.fsencode(entry(sha)), b'run', os.fsencode(CONFIG), b''] and service() == before


def ready(sha, port, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if running(sha):
                with socket.create_connection(('127.0.0.1', port), timeout=1):
                    if running(sha):
                        return True
        except (OSError, subprocess.SubprocessError):
            pass
        time.sleep(0.25)
    return False


def atomic_write(path, contents):
    fd, part = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.replace(part, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(part).unlink(missing_ok=True)


def pin_text(sha):
    return (f'[Service]\nExecStart=\nExecStart=/usr/bin/python3 {entry(sha)} run {CONFIG}\n'
            f'Environment=AGF_RELEASE_SHA={sha}\n').encode()


def restart():
    command('systemctl', 'daemon-reload')
    command('systemctl', 'restart', UNIT, timeout=40)


def check_release(sha):
    _trusted_path(str(entry(sha)))
    for directory, dirs, files in os.walk(release(sha), followlinks=False):
        for name in dirs + files:
            info = (Path(directory) / name).lstat()
            if (info.st_uid != 0 or info.st_mode & 0o022
                    or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))):
                raise ValueError('Release contains untrusted paths')


def target_request(raw):
    request = json.loads(_request(raw))
    commit = request['commit']
    if (request['repository_id'] != REPOSITORY or request['target'] != 'main'
            or request['id'] not in ('main-' + commit, 'bootstrap-main-' + commit)):
        raise ValueError('Out of pilot scope')
    return request


def result(request, status, observed):
    return {key: request[key] for key in ('id', 'target', 'commit')} | {
        'status': status, 'observed_commit': observed,
    }


def execute(action, request, permit, *, port):
    baseline = permit['baseline']
    commit = request['commit']
    if action == 'status' and request['id'] == 'bootstrap-main-' + baseline and request['changes'] == []:
        if ready(baseline, port, 2):
            return result(request, 'succeeded', baseline)
        raise RuntimeError('Baseline is not running')
    armed = target_request(permit['request'])
    if request != armed or request['id'] != 'main-' + commit or commit == baseline:
        raise ValueError('Request is outside the one-release permit')
    receipt = STATE / 'receipt.json'
    if receipt.exists():
        saved = load_json(receipt)
        choices = {'succeeded': commit, 'failed': baseline}
        status = saved.get('status')
        if (status not in choices or saved != result(request, status, choices[status])
                or not ready(choices[status], port, 2)):
            raise RuntimeError('Previous attempt still needs reconciliation')
        return saved
    if action != 'deploy':
        raise RuntimeError('No confirmed attempt')

    for sha in (baseline, commit):
        check_release(sha)
    attestation = release(baseline) / 'src/deployment_attestation.py'
    _trusted_path(str(attestation))
    _trusted_path(str(PIN))
    if PIN.read_bytes() != pin_text(baseline) or not ready(baseline, port, 2):
        raise RuntimeError('Baseline changed')
    approved = command('runuser', '-u', 'agent-flow', '--', '/usr/bin/python3', '-B',
                       str(attestation), str(CONFIG), input_data=_request(request).encode(), timeout=75)
    if json.loads(approved) != {'confirmed': True}:
        raise ValueError('Controller did not attest the running request')
    if PIN.read_bytes() != pin_text(baseline) or not ready(baseline, port, 2):
        raise RuntimeError('Baseline changed during attestation')
    atomic_write(receipt, json.dumps(result(request, 'running', None)).encode())
    try:
        atomic_write(PIN, pin_text(commit))
        restart()
        if not ready(commit, port, 25):
            raise RuntimeError('Candidate did not become ready')
    except (RuntimeError, OSError, subprocess.SubprocessError):
        atomic_write(PIN, pin_text(baseline))
        restart()
        if not ready(baseline, port, 25):
            raise RuntimeError('Rollback could not be confirmed')
        completed = result(request, 'failed', baseline)
    else:
        completed = result(request, 'succeeded', commit)
    atomic_write(receipt, json.dumps(completed).encode())
    return completed


def serve_request(state, handle):
    os.umask(0o077)
    raw = sys.stdin.buffer.readline(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT or not raw.endswith(b'\n'):
        raise ValueError('Invalid request framing')
    envelope = json.loads(raw)
    if set(envelope) != {'action', 'request'} or envelope['action'] not in ('deploy', 'status'):
        raise ValueError('Invalid action')
    request = target_request(envelope['request'])
    # The operator owns this directory. The service account has no write access.
    st = state.stat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077 or state.resolve() != state:
        raise ValueError('Invalid executor state directory')
    fd = os.open(state / 'deploy.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with CONFIG.open(encoding='utf-8') as stream:
            port = json.load(stream)['port']
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError('Invalid controller port')
        print(json.dumps(handle(envelope['action'], request, port=port)), flush=True)
    finally:
        os.close(fd)


def serve():
    def handle(action, request, *, port):
        permit = load_json(PILOT)
        if set(permit) != {'baseline', 'request'}:
            raise ValueError('Invalid permit')
        release(permit['baseline'])
        return execute(action, request, permit, port=port)

    serve_request(STATE, handle)


if __name__ == '__main__':
    try:
        serve()
    except (ValueError, KeyError, TypeError, OSError, RuntimeError, subprocess.SubprocessError):
        # An empty response leaves the shared ledger unresolved. Do not retry a restart blindly.
        sys.exit(1)
