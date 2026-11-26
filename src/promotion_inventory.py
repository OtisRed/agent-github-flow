"""Read the promotion queue from GitHub without changing repository state."""
import re
from urllib.parse import urlencode

from promotion_plan import SHA, closed_prefix, issue_reference
from deployment_source import approved_scope, pull_request_merge_oid


MAX_COMMITS = 500
SYNC_REF = re.compile(r"sync-main/([0-9a-f]{40})")


def _tree_id(entry):
    meta = entry.get('commit') if isinstance(entry, dict) else None
    tree = meta.get('tree') if isinstance(meta, dict) else None
    value = tree.get('sha') if isinstance(tree, dict) else None
    return value if isinstance(value, str) and SHA.fullmatch(value) else None


def _parents(entry):
    parents = entry.get('parents')
    if not isinstance(parents, list):
        return []
    return [parent.get('sha') if isinstance(parent, dict) else None for parent in parents]


def _technical_sync(sha, pr, ahead, commit_at):
    head = pr.get('head') or {}
    ref = head.get('ref')
    if not isinstance(ref, str) or not ref.startswith('sync-main/'):
        return False

    match = SYNC_REF.fullmatch(ref)
    commit = commit_at(sha)
    parents = _parents(commit)
    if not match or len(parents) != 2:
        raise ValueError('Invalid forward sync')
    first, second = parents
    main = match[1]
    tree = _tree_id(commit)
    if (not isinstance(second, str) or not SHA.fullmatch(second) or main in ahead
            or tree is None or tree != _tree_id(commit_at(first))):
        raise ValueError('Unverified forward sync')
    # A parent reachable from smoke and absent from the complete comparison
    # is already reachable from main. Allow either a direct merge or the
    # extra GitHub merge commit around the same two-parent sync.
    if head.get('sha') == sha and second == main:
        return True
    if head.get('sha') == second and second in ahead:
        inner = commit_at(second)
        if _parents(inner) == [first, main] and _tree_id(inner) == tree:
            return True
    raise ValueError('Unverified forward sync parents')


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
    commits = {}
    def commit_at(sha):
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise ValueError('Invalid commit identity')
        if sha not in commits:
            entry = read('/commits/' + sha)
            if not isinstance(entry, dict) or entry.get('sha') != sha:
                raise ValueError('Invalid commit identity')
            commits[sha] = entry
        return commits[sha]

    chain, cursor = [], smoke
    while cursor in ahead:
        if len(chain) >= MAX_COMMITS or cursor in chain:
            raise ValueError('Incomplete first-parent history')
        commit = commit_at(cursor)
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
            if pull_request_merge_oid(transport, token, owner, repository, number) == sha:
                matching.append(pr)
        if len(matching) != 1:
            raise ValueError('Ambiguous pull request mapping')
        pr = matching[0]
        if _technical_sync(sha, pr, ahead, commit_at):
            continue
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
    requires_main_parent = False
    if result.get('kind') == 'ready' and result['sha'] != main:
        candidate = read(f"/compare/{main}...{result['sha']}?per_page=1")
        if (not isinstance(candidate, dict) or not isinstance(candidate.get('merge_base_commit'), dict)
                or not isinstance(candidate['merge_base_commit'].get('sha'), str)
                or not SHA.fullmatch(candidate['merge_base_commit']['sha'])):
            raise ValueError('Invalid candidate comparison')
        if candidate['merge_base_commit']['sha'] != main:
            # A prior promotion can add only a merge commit to main. Permit
            # that history difference only when both complete trees match.
            base_commit = candidate.get('base_commit')
            main_tree = _tree_id(base_commit)
            common_tree = _tree_id(candidate['merge_base_commit'])
            if (not isinstance(base_commit, dict) or base_commit.get('sha') != main
                    or main_tree is None or main_tree != common_tree):
                result = {'kind': 'blocked', 'reason': 'candidate-missing-main'}
            else:
                requires_main_parent = True
    if result.get('kind') == 'waiting' and entries:
        print('FLOW promotion: queue waits for ' + owner + '/' + repository + '#' + str(entries[0]['issue']), flush=True)
    scope = approved_scope(entries, result) if result.get('kind') == 'ready' else None
    return {'main': main, 'smoke': smoke, 'base': base, 'plan': result, 'accepted_scope': scope,
            'requires_main_parent': requires_main_parent}
