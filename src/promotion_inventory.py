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
    # Compare returns all commits reachable from smoke but not main. Its
    # merge base need not lie on smoke's first-parent history after a forward
    # merge, so use the complete difference to find the actual queue boundary.
    ahead, base, expected, page = set(), None, None, 1
    while True:
        compare = read(f'/compare/{main}...{smoke}?per_page=100&page={page}')
        if not isinstance(compare, dict):
            raise ValueError('Invalid comparison')
        current_base = (compare.get('merge_base_commit') or {}).get('sha')
        count, total, commits = compare.get('ahead_by'), compare.get('total_commits'), compare.get('commits')
        if (not isinstance(current_base, str) or not SHA.fullmatch(current_base)
                or type(count) is not int or count < 0 or count > MAX_COMMITS
                or type(total) is not int or total != count or not isinstance(commits, list)):
            raise ValueError('Invalid comparison')
        if expected is None:
            base, expected = current_base, count
        if current_base != base or count != expected or len(commits) != min(100, expected - len(ahead)):
            raise ValueError('Incomplete comparison')
        for item in commits:
            sha = item.get('sha') if isinstance(item, dict) else None
            if not isinstance(sha, str) or not SHA.fullmatch(sha) or sha in ahead:
                raise ValueError('Invalid comparison commit')
            ahead.add(sha)
        if len(ahead) == expected:
            break
        page += 1
    if expected and smoke not in ahead:
        raise ValueError('Incomplete comparison')
    chain, cursor = [], smoke
    while cursor in ahead:
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
    if result.get('kind') == 'ready' and result['sha'] != main:
        candidate = read(f"/compare/{main}...{result['sha']}?per_page=1")
        if (not isinstance(candidate, dict) or not isinstance(candidate.get('merge_base_commit'), dict)
                or not isinstance(candidate['merge_base_commit'].get('sha'), str)
                or not SHA.fullmatch(candidate['merge_base_commit']['sha'])):
            raise ValueError('Invalid candidate comparison')
        if candidate['merge_base_commit']['sha'] != main:
            # A prior promotion can add only a merge commit to main. Permit
            # that history difference only when both complete trees match.
            def tree_id(entry):
                if not isinstance(entry, dict):
                    return None
                commit = entry.get('commit')
                tree = commit.get('tree') if isinstance(commit, dict) else None
                value = tree.get('sha') if isinstance(tree, dict) else None
                return value if isinstance(value, str) and SHA.fullmatch(value) else None

            base_commit = candidate.get('base_commit')
            main_tree = tree_id(base_commit)
            common_tree = tree_id(candidate['merge_base_commit'])
            if (not isinstance(base_commit, dict) or base_commit.get('sha') != main
                    or main_tree is None or main_tree != common_tree):
                result = {'kind': 'blocked', 'reason': 'candidate-missing-main'}
    return {'main': main, 'smoke': smoke, 'base': base, 'plan': result}
