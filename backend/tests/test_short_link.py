"""Tests for the shortened URL feature: the root serves the landing page
directly (200, no redirect), /login serves the auth page, the startup banner
prints localhost + LAN short link honestly, and the /share page still renders
a QR code."""
import os
import re
import unittest

from base import BaseTestCase  # noqa: E402  (inserts backend dir on sys.path)
from app import _print_startup_banner


class ShortLinkTests(BaseTestCase):

    def setUp(self):
        super().setUp()
        # make_test_app() builds the app with root_path=backend/tests, which
        # breaks the static / route (send_from_directory('../frontend', ...)).
        # Point the test app at the backend dir so '../frontend' resolves.
        self.app.root_path = os.path.join(os.path.dirname(__file__), '..')

    def test_root_serves_landing(self):
        r = self.client.get('/')
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'ICT Support Portal', r.data)

    def test_login_serves_login_page(self):
        r = self.client.get('/login')
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'ICT E-Ticketing System - Login', r.data)

    def test_root_serves_landing_directly_not_redirect(self):
        """The root short link resolves to landing.html with 200, not a 302."""
        r = self.client.get('/')
        self.assertEqual(r.status_code, 200)
        self.assertLess(r.status_code, 300)

    def test_banner_prints_localhost(self):
        with self.assertLogs('ict_ticketing', level='INFO') as logs:
            _print_startup_banner(5000)
        joined = '\n'.join(logs.output)
        self.assertIn('http://localhost:5000/', joined)

    def test_banner_prints_lan_ip_or_note(self):
        with self.assertLogs('ict_ticketing', level='INFO') as logs:
            _print_startup_banner(5000)
        joined = '\n'.join(logs.output)
        has_short_link = bool(
            re.search(r'Short link.*http://[^\s:]+:\d+/', joined)
        )
        has_no_ip_note = 'no LAN IP detected' in joined
        self.assertTrue(
            has_short_link or has_no_ip_note,
            'banner should print either the LAN short link or the no-IP note',
        )

    def test_share_page_has_qr_svg(self):
        r = self.client.get('/share')
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'<svg', r.data)


if __name__ == '__main__':
    unittest.main()