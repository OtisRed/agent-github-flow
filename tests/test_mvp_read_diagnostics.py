import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from mvp_errors import GitHubRequestError, read_failure, format_read_failure
from mvp_github import request


class ReadDiagnosticsTests(unittest.TestCase):
    def test_transport_classifies_without_exception_text_or_url(self):
        cases = [
            (HTTPError('https://secret.example/token', 429, 'secret', {}, None), 'http-429'),
            (HTTPError('https://secret.example/token', 403, 'secret', {}, None), 'http-403'),
            (HTTPError('https://secret.example/token', 451, 'secret', {}, None), 'http-4xx'),
            (HTTPError('https://secret.example/token', 502, 'secret', {}, None), 'http-5xx'),
            (URLError(TimeoutError('secret-token')), 'timeout'),
            (URLError('secret-host'), 'network'),
            (TimeoutError('secret-token'), 'timeout'),
            (ValueError('secret-body'), 'invalid-data'),
        ]
        for error, expected in cases:
            with self.subTest(expected=expected), patch('mvp_github.build_opener') as build:
                build.return_value.open.side_effect = error
                with self.assertRaises(GitHubRequestError) as observed:
                    request('/test', 'synthetic-token')
                self.assertEqual(observed.exception.category, expected)
                line = format_read_failure(read_failure('snapshot', observed.exception))
                self.assertNotIn('secret', line)
                self.assertNotIn('synthetic-token', line)

    def test_similar_or_extra_exception_data_is_not_disclosed(self):
        class UntrustedValue:
            def __eq__(self, _other):
                raise RuntimeError('secret')

        for error in (ValueError('Issue changed during read: secret'),
                      ValueError('Issue changed during read', 'secret'),
                      ValueError(UntrustedValue())):
            result = read_failure('snapshot', error)
            self.assertEqual(result['cause'], 'invalid-data')
            self.assertNotIn('secret', format_read_failure(result))

    def test_formatter_rejects_untrusted_fields_and_exception_messages(self):
        result = read_failure('snapshot', ValueError('secret text'))
        self.assertEqual(format_read_failure(result), 'FLOW attention: read-failed stage=snapshot cause=invalid-data')
        result['stage'] = 'secret-stage'
        result['cause'] = 'secret-cause'
        self.assertEqual(format_read_failure(result), 'FLOW attention: read-failed stage=other cause=other')
        self.assertEqual(format_read_failure({'stage': [], 'cause': {}}),
                         'FLOW attention: read-failed stage=other cause=other')
        self.assertEqual(read_failure('pr-handoff', Exception('secret'))['cause'], 'other')


if __name__ == '__main__':
    unittest.main()
