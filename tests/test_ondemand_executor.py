"""Synthetic, socket-protocol tests; never use production registry or Docker."""
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
if os.name == 'posix':
    import ondemand_executor as worker


@unittest.skipUnless(os.name == 'posix' and getattr(os, 'geteuid', lambda: -1)() == 0, 'requires isolated Linux root')
class OnDemandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='agf-ondemand-', dir='/root')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.command = self.root / 'driver'
        self.command.write_text('''#!/usr/bin/python3
import json,sys
e=json.load(sys.stdin);r=e['request']
out = {'request':r,'status':'not-started'} if e['action']=='retry-status' else {
    'id':r['id'],'target':r['target'],'commit':r['commit'],'observed_commit':r['commit'],'status':'succeeded'}
print(json.dumps(out))
''')
        self.command.chmod(0o755)
        self.registry = self.root / 'projects.json'
        self.registry.write_text(json.dumps({'format': 1, 'projects': {'42': str(self.command)}}))
        self.registry.chmod(0o600)
        self.lock = str(self.root / 'lock')
        self.request = {'id': 'main-test', 'repository_id': 42, 'target': 'main', 'commit': 'a' * 40, 'changes': ['issue-1']}

    def serve(self, envelope):
        reply = io.BytesIO()
        worker.serve(io.BytesIO(json.dumps(envelope).encode() + b'\n'), reply, registry_path=str(self.registry), lock_path=self.lock)
        return json.loads(reply.getvalue())

    def test_one_valid_request_reaches_registered_executable(self):
        response = self.serve({'action': 'deploy', 'request': self.request})
        self.assertTrue(response['ok'])
        self.assertEqual(response['response']['observed_commit'], self.request['commit'])

    def test_unknown_project_extra_fields_or_untrusted_registry_fail_closed(self):
        self.assertFalse(self.serve({'action': 'deploy', 'request': {**self.request, 'repository_id': 43}})['ok'])
        self.assertFalse(self.serve({'action': 'deploy', 'request': {**self.request, 'command': '/bin/sh'}})['ok'])
        self.registry.chmod(0o666)
        self.assertFalse(self.serve({'action': 'deploy', 'request': self.request})['ok'])

    def test_deploy_lock_serializes_projects_but_status_is_readable(self):
        guard = ORIGINAL_LOCK(self.lock)
        try:
            with self.assertRaises(BlockingIOError):
                worker.dispatch({'action': 'deploy', 'request': self.request}, {'42': str(self.command)}, lock_path=self.lock)
            response = worker.dispatch({'action': 'status', 'request': self.request}, {'42': str(self.command)}, lock_path=self.lock)
            self.assertEqual(response['status'], 'succeeded')
        finally:
            os.close(guard)

    def test_forged_project_response_is_not_forwarded(self):
        self.command.write_text('#!/usr/bin/python3\nprint("{}")\n')
        self.assertFalse(self.serve({'action': 'status', 'request': self.request})['ok'])

    def test_retry_status_accepts_only_proof_for_exact_request(self):
        envelope = {'action': 'retry-status', 'request': self.request}
        self.assertEqual(self.serve(envelope), {
            'ok': True, 'response': {'request': self.request, 'status': 'not-started'}})
        forged = {'request': {**self.request, 'changes': []}, 'status': 'not-started'}
        self.command.write_text(f'#!/usr/bin/python3\nimport json\nprint(json.dumps({forged!r}))\n')
        self.assertFalse(self.serve(envelope)['ok'])

    def test_two_connections_start_and_exit_as_independent_processes(self):
        pids = []
        code = ('import sys;from ondemand_executor import serve;'
                'serve(sys.stdin.buffer,sys.stdout.buffer,registry_path=sys.argv[1],lock_path=sys.argv[2])')
        for action in ('deploy', 'status'):
            client, inherited = socket.socketpair()
            env = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')}
            process = subprocess.Popen([sys.executable, '-c', code, str(self.registry), self.lock],
                                       stdin=inherited, stdout=inherited, stderr=subprocess.PIPE, env=env)
            pids.append(process.pid)
            inherited.close()
            try:
                client.settimeout(10)
                client.sendall(json.dumps({'action': action, 'request': self.request}).encode() + b'\n')
                data = b''
                while not data.endswith(b'\n'):
                    part = client.recv(8192)
                    if not part:
                        break
                    data += part
                self.assertTrue(json.loads(data)['ok'])
            finally:
                client.close()
            status = process.wait(timeout=10)
            errors = process.stderr.read().decode()
            process.stderr.close()
            self.assertEqual(status, 0, errors)
        self.assertNotEqual(pids[0], pids[1])


if os.name == 'posix':
    ORIGINAL_LOCK = worker._lock


if __name__ == '__main__':
    unittest.main()
