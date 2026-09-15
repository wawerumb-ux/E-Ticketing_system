"""Tests for the public shortcut features — those that don't require the
cloudflared binary (it is optional and may be absent): the URL regex, the
banner's graceful no-tunnel path, and start_tunnel() returning None when
cloudflared is missing."""
import unittest
from unittest import mock

from base import BaseTestCase  # noqa: E402  (inserts backend dir on sys.path)
import app as app_module
from app import _TUNNEL_URL_RE, _print_startup_banner, start_tunnel


class TunnelTests(BaseTestCase):

    def setUp(self):
        super().setUp()
        app_module._tunnel_url = None
        app_module._tunnel_started = False
        app_module._tunnel_process = None

    def test_tunnel_regex(self):
        self.assertIsNotNone(
            _TUNNEL_URL_RE.search('https://foo-bar-baz.trycloudflare.com')
        )
        self.assertIsNone(_TUNNEL_URL_RE.search('https://example.com'))

    def test_banner_does_not_crash_without_tunnel(self):
        with self.assertLogs('ict_ticketing', level='INFO') as logs:
            _print_startup_banner(5000)
        joined = '\n'.join(logs.output)
        self.assertIn('tunnel unavailable — cloudflared not found', joined)

    def test_start_tunnel_returns_none_when_cloudflared_missing(self):
        with mock.patch('app.shutil.which', return_value=None), \
                self.assertLogs('ict_ticketing', level='WARNING') as logs:
            result = start_tunnel(5000)
        self.assertIsNone(result)
        self.assertTrue(
            any('cloudflared not found' in line for line in logs.output)
        )


if __name__ == '__main__':
    unittest.main()