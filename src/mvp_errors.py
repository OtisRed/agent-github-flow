"""Allowlisted diagnostic categories; never include exception text or IDs."""

import sys

CAUSES = frozenset({'http-401', 'http-403', 'http-404', 'http-429', 'http-4xx', 'http-5xx',
                    'http-other', 'timeout', 'network', 'invalid-data', 'issue-changed', 'other'})
STAGES = frozenset({'snapshot', 'pr-handoff', 'verify-snapshot', 'unarchive'})


class GitHubRequestError(RuntimeError):
    def __init__(self, category):
        super().__init__('GitHub request failed')
        self.category = category if isinstance(category, str) and category in CAUSES else 'other'


def read_failure(stage, error):
    if type(error) is GitHubRequestError:
        cause = error.category if isinstance(error.category, str) and error.category in CAUSES else 'other'
    elif type(error) is ValueError:
        # Only this exact, local constant is safe to distinguish; never log exception text.
        cause = ('issue-changed' if len(error.args) == 1 and type(error.args[0]) is str
                 and error.args[0] == 'Issue changed during read' else 'invalid-data')
    else:
        cause = 'other'
    return {'kind': 'read-failed', 'stage': stage if isinstance(stage, str) and stage in STAGES else 'other', 'cause': cause}


def format_read_failure(result):
    stage = result.get('stage')
    cause = result.get('cause')
    stage = stage if isinstance(stage, str) and stage in STAGES else 'other'
    cause = cause if isinstance(cause, str) and cause in CAUSES else 'other'
    if cause == 'issue-changed':
        return 'FLOW retry: issue-changed stage=' + stage
    return 'FLOW attention: read-failed stage=' + stage + ' cause=' + cause


def report_read_failure(result):
    message = format_read_failure(result)
    stream = sys.stdout if result.get('cause') == 'issue-changed' else sys.stderr
    print(message, file=stream, flush=True)
