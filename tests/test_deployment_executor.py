import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from deployment_executor import ProjectExecutor


class ProjectExecutorTests(unittest.TestCase):
    def test_fixed_process_roundtrip(self):
        script = ('import json,sys; r=json.load(sys.stdin)["request"]; '
                  'print(json.dumps({"id":r["id"],"target":r["target"],"commit":r["commit"],"status":"succeeded"}))')
        executor = ProjectExecutor((sys.executable, '-c', script))
        request = {'id': 'one', 'repository_id': 1, 'target': 'smoke', 'commit': 'a'*40, 'changes': []}
        self.assertEqual(executor(request)['commit'], request['commit'])

    def test_rejects_relative_command_and_bad_request(self):
        with self.assertRaises(ValueError):
            ProjectExecutor(('relative',))
        with self.assertRaises(ValueError):
            ProjectExecutor((sys.executable,))({'id': 'only'})
