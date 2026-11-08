"""Allowlisted diagnostic categories; never include exception text or IDs."""

CAUSES = frozenset({'http-401', 'http-403', 'http-404', 'http-429', 'http-4xx', 'http-5xx',
                    'http-other', 'timeout', 'network', 'invalid-data', 'other'})
STAGES = frozenset({'snapshot', 'pr-handoff', 'verify-snapshot'})


class GitHubRequestError(RuntimeError):
    def __init__(self, category):
        super().__init__('GitHub request failed')
        self.category = category if isinstance(category, str) and category in CAUSES else 'other'


def read_failure(stage, error):
    if type(error) is GitHubRequestError:
        cause = error.category if isinstance(error.category, str) and error.category in CAUSES else 'other'
    elif type(error) is ValueError:
        cause = 'invalid-data'
    else:
        cause = 'other'
    return {'kind': 'read-failed', 'stage': stage if isinstance(stage, str) and stage in STAGES else 'other', 'cause': cause}


def format_read_failure(result):
    stage = result.get('stage')
    cause = result.get('cause')
    stage = stage if isinstance(stage, str) and stage in STAGES else 'other'
    cause = cause if isinstance(cause, str) and cause in CAUSES else 'other'
    return 'FLOW attention: read-failed stage=' + stage + ' cause=' + cause
