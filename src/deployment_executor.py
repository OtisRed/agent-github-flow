"""Fixed local project adapter for the generic deployment worker.

The command comes from trusted operator configuration, never webhook content.
This module does not grant privileges or install an executor on the host.
"""
import json
import os
import subprocess

from deployment_state import _request


class ProjectExecutor:
    def __init__(self, command, *, timeout=120):
        if (not isinstance(command, tuple) or not command or any(not isinstance(x, str) or not x for x in command)
                or not os.path.isabs(command[0]) or type(timeout) is not int or not 1 <= timeout <= 3600):
            raise ValueError('Invalid fixed executor configuration')
        self.command = command
        self.timeout = timeout

    def _call(self, action, request):
        normalized = json.loads(_request(request))
        payload = json.dumps({'action': action, 'request': normalized}, separators=(',', ':')).encode('utf-8')
        result = subprocess.run(self.command, input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=min(self.timeout, 15) if action in ('status', 'retry-status') else self.timeout,
                                check=True, env={'PATH': os.defpath})
        if len(result.stdout) > 8192:
            raise ValueError('Oversized executor response')
        response = json.loads(result.stdout.decode('utf-8'))
        if not isinstance(response, dict):
            raise ValueError('Invalid executor response')
        return response

    def __call__(self, request):
        return self._call('deploy', request)

    def status(self, request):
        return self._call('status', request)

    def retry_status(self, request):
        return self._call('retry-status', request)
