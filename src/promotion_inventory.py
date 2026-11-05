"""Read the promotion queue from GitHub without changing repository state."""
from urllib.parse import urlencode

from promotion_plan import SHA, closed_prefix, issue_reference


MAX_COMMITS = 500
MERGE_COMMIT_QUERY = '''query($owner:String!,$repo:String!,$number:Int!){
 repository(owner:$owner,name:$repo){pullRequest(number:$number){number merged mergeCommit{oid}}}}'''


def inventory(transport, token, owner, repository):
    """Read a bounded first-parent history and map every commit to one PR.

    A commit without an unambiguous merged PR and standalone issue reference
    blocks the entire calculation. No repository content is returned or logged.
    """
    root = f"/repos/{owner}/{repository}"
    def read(path):
        value, _ = transport(root + path, token)
        return value

    main = read('/branches/main')['commit']['sha']
    smoke = read('/branches/smoke')['commit']['sha']
    if not all(isinstance(x, str) and SHA.fullmatch(x) for x in (main, smoke)):
        raise ValueError('Invalid branch head')
    compare = read(f'/compare/{main}...{smoke}?per_page=1')
    base = compare['merge_base_commit']['sha']
    if not isinstance(base, str) or not SHA.fullmatch(base):
        raise ValueError('Invalid merge base')
    chain, cursor = [], smoke
    while cursor != base:
        if len(chain) >= MAX_COMMITS or cursor in chain:
            raise ValueError('Incomplete first-parent history')
        commit = read('/commits/' + cursor)
        if commit.get('sha') != cursor or not isinstance(commit.get('parents'), list) or not commit['parents']:
            raise ValueError('Invalid commit history')
        chain.append(cursor)
        cursor = commit['parents'][0].get('sha')
        if not isinstance(cursor, str) or not SHA.fullmatch(cursor):
            raise ValueError('Invalid commit parent')
    entries, issues = [], {}
    for sha in reversed(chain):
        prs = read('/commits/' + sha + '/pulls?' + urlencode({'per_page': 100}))
        if not isinstance(prs, list):
            raise ValueError('Invalid pull request mapping')
        if len(prs) >= 100:
            raise ValueError('Ambiguous pull request mapping')
        matching = []
        for pr in prs:
            if not isinstance(pr, dict):
                raise ValueError('Invalid pull request mapping')
            if pr.get('base', {}).get('ref') != 'smoke' or not pr.get('merged_at'):
                continue
            number = pr.get('number')
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
            if oid == sha:
                matching.append(pr)
        if len(matching) != 1:
            raise ValueError('Ambiguous pull request mapping')
        pr = matching[0]
        number = issue_reference(pr.get('body'))
        if number is None:
            raise ValueError('Ambiguous issue reference')
        entries.append({'sha': sha, 'issue': number, 'merged_at': pr['merged_at']})
        if number not in issues:
            issue = read('/issues/' + str(number))
            if not isinstance(issue, dict) or issue.get('number') != number or 'pull_request' in issue:
                raise ValueError('Invalid issue')
            issues[number] = {'state': issue.get('state'), 'closed_at': issue.get('closed_at')}
    result = closed_prefix(entries, issues)
    return {'main': main, 'smoke': smoke, 'base': base, 'plan': result}
