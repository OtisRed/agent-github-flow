#!/usr/bin/env python3
"""Validate a candidate using controller code, always as the service user."""
import json
import os
from pathlib import Path
import sys

def controller_source(script):
    location = Path(script).resolve()
    root = location.parents[1]
    # Installed tools live alongside the current release symlink. A stale
    # root/src from an older deployment must not shadow the running release.
    return root / 'current/src' if location.parent.name == 'tools' else root / 'src'


def main():
    if os.geteuid() == 0:
        raise RuntimeError('service-user-required')
    sys.path.insert(0, str(controller_source(__file__)))
    from mvp_service import validate_config
    from pr_admission_github import AdmissionReader
    raw = sys.stdin.buffer.read(131073)
    if not raw or len(raw) > 131072:
        raise ValueError('invalid')
    payload = json.loads(raw)
    validate_config(payload['config'])
    entry = payload['entry']
    if entry is not None and entry['admission_enabled']:
        AdmissionReader(owner=entry['owner'], repository=entry['repository'], repository_id=entry['repository_id'],
                        token=lambda: None, transport=lambda *_: None,
                        workflow=entry.get('admission_workflow', 'ci.yml'),
                        gate_job=entry.get('admission_gate_job', 'verify'),
                        workflow_event=entry.get('admission_workflow_event', 'pull_request'),
                        sync_bot_id=entry.get('admission_sync_bot_id'),
                        required_tests=tuple((x['context'], x['app_id']) for x in entry['admission_tests']),
                        retry_targets=entry.get('admission_retry_targets'))
    print('ok')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(1)
