"""One conservative promotion step; GitHub remains the source of truth."""
from urllib.parse import urlencode

from deployment_source import strict_candidate_matches, strict_promotion_branch
from promotion_inventory import inventory
from promotion_plan import SHA


CREATE_REF = '''mutation($repo:ID!,$name:String!,$oid:GitObjectID!){
 createRef(input:{repositoryId:$repo,name:$name,oid:$oid}){ref{id}}}'''
CREATE_PR = '''mutation($repo:ID!,$head:String!){
 createPullRequest(input:{repositoryId:$repo,baseRefName:"main",headRefName:$head,
 title:"Promote completed changes",body:"Automated promotion of the closed prefix."}){pullRequest{id}}}'''
MERGE_PR = '''mutation($id:ID!,$sha:GitObjectID!){
 mergePullRequest(input:{pullRequestId:$id,mergeMethod:MERGE,expectedHeadOid:$sha}){pullRequest{merged}}}'''


def protection_ready(protection):
    """Require GitHub to enforce named checks for administrators."""
    if not isinstance(protection, dict):
        return False
    checks = protection.get('required_status_checks')
    if not isinstance(checks, dict) or type(checks.get('strict')) is not bool:
        return False
    contexts = checks.get('contexts')
    modern = checks.get('checks')
    configured = (isinstance(contexts, list) and any(isinstance(x, str) and x for x in contexts)
                  or isinstance(modern, list) and any(isinstance(x, dict) and x.get('context') for x in modern))
    return bool(configured and protection.get('enforce_admins', {}).get('enabled') is True)


def promotion_step(transport, token, owner, repository, *, deployment_ready=None):
    """Advance one visible promotion step and re-read uncertain ref or PR results."""
    root = f'/repos/{owner}/{repository}'
    def read(path):
        value, _ = transport(root + path, token)
        return value
    def mutation(query, variables, operation, field):
        result, _ = transport('/graphql', token, body={'query': query, 'variables': variables})
        if not isinstance(result, dict) or result.get('errors') or not isinstance(result.get('data'), dict):
            raise ValueError('Promotion mutation failed')
        item = result['data'].get(operation)
        if not isinstance(item, dict) or not isinstance(item.get(field), dict):
            raise ValueError('Unconfirmed promotion mutation')
        if operation == 'mergePullRequest' and item[field].get('merged') is not True:
            raise ValueError('Unconfirmed promotion merge')

    plan = inventory(transport, token, owner, repository)
    if plan['plan']['kind'] != 'ready':
        return plan['plan']['kind']
    if deployment_ready is not None and deployment_ready(plan['main']) is not True:
        return 'deployment-blocked'
    protection = read('/branches/main/protection')
    if not protection_ready(protection):
        return 'protection-required'
    main, source = plan['main'], plan['plan']['sha']
    wrap = protection['required_status_checks']['strict'] and plan.get('requires_main_parent') is True
    branch = strict_promotion_branch(main, source) if wrap else 'agf-promotion/' + source
    sha = source
    if wrap:
        source_commit = read('/git/commits/' + source)
        tree = source_commit.get('tree', {}).get('sha')
        if source_commit.get('sha') != source or not isinstance(tree, str) or not SHA.fullmatch(tree):
            raise ValueError('Invalid promotion source tree')
    repo = read('')
    repo_id = repo.get('node_id')
    if not isinstance(repo_id, str) or not repo_id:
        raise ValueError('Invalid repository identity')
    refs = read('/git/matching-refs/heads/' + branch)
    if not isinstance(refs, list):
        raise ValueError('Invalid branch lookup')
    exact = [ref for ref in refs if ref.get('ref') == 'refs/heads/' + branch]
    if len(exact) > 1:
        raise ValueError('Ambiguous promotion branch')
    if wrap:
        if exact:
            sha = exact[0].get('object', {}).get('sha')
            if not isinstance(sha, str) or not SHA.fullmatch(sha):
                raise ValueError('Invalid strict promotion ref')
            candidate = read('/git/commits/' + sha)
        else:
            # The object alone changes no branch. If creation or ref publication
            # times out, the next step starts with the base-specific ref lookup.
            candidate, _ = transport(root + '/git/commits', token, body={
                'message': 'Prepare closed prefix on current main',
                'tree': tree, 'parents': [main, source],
            })
            sha = candidate.get('sha') if isinstance(candidate, dict) else None
        if (not isinstance(sha, str) or not SHA.fullmatch(sha)
                or not strict_candidate_matches(candidate, sha, main, source, tree)):
            raise ValueError('Unexpected strict promotion candidate')
    if not exact:
        mutation(CREATE_REF, {'repo': repo_id, 'name': 'refs/heads/' + branch, 'oid': sha}, 'createRef', 'ref')
        return 'branch-created'
    if exact[0].get('object', {}).get('sha') != sha:
        raise ValueError('Unexpected promotion branch')
    prs = read('/pulls?' + urlencode({'state': 'open', 'base': 'main', 'head': owner + ':' + branch, 'per_page': 100}))
    if not isinstance(prs, list) or len(prs) > 1:
        raise ValueError('Ambiguous promotion pull request')
    if not prs:
        mutation(CREATE_PR, {'repo': repo_id, 'head': branch}, 'createPullRequest', 'pullRequest')
        return 'pull-request-created'
    number = prs[0].get('number')
    if type(number) is not int or number <= 0:
        raise ValueError('Invalid promotion pull request')
    pr = read('/pulls/' + str(number))
    if not isinstance(pr, dict) or pr.get('number') != number or pr.get('state') != 'open':
        raise ValueError('Invalid promotion pull request')
    if (pr.get('head', {}).get('ref') != branch or pr.get('base', {}).get('ref') != 'main'
            or pr.get('head', {}).get('repo', {}).get('node_id') != repo_id
            or pr.get('base', {}).get('repo', {}).get('node_id') != repo_id):
        raise ValueError('Unexpected promotion pull request')
    if (pr.get('draft') is not False or pr.get('head', {}).get('sha') != sha
            or pr.get('base', {}).get('sha') != plan['main'] or pr.get('mergeable_state') != 'clean'):
        return 'waiting-checks'
    pr_id = pr.get('node_id')
    if not isinstance(pr_id, str) or not pr_id:
        raise ValueError('Invalid promotion pull request')
    # Re-read issue states and both heads immediately before the guarded merge.
    if inventory(transport, token, owner, repository) != plan or read('/branches/main/protection') != protection:
        return 'changed'
    if deployment_ready is not None:
        capture = getattr(deployment_ready, 'capture', None)
        if not callable(capture):
            return 'deployment-blocked'
        if wrap:
            capture(plan, number, candidate=sha)
        else:
            capture(plan, number)
    mutation(MERGE_PR, {'id': pr_id, 'sha': sha}, 'mergePullRequest', 'pullRequest')
    return 'merged'
