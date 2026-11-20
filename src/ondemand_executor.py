"""Systemd socket-activated, fixed-registry deployment dispatcher.

One process handles one local request. Project commands and the registry are
operator-owned; request contents never select an arbitrary executable.
"""
import fcntl
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

from deployment_state import _request
from deployment_worker import _result, validate_unstarted_proof

REGISTRY = '/etc/agf-deployer/projects.json'
LOCK = '/run/agf-deployer.lock'
MAX_REQUEST = 65536
MAX_RESPONSE = 8192


def _trusted_path(path, *, executable=False):
    if not isinstance(path, str) or not os.path.isabs(path) or os.path.realpath(path) != path:
        raise ValueError('Invalid trusted path')
    node = Path(path)
    leaf = node
    while True:
        info = os.lstat(node)
        expected = stat.S_ISREG(info.st_mode) if node == leaf else stat.S_ISDIR(info.st_mode)
        if not expected or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Path is not root controlled')
        if node == leaf and executable and not info.st_mode & 0o111:
            raise ValueError('Project command is not executable')
        if node.parent == node:
            return
        node = node.parent


def load_projects(path=REGISTRY):
    _trusted_path(path)
    with open(path, 'rb') as source:
        raw = source.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise ValueError('Oversized registry')
    registry = json.loads(raw)
    if (not isinstance(registry, dict) or set(registry) != {'format', 'projects'} or registry['format'] != 1
            or not isinstance(registry['projects'], dict) or not registry['projects']):
        raise ValueError('Invalid registry')
    for key, command in registry['projects'].items():
        if not isinstance(key, str) or not key.isascii() or not key.isdecimal() or key.startswith('0'):
            raise ValueError('Invalid repository ID')
        if not isinstance(command, str) or not command:
            raise ValueError('Invalid project command')
    return registry['projects']


def _lock(path=LOCK):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise ValueError('Invalid deployment lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def dispatch(envelope, projects, *, run=subprocess.run, lock_path=LOCK):
    if not isinstance(envelope, dict) or set(envelope) != {'action', 'request'} or envelope['action'] not in ('deploy', 'status', 'retry-status'):
        raise ValueError('Invalid request')
    request = json.loads(_request(envelope['request']))
    command = projects.get(str(request['repository_id']))
    if not command:
        raise ValueError('Project is not registered')
    _trusted_path(command, executable=True)
    payload = json.dumps({'action': envelope['action'], 'request': request}, separators=(',', ':')).encode()
    guard = _lock(lock_path) if envelope['action'] == 'deploy' else None
    try:
        result = run([command], input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                     check=True, timeout=1200 if guard is not None else 15,
                     env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})
        if len(result.stdout) > MAX_RESPONSE:
            raise ValueError('Oversized project response')
        response = json.loads(result.stdout)
        if envelope['action'] == 'retry-status':
            validate_unstarted_proof(request, response)
        else:
            _result(request, response)
        return response
    finally:
        if guard is not None:
            os.close(guard)


def serve(input_stream, output_stream, *, registry_path=REGISTRY, lock_path=LOCK):
    try:
        line = input_stream.readline(MAX_REQUEST + 1)
        if not line.endswith(b'\n') or len(line) > MAX_REQUEST:
            raise ValueError('Invalid framing')
        response = dispatch(json.loads(line), load_projects(registry_path), lock_path=lock_path)
        encoded = json.dumps({'ok': True, 'response': response}, separators=(',', ':')).encode() + b'\n'
        if len(encoded) > MAX_RESPONSE:
            raise ValueError('Oversized response')
    except Exception:
        encoded = b'{"ok":false}\n'
    output_stream.write(encoded)
    output_stream.flush()


if __name__ == '__main__':
    serve(sys.stdin.buffer, sys.stdout.buffer)
