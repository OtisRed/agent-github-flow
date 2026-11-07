"""Nightly promotion on the existing controller host."""
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from mvp_credentials import AppToken
from mvp_github import request
from promotion_runner import promotion_step


def run_promotions(stop, config, private_key, *, transport=request):
    """Resume night work from GitHub state; never run two attempts in parallel."""
    projects = []
    for project in config['projects']:
        if project.get('promotion_enabled') is True:
            token = AppToken(config['app_id'], config['installation_id'], project['repository_id'], private_key,
                             purpose='promotion', transport=transport)
            projects.append((project, token))
    zone = ZoneInfo('Europe/Warsaw')
    previous = {}
    while not stop.is_set():
        now = datetime.now(zone)
        if 3 <= now.hour < 5:
            for project, token in projects:
                if stop.is_set():
                    break
                try:
                    result = promotion_step(transport, token(), project['owner'], project['repository'])
                except Exception:
                    result = 'failed'
                if previous.get(project['repository_id']) != result:
                    alert = result in ('failed', 'protection-required', 'blocked')
                    print(('FLOW attention: promotion-' if alert else 'FLOW promotion: ') + result
                          + ' repo=' + str(project['repository_id']),
                          file=sys.stderr if alert else sys.stdout, flush=True)
                    previous[project['repository_id']] = result
        else:
            for repository_id, result in previous.items():
                if result in ('branch-created', 'pull-request-created', 'waiting-checks', 'changed'):
                    print('FLOW attention: promotion-incomplete repo=' + str(repository_id), file=sys.stderr, flush=True)
            previous.clear()
        stop.wait(60)
