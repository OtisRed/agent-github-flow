"""Fetch an exact verified branch using a short-lived read-only App token."""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from deployment_attestation import attest
from deployment_source import branch_head, verify_head_and_ci
from deployment_state import DeploymentState, _request
from mvp_credentials import AppToken, read_private_file
from mvp_github import request as github_request

NAME = re.compile(r'^[A-Za-z0-9_.-]+$')
MAX_ARCHIVE = 100 * 1024 * 1024


def fetch_archive(config, candidate, ref, token, store, output, *, transport=github_request, run=subprocess.run):
    candidate = json.loads(_request(candidate))
    if ref not in ('main', 'smoke') or (ref == 'main' and candidate['target'] != 'main'):
        raise ValueError('Invalid source branch')
    projects = [p for p in config['projects'] if p.get('repository_id') == candidate['repository_id']
                and p.get('deployment_enabled') is True]
    if len(projects) != 1:
        raise ValueError('Unknown project')
    project = projects[0]
    if (not isinstance(project.get('owner'), str) or not isinstance(project.get('repository'), str)
            or not NAME.fullmatch(project['owner']) or not NAME.fullmatch(project['repository'])
            or project['owner'] in ('.', '..') or project['repository'] in ('.', '..')):
        raise ValueError('Invalid repository name')
    required = tuple((item['context'], item['app_id']) for item in project['deployment_checks'])
    if not attest(config, candidate, token, store, transport):
        raise ValueError('Unconfirmed deployment')
    commit = candidate['commit'] if ref == candidate['target'] else branch_head(transport, token, project['owner'], project['repository'], ref)
    if not verify_head_and_ci(transport, token, project['owner'], project['repository'], ref, commit, required):
        raise ValueError('Unconfirmed source')
    if not isinstance(token, str) or not token or re.search(r'[\x00-\x20\x7f]', token):
        raise ValueError('Invalid token')
    with tempfile.TemporaryDirectory(prefix='agf-deployment-source-') as temp:
        repo = str(Path(temp) / 'source.git')
        credential = base64.b64encode(('x-access-token:' + token).encode()).decode()
        env = {'PATH': '/usr/bin:/bin', 'HOME': temp, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0',
               'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader',
               'GIT_CONFIG_VALUE_0': 'Authorization: Basic ' + credential}
        def git(args, **kwargs):
            return run(['git', *args], env=env, stderr=subprocess.DEVNULL, check=True, timeout=180, **kwargs)
        git(['init', '--bare', repo], stdout=subprocess.DEVNULL)
        url = f"https://github.com/{project['owner']}/{project['repository']}.git"
        git(['--git-dir', repo, 'fetch', '--no-tags', '--depth=1', url, f'+refs/heads/{ref}:refs/heads/{ref}'], stdout=subprocess.DEVNULL)
        observed = git(['--git-dir', repo, 'rev-parse', f'refs/heads/{ref}^{{commit}}'], stdout=subprocess.PIPE).stdout.decode().strip()
        if observed != commit:
            raise ValueError('Fetched branch differs from verified commit')
        archive = Path(temp) / 'source.tar'
        with archive.open('wb') as target:
            git(['--git-dir', repo, 'archive', '--format=tar', commit], stdout=target)
        if archive.stat().st_size > MAX_ARCHIVE:
            raise ValueError('Oversized archive')
        if not attest(config, candidate, token, store, transport) or not verify_head_and_ci(transport, token, project['owner'], project['repository'], ref, commit, required):
            raise ValueError('Source changed during fetch')
        output.write((commit + '\n').encode())
        with archive.open('rb') as source:
            shutil.copyfileobj(source, output)
        output.flush()


def main():
    from mvp_service import validate_config
    if len(sys.argv) != 2:
        raise ValueError('Missing controller configuration')
    with open(sys.argv[1], encoding='utf8') as source:
        config = validate_config(json.load(source))
    body = sys.stdin.buffer.read(65537)
    if len(body) > 65536:
        raise ValueError('Oversized request')
    message = json.loads(body)
    if not isinstance(message, dict) or set(message) != {'request', 'ref'}:
        raise ValueError('Invalid request')
    candidate = json.loads(_request(message['request']))
    token = AppToken(config['app_id'], config['installation_id'], candidate['repository_id'],
                     read_private_file(config['app_key_path']), purpose='deployment')
    fetch_archive(config, candidate, message['ref'], token(), DeploymentState(config['deployment_state_path']), sys.stdout.buffer)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(1)
