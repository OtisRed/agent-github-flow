"""Read GitHub branch and check-run evidence for a deployment attempt."""
from urllib.parse import urlencode

from promotion_plan import SHA
from pr_admission_checks import tests_state

MAX_PAGES = 10
MERGE_COMMIT_QUERY = '''query($owner:String!,$repo:String!,$number:Int!){
 repository(owner:$owner,name:$repo){pullRequest(number:$number){number merged mergeCommit{oid}}}}'''


def pull_request_merge_oid(transport, token, owner, repository, number):
    """Read the exact merge OID, which GitHub REST may omit for App tokens."""
    if type(number) is not int or number <= 0:
        raise ValueError('Invalid pull request identity')
    result, _ = transport('/graphql', token, body={
        'query': MERGE_COMMIT_QUERY,
        'variables': {'owner': owner, 'repo': repository, 'number': number},
    })
    try:
        detail = result['data']['repository']['pullRequest']
        if result.get('errors') or detail['number'] != number or detail['merged'] is not True:
            raise ValueError('Invalid pull request detail')
        oid = detail['mergeCommit']['oid']
        if not isinstance(oid, str) or not SHA.fullmatch(oid):
            raise ValueError('Invalid merge commit')
    except (KeyError, TypeError):
        raise ValueError('Invalid pull request detail') from None
    return oid


def deployment_checks(project, target):
    """Resolve required checks for the selected branch, including legacy lists."""
    checks = project.get('deployment_checks')
    if isinstance(checks, dict):
        checks = checks.get(target)
    if (not isinstance(checks, list) or not checks
            or any(not isinstance(item, dict) or set(item) != {'context', 'app_id'}
                   or not isinstance(item['context'], str) or not item['context']
                   or type(item['app_id']) is not int or item['app_id'] <= 0 for item in checks)):
        raise ValueError('Invalid deployment checks')
    required = tuple((item['context'], item['app_id']) for item in checks)
    if len(set(required)) != len(required):
        raise ValueError('Duplicate deployment checks')
    return required


def branch_head(transport, token, owner, repository, target):
    if target not in ('smoke', 'main'):
        raise ValueError('Invalid deployment target')
    value, _ = transport(f'/repos/{owner}/{repository}/branches/{target}', token)
    try:
        head = value['commit']['sha']
    except (KeyError, TypeError):
        raise ValueError('Invalid branch response') from None
    if not isinstance(head, str) or not SHA.fullmatch(head):
        raise ValueError('Invalid branch head')
    return head


def verify_head_and_ci(transport, token, owner, repository, target, commit, required):
    """Return False for stale or unready; raise on incomplete evidence."""
    if not isinstance(commit, str) or not SHA.fullmatch(commit):
        raise ValueError('Invalid deployment commit')
    if (not isinstance(required, tuple) or not required
            or any(not isinstance(item, tuple) or len(item) != 2 or not isinstance(item[0], str)
                   or not item[0] or type(item[1]) is not int or item[1] <= 0 for item in required)
            or len(set(required)) != len(required)):
        raise ValueError('Invalid required checks')
    if branch_head(transport, token, owner, repository, target) != commit:
        return False
    root = f'/repos/{owner}/{repository}'
    runs, expected = [], None
    for page in range(1, MAX_PAGES + 1):
        value, _ = transport(root + f'/commits/{commit}/check-runs?' + urlencode({'per_page': 100, 'page': page}), token)
        if (not isinstance(value, dict) or type(value.get('total_count')) is not int or value['total_count'] < 0
                or not isinstance(value.get('check_runs'), list) or len(value['check_runs']) > 100):
            raise ValueError('Invalid check-run listing')
        if expected is None:
            expected = value['total_count']
        if value['total_count'] != expected:
            raise ValueError('Changing check-run listing')
        runs.extend(value['check_runs'])
        if len(runs) >= expected:
            if len(runs) != expected:
                raise ValueError('Inconsistent check-run listing')
            break
        if len(value['check_runs']) < 100:
            raise ValueError('Incomplete check-run listing')
    else:
        raise ValueError('Check-run page limit')
    ids = [run.get('id') if isinstance(run, dict) else None for run in runs]
    if any(type(value) is not int or value <= 0 for value in ids) or len(set(ids)) != len(ids):
        raise ValueError('Duplicate or invalid check runs')
    if tests_state(runs, commit, required) != 'success':
        return False
    # The check listing can race a branch push; check the branch again.
    return branch_head(transport, token, owner, repository, target) == commit


