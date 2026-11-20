"""Operator-only requeue of an exact dispatch with proof of no migration work."""
import argparse
import json

from deployment_attestation import attest
from deployment_schedule import trusted_executor
from deployment_state import DeploymentState, IDENT
from deployment_worker import validate_unstarted_proof
from mvp_credentials import AppToken, read_private_file


def requeue_unstarted(store, repository_id, attempt_id, verify, execute):
    if not isinstance(attempt_id, str) or not IDENT.fullmatch(attempt_id):
        raise ValueError('Invalid deployment identifier')
    attempt = store.unresolved(repository_id)
    if (attempt is None or attempt['request']['id'] != attempt_id
            or attempt['status'] != 'unknown' or attempt['result'] is not None):
        raise ValueError('No matching interrupted dispatch')
    request = attempt['request']
    if verify(request) is not True:
        raise ValueError('Deployment no longer matches the verified branch, CI or scope')
    validate_unstarted_proof(request, execute.retry_status(request))
    return store.requeue_unstarted(request)


def main():
    from mvp_service import validate_config

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config')
    parser.add_argument('repository_id', type=int)
    parser.add_argument('attempt_id')
    args = parser.parse_args()
    try:
        with open(args.config, encoding='utf8') as source:
            config = validate_config(json.load(source))
        projects = [project for project in config['projects']
                    if project['repository_id'] == args.repository_id and project.get('deployment_enabled') is True]
        if len(projects) != 1:
            raise ValueError('Deployment is unavailable for this repository')
        store = DeploymentState(config['deployment_state_path'])
        execute = trusted_executor(projects[0]['deployment_executor'])
        token = AppToken(config['app_id'], config['installation_id'], args.repository_id,
                         read_private_file(config['app_key_path']), purpose='deployment')
    except Exception:
        parser.exit(1, 'Unable to load the trusted deployment configuration.\n')
    try:
        result = requeue_unstarted(store, args.repository_id, args.attempt_id,
                                   lambda request: attest(config, request, token(), store, recovery=True), execute)
    except Exception:
        parser.exit(1, 'Deployment remains blocked. Verify the exact attempt, current release and executor proof.\n')
    print(json.dumps({'id': args.attempt_id, 'status': result}, separators=(',', ':')))


if __name__ == '__main__':
    main()
