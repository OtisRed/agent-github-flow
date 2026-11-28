"""Versioned AGF main executor. Install from a reviewed, root-owned release."""
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

import agf_pilot_executor as pilot


STATE = Path('/var/lib/agf-controller-executor')
HANDOVER = Path('/etc/agf-controller-executor-handover.json')
MAX_ARCHIVE = 100 * 1024 * 1024
TIMEOUT = 740
FAILURES = (OSError, RuntimeError, ValueError, subprocess.SubprocessError, tarfile.TarError)
PIN_SHA = re.compile(rb'(?m)^Environment=AGF_RELEASE_SHA=([a-f0-9]{40})$')


def current_pin():
    pilot._trusted_path(str(pilot.PIN))
    contents = pilot.PIN.read_bytes()
    match = PIN_SHA.search(contents)
    if match is None:
        raise ValueError('Missing managed release pin')
    sha = match[1].decode()
    if contents != pilot.pin_text(sha):
        raise ValueError('Unexpected managed release pin')
    return sha


def helper(name, data, *, timeout, output=None):
    # Resolve the helper in this installed executor release, never in a candidate.
    script = Path(__file__).resolve().with_name(name)
    pilot._trusted_path(str(script))
    args = ('runuser', '-u', 'agent-flow', '--', '/usr/bin/python3', '-B',
            str(script), str(pilot.CONFIG))
    if output is None:
        return pilot.command(*args, input_data=data, timeout=timeout)
    subprocess.run(args, input=data, stdout=output, stderr=subprocess.DEVNULL,
                   check=True, timeout=timeout, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})


def unpack(stream, root):
    names = set()
    expanded = 0
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if (path.is_absolute() or not path.parts or '..' in path.parts
                    or '\\' in member.name or path in names or len(names) >= 10000):
                raise ValueError('Unsafe release path')
            names.add(path)
            destination = root.joinpath(*path.parts)
            if member.isdir():
                destination.mkdir(mode=0o755, parents=True, exist_ok=True)
                continue
            expanded += member.size
            if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or member.sparse is not None or member.size < 0 or expanded > MAX_ARCHIVE:
                raise ValueError('Unsafe release entry')
            destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            with archive.extractfile(member) as source, destination.open('xb') as target:
                shutil.copyfileobj(source, target)
                os.fchmod(target.fileno(), 0o755 if member.mode & 0o111 else 0o644)
                target.flush()
                os.fsync(target.fileno())


@contextmanager
def prepare(request):
    sha = request['commit']
    destination = pilot.release(sha)
    pilot._trusted_path(str(destination.parent), directory=True)
    if destination.exists() or destination.is_symlink():
        raise ValueError('An unreceipted release already exists')
    data = json.dumps({'request': request, 'ref': 'main'}).encode()
    with tempfile.TemporaryFile(dir=STATE) as archive:
        helper('deployment_archive.py', data, timeout=TIMEOUT, output=archive)
        if archive.tell() > MAX_ARCHIVE + 41:
            raise ValueError('Oversized archive')
        archive.seek(0)
        if archive.read(41) != (sha + '\n').encode():
            raise ValueError('Archive SHA mismatch')
        stage = Path(tempfile.mkdtemp(prefix='.agf-stage-', dir=destination.parent))
        try:
            unpack(archive, stage)
            if not (stage / 'src/mvp_service.py').is_file():
                raise ValueError('Missing release entry point')
            # The install and pin are separate. Journal intent before publishing
            # the release; an interruption after that point requires readback.
            stage.chmod(0o755)
            yield stage
        finally:
            if stage.exists():
                shutil.rmtree(stage)


def attest(request):
    approved = helper('deployment_attestation.py', pilot._request(request).encode(), timeout=75)
    if json.loads(approved) != {'confirmed': True}:
        raise ValueError('Deployment authorization changed')


def observe(sha, port):
    return current_pin() == sha and pilot.ready(sha, port, 2)


def execute(action, request, *, port):
    commit = request['commit']
    baseline = current_pin()
    if request['id'].startswith('bootstrap-'):
        if action == 'status' and request['changes'] == [] and commit == baseline and observe(baseline, port):
            return pilot.result(request, 'succeeded', baseline)
        raise ValueError('Invalid bootstrap query')

    receipt = STATE / (commit + '.json')

    def persist(status, previous):
        pilot.atomic_write(receipt, json.dumps({'request': request, 'baseline': previous,
                                                'status': status}).encode())

    if receipt.exists():
        saved = pilot.load_json(receipt)
        previous = saved['baseline']
        pilot.release(previous)
        if saved['request'] != request:
            raise ValueError('Request differs from the receipt')
        status = saved['status']
        if status == 'running' and action == 'status' and observe(commit, port):
            status = 'succeeded'
            persist(status, previous)
        if status == 'rollback' and action == 'status' and observe(previous, port):
            status = 'failed'
            persist(status, previous)
        observed = {'succeeded': commit, 'failed': previous}.get(status)
        if observed and observe(observed, port):
            return pilot.result(request, status, observed)
        raise RuntimeError('Attempt requires reconciliation')
    if action == 'status' and baseline == commit and HANDOVER.exists():
        handover = pilot.target_request(pilot.load_json(HANDOVER))
        if handover == request and observe(commit, port):
            pilot.check_release(commit)
            persist('succeeded', commit)
            return pilot.result(request, 'succeeded', commit)
    if action != 'deploy' or baseline == commit or not observe(baseline, port):
        raise RuntimeError('No confirmed attempt or healthy baseline')
    pilot.check_release(baseline)

    try:
        with prepare(request) as stage:
            attest(request)
            if not observe(baseline, port):
                raise RuntimeError('Baseline changed')
            persist('running', baseline)
            install(stage, commit)
    except FAILURES:
        print('AGF executor: package or admission failed', file=sys.stderr, flush=True)
        if not observe(baseline, port):
            raise
        persist('failed', baseline)
        return pilot.result(request, 'failed', baseline)

    try:
        pilot.atomic_write(pilot.PIN, pilot.pin_text(commit))
        pilot.restart()
        if not pilot.ready(commit, port, 25):
            raise RuntimeError('Candidate did not become ready')
    except FAILURES:
        print('AGF executor: candidate start failed, restoring baseline', file=sys.stderr, flush=True)
        persist('rollback', baseline)
        pilot.atomic_write(pilot.PIN, pilot.pin_text(baseline))
        pilot.restart()
        if not observe(baseline, port):
            raise RuntimeError('Rollback could not be confirmed')
        status, observed = 'failed', baseline
    else:
        status, observed = 'succeeded', commit
    persist(status, baseline)
    return pilot.result(request, status, observed)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def install(stage, commit):
    for directory, _, _ in os.walk(stage, topdown=False):
        os.chmod(directory, 0o755)
        sync_directory(directory)
    os.rename(stage, pilot.release(commit))
    sync_directory(stage.parent)
    pilot.check_release(commit)


if __name__ == '__main__':
    try:
        pilot.serve_request(STATE, execute)
    except FAILURES + (TypeError, KeyError):
        # Keep payloads and credentials out of stdout and the journal.
        raise SystemExit(1)