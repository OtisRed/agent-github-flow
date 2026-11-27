"""Recheck an in-flight deployment against AGF's GitHub evidence.

The project calls this as the existing controller identity. The helper returns
only a boolean, never an installation token or executable migration payload.
"""
import json
import sys

from deployment_source import deployment_checks, deployment_targets, promoted_scope, verify_head_and_ci
from deployment_state import DeploymentState, _request
from mvp_credentials import AppToken, read_private_file
from mvp_github import request as github_request


def attest(config, candidate, token, store, transport=github_request, *, recovery=False):
    if type(recovery) is not bool:
        raise ValueError('Invalid attestation purpose')
    normalized = json.loads(_request(candidate))
    matches = [project for project in config['projects']
               if project.get('repository_id') == normalized['repository_id']
               and project.get('deployment_enabled') is True]
    if len(matches) != 1:
        return False
    project = matches[0]
    if normalized['target'] not in deployment_targets(project):
        return False
    attempt = store.get_attempt(normalized)
    allowed = ('running', 'unknown') if recovery else ('running',)
    if not attempt or attempt['request'] != normalized or attempt['status'] not in allowed:
        return False
    required = deployment_checks(project, normalized['target'])
    if not verify_head_and_ci(transport, token, project['owner'], project['repository'],
                              normalized['target'], normalized['commit'], required):
        return False
    if normalized['target'] == 'smoke':
        return normalized['changes'] == []
    state_path = config['state_path'] if project.get('deployment_promotion_source') == 'selective' else None
    scope = promoted_scope(transport, token, project['owner'], project['repository'],
                           normalized['repository_id'], normalized['commit'], store,
                           selective_state_path=state_path)
    return scope['changes'] == normalized['changes']


def main():
    from mvp_service import validate_config
    if len(sys.argv) != 2:
        raise ValueError('Missing controller configuration')
    with open(sys.argv[1], encoding='utf8') as source:
        config = validate_config(json.load(source))
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('Oversized request')
    candidate = json.loads(raw)
    recovery = False
    if isinstance(candidate, dict) and set(candidate) == {'purpose', 'request'}:
        if candidate['purpose'] != 'recovery':
            raise ValueError('Invalid attestation purpose')
        recovery = True
        candidate = candidate['request']
    normalized = json.loads(_request(candidate))
    token = AppToken(config['app_id'], config['installation_id'], normalized['repository_id'],
                     read_private_file(config['app_key_path']), purpose='deployment')
    ok = attest(config, normalized, token(), DeploymentState(config['deployment_state_path']), recovery=recovery)
    print(json.dumps({'confirmed': ok}, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Do not leak credentials, response bodies or path details.
        sys.exit(1)
