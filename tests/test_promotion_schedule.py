import contextlib
import io
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from promotion_schedule import run_promotions


class StopAfterTwoWaits:
    def __init__(self):
        self.waits = 0

    def is_set(self):
        return self.waits >= 2

    def wait(self, _seconds):
        self.waits += 1


class PromotionScheduleTests(unittest.TestCase):
    def test_incomplete_night_is_reported(self):
        stop = StopAfterTwoWaits()
        config = {'app_id': 1, 'installation_id': 2, 'projects': [
            {'repository_id': 3, 'owner': 'example', 'repository': 'repo', 'promotion_enabled': True}]}
        output = io.StringIO()
        with patch('promotion_schedule.AppToken', return_value=lambda: 'synthetic-token'), \
                patch('promotion_schedule.promotion_step', return_value='waiting-checks'), \
                patch('promotion_schedule.datetime') as clock, contextlib.redirect_stderr(output):
            clock.now.side_effect = [SimpleNamespace(hour=4), SimpleNamespace(hour=5)]
            run_promotions(stop, config, b'not-a-key')
        self.assertIn('FLOW attention: promotion-incomplete repo=3', output.getvalue())

    def test_open_issue_wait_is_not_an_error(self):
        stop = StopAfterTwoWaits()
        config = {'app_id': 1, 'installation_id': 2, 'projects': [
            {'repository_id': 3, 'owner': 'example', 'repository': 'repo', 'promotion_enabled': True}]}
        output = io.StringIO()
        with patch('promotion_schedule.AppToken', return_value=lambda: 'synthetic-token'), \
                patch('promotion_schedule.promotion_step', return_value='waiting'), \
                patch('promotion_schedule.datetime') as clock, contextlib.redirect_stderr(output):
            clock.now.side_effect = [SimpleNamespace(hour=4), SimpleNamespace(hour=5)]
            run_promotions(stop, config, b'not-a-key')
        self.assertEqual(output.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