def approved_scope(entries, plan):
    """Map an already verified closed prefix to stable issue identifiers."""
    if (not isinstance(entries, list) or not isinstance(plan, dict) or plan.get('kind') != 'ready'
            or type(plan.get('count')) is not int or not 0 < plan['count'] <= len(entries)):
        raise ValueError('No approved promotion prefix')
    accepted = entries[:plan['count']]
    if not isinstance(accepted[-1], dict) or accepted[-1].get('sha') != plan.get('sha'):
        raise ValueError('Promotion prefix does not match candidate')
    ids, commits = [], []
    for item in accepted:
        if (not isinstance(item, dict) or type(item.get('issue')) is not int or item['issue'] <= 0
                or not isinstance(item.get('sha'), str) or not SHA.fullmatch(item['sha'])
                or item['sha'] in commits):
            raise ValueError('Invalid approved entry')
        commits.append(item['sha'])
        key = f"issue-{item['issue']}"
        if key not in ids:
            ids.append(key)
    return {'changes': ids, 'commits': commits}


def strict_promotion_branch(base, source):
    return f'agf-promotion/strict-{base}-{source}'


def strict_candidate_matches(commit, sha, base, source, tree):
    return (isinstance(commit, dict) and commit.get('sha') == sha
            and isinstance(commit.get('tree'), dict) and commit['tree'].get('sha') == tree
            and isinstance(commit.get('parents'), list)
            and [p.get('sha') if isinstance(p, dict) else None for p in commit['parents']] == [base, source])


def promoted_scope(transport, token, owner, repository, repository_id, commit, store):
    """Confirm main is exactly the merge recorded before the promotion."""
    if type(repository_id) is not int or repository_id <= 0 or not isinstance(commit, str) or not SHA.fullmatch(commit):
        raise ValueError('Invalid deployment identity')
    root = f'/repos/{owner}/{repository}'
    repo, _ = transport(root, token)
    if not isinstance(repo, dict) or repo.get('id') != repository_id:
        raise ValueError('Repository identity changed')
    value, _ = transport(root + '/commits/' + commit, token)
    if not isinstance(value, dict) or value.get('sha') != commit or not isinstance(value.get('parents'), list) or len(value['parents']) != 2:
        raise ValueError('Main is not a confirmed promotion merge')
    parents = [parent.get('sha') if isinstance(parent, dict) else None for parent in value['parents']]
    if any(not isinstance(sha, str) or not SHA.fullmatch(sha) for sha in parents):
        raise ValueError('Invalid promotion parents')
    receipt = store.promotion_receipt(repository_id, parents[1])
    if receipt.get('base') != parents[0] or receipt.get('candidate') != parents[1]:
        raise ValueError('Promotion receipt does not match merge')
    number = receipt.get('pr_number')
    if type(number) is not int or number <= 0:
        raise ValueError('Invalid promotion pull request')
    pr, _ = transport(root + '/pulls/' + str(number), token)
    base = pr.get('base') if isinstance(pr, dict) else None
    head = pr.get('head') if isinstance(pr, dict) else None
    base_repo = base.get('repo') if isinstance(base, dict) else None
    head_repo = head.get('repo') if isinstance(head, dict) else None
    if (not isinstance(pr, dict) or pr.get('number') != number or pr.get('merged') is not True
            or not isinstance(base, dict) or base.get('ref') != 'main'
            or not isinstance(base_repo, dict) or base_repo.get('id') != repository_id
            or not isinstance(head, dict) or head.get('sha') != parents[1]
            or not isinstance(head_repo, dict) or head_repo.get('id') != repository_id
            or pull_request_merge_oid(transport, token, owner, repository, number) != commit):
        raise ValueError('Promotion pull request does not match merge')
    scope = receipt.get('scope')
    if (not isinstance(scope, dict) or set(scope) != {'changes', 'commits'}
            or not isinstance(scope['changes'], list) or not scope['changes']
            or any(not isinstance(x, str) or not x.startswith('issue-') or not x[6:].isdigit() or int(x[6:]) <= 0 for x in scope['changes'])
            or len(set(scope['changes'])) != len(scope['changes'])
            or not isinstance(scope['commits'], list) or not scope['commits']
            or any(not isinstance(x, str) or not SHA.fullmatch(x) for x in scope['commits'])
            or len(set(scope['commits'])) != len(scope['commits'])):
        raise ValueError('Invalid promotion scope')
    source = scope['commits'][-1]
    if source == parents[1]:
        if head.get('ref') != 'agf-promotion/' + source:
            raise ValueError('Promotion branch does not match source')
    else:
        source_commit, _ = transport(root + '/git/commits/' + source, token)
        candidate, _ = transport(root + '/git/commits/' + parents[1], token)
        tree = source_commit.get('tree', {}).get('sha')
        if (source_commit.get('sha') != source or not isinstance(tree, str) or not SHA.fullmatch(tree)
                or head.get('ref') != strict_promotion_branch(parents[0], source)
                or not strict_candidate_matches(candidate, parents[1], parents[0], source, tree)
                or value.get('commit', {}).get('tree', {}).get('sha') != tree):
            raise ValueError('Strict promotion candidate does not match source')
    return scope
