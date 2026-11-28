import io
import json
import stat
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import agf_controller_executor as executor
import agf_pilot_executor as pilot


def request(sha, issue=328):
    return {'id': 'main-' + sha, 'repository_id': pilot.REPOSITORY, 'target': 'main',
            'commit': sha, 'changes': [f'issue-{issue}']}


def archive(name='src/mvp_service.py', kind=tarfile.REGTYPE):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as tar:
        entry = tarfile.TarInfo(name)
        entry.type = kind
        payload = b'print("ready")\n' if kind == tarfile.REGTYPE else b''
        entry.size = len(payload)
        entry.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
        tar.addfile(entry, io.BytesIO(payload))
    return out.getvalue()


class ControllerExecutorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.pin = self.root / 'pin'
        self.baseline = 'a' * 40
        handover = self.root / 'handover.json'
        self.enterContext(patch.multiple(executor, STATE=self.root, HANDOVER=handover))
        self.enterContext(patch.multiple(pilot, PIN=self.pin, RELEASES=self.root))
        self.pin.write_bytes(pilot.pin_text(self.baseline))
        self.enterContext(patch.object(pilot, '_trusted_path'))
        self.enterContext(patch.object(pilot, 'check_release'))
        self.restart = self.enterContext(patch.object(pilot, 'restart'))
        self.ready = self.enterContext(patch.object(pilot, 'ready', return_value=True))
        self.authorization = b'{"confirmed":true}'
        self.package = archive()
        self.archive_sha = None
        self.helper = self.enterContext(patch.object(executor, 'helper', side_effect=self.fetch))

    def fetch(self, name, data, *, timeout, output=None):
        if name == 'deployment_attestation.py':
            return self.authorization
        message = json.loads(data)
        self.assertEqual(message['ref'], 'main')
        sha = self.archive_sha or message['request']['commit']
        output.write((sha + '\n').encode() + self.package)

    def execute(self, sha, action='deploy', *, issue=328):
        return executor.execute(action, request(sha, issue), port=4300)

    def test_adopts_exact_existing_deployment_without_starting_or_fetching(self):
        sha = self.baseline
        with self.assertRaises(RuntimeError):
            self.execute(sha, 'status')
        executor.HANDOVER.write_text(json.dumps(request(sha)))
        with self.assertRaises(RuntimeError):
            self.execute(sha, 'status', issue=99)
        adopted = self.execute(sha, 'status')
        executor.HANDOVER.unlink()
        self.assertEqual(self.execute(sha, 'status'), adopted)
        self.assertEqual(adopted['observed_commit'], sha)
        self.restart.assert_not_called()
        self.helper.assert_not_called()

    def test_two_releases_and_readback_without_restarting_or_fetching_again(self):
        first, second = 'b' * 40, 'c' * 40
        for sha in first, second:
            with self.subTest(sha=sha):
                result = self.execute(sha)
                self.assertEqual(result['observed_commit'], sha)
                self.assertEqual(self.execute(sha, 'status'), result)
                self.assertEqual(self.execute(sha), result)
                self.assertTrue(pilot.entry(sha).is_file())
                self.assertEqual(stat.S_IMODE(pilot.entry(sha).parent.stat().st_mode), 0o755)
        self.assertEqual(self.restart.call_count, 2)
        self.assertEqual(self.helper.call_count, 4)
        self.assertEqual(json.loads((self.root / (second + '.json')).read_bytes())['baseline'], first)
        self.assertTrue((self.root / (first + '.json')).is_file())
        with self.assertRaises(ValueError):
            self.execute(second, 'status', issue=99)
        with self.assertRaises(RuntimeError):
            self.execute(first, 'status')

    def test_rollback_restores_the_most_recent_release(self):
        first, second = 'b' * 40, 'c' * 40
        self.execute(first)
        self.ready.side_effect = lambda sha, *_: sha != second
        result = self.execute(second)
        self.assertEqual((result['status'], result['observed_commit']), ('failed', first))
        self.assertEqual(executor.current_pin(), first)
        self.assertEqual(self.execute(second, 'status'), result)
        self.assertEqual(self.restart.call_count, 3)

    def test_status_recovers_success_if_interrupted_before_final_receipt(self):
        sha = 'b' * 40
        self.restart.side_effect = KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            self.execute(sha)
        with self.assertRaises(RuntimeError):
            self.execute(sha)
        result = self.execute(sha, 'status')
        self.assertEqual((result['status'], result['observed_commit']), ('succeeded', sha))
        self.restart.assert_called_once()

    def test_rollback_intent_keeps_candidate_from_being_reported_as_success(self):
        sha = 'b' * 40
        self.ready.side_effect = lambda commit, *_: commit == self.baseline
        real_write = pilot.atomic_write

        def interrupt_before_restoring_pin(path, contents):
            if path == self.pin and contents == pilot.pin_text(self.baseline):
                raise KeyboardInterrupt
            real_write(path, contents)

        with patch.object(pilot, 'atomic_write', side_effect=interrupt_before_restoring_pin):
            with self.assertRaises(KeyboardInterrupt):
                self.execute(sha)
        self.ready.side_effect = None
        with self.assertRaises(RuntimeError):
            self.execute(sha, 'status')
        self.assertEqual(executor.current_pin(), sha)
        self.restart.assert_called_once()

    def test_mismatched_archive_and_stale_attestation_do_not_publish_or_restart(self):
        self.archive_sha = '0' * 40
        first, second = 'b' * 40, 'c' * 40
        self.assertEqual(self.execute(first)['status'], 'failed')
        self.archive_sha = None
        self.authorization = b'{"confirmed":false}'
        self.assertEqual(self.execute(second)['status'], 'failed')
        self.assertEqual(executor.current_pin(), self.baseline)
        self.assertFalse(pilot.release(first).exists())
        self.assertFalse(pilot.release(second).exists())
        self.restart.assert_not_called()

    def test_link_and_traversal_are_rejected(self):
        for sha, payload in [('b' * 40, archive(kind=tarfile.SYMTYPE)),
                             ('c' * 40, archive('../outside'))]:
            self.package = payload
            self.assertEqual(self.execute(sha)['status'], 'failed')
            self.assertFalse(pilot.release(sha).exists())
        self.restart.assert_not_called()