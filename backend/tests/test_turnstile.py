"""Cloudflare Turnstile anti-automation tests: token rejection, acceptance,
dev-mode skip, and route integration.

No live network calls to Cloudflare are made. All tests either mock
verify_turnstile at the route-import level, or exercise the real function
in dev mode (secret empty → skip)."""

import os
from unittest.mock import patch

from tests.base import BaseTestCase


# ---------------------------------------------------------------------------
#  Route integration tests — mock verify_turnstile at the route-import level
# ---------------------------------------------------------------------------

@patch('routes.auth.verify_turnstile', return_value=False)
class TurnstileRejectTestCase(BaseTestCase):

    def test_login_rejects_missing_turnstile_token(self, _mock):
        """POST /api/auth/login without turnstile_token → 403."""
        r = self.client.post('/api/auth/login', json={
            'username': 'admin', 'password': 'admin123',
        })
        self.assertEqual(r.status_code, 403)
        body = r.get_json()
        self.assertEqual(body['error'], 'turnstile_failed')
        self.assertNotIn('token', body['message'].lower())

    def test_login_rejects_invalid_turnstile_token(self, _mock):
        """POST /api/auth/login with garbage token → 403."""
        r = self.client.post('/api/auth/login', json={
            'username': 'admin', 'password': 'admin123',
            'turnstile_token': 'not-a-real-token',
        })
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.get_json()['error'], 'turnstile_failed')

    def test_reset_rejects_missing_turnstile_token(self, _mock):
        """POST /api/auth/reset-password without turnstile_token → 403."""
        r = self.client.post('/api/auth/reset-password', json={
            'token': 'some-token', 'password': 'newpassword123',
        })
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.get_json()['error'], 'turnstile_failed')


@patch('routes.auth.verify_turnstile', return_value=True)
class TurnstileAcceptTestCase(BaseTestCase):

    def test_login_accepts_valid_turnstile_token(self, _mock):
        """With verify_turnstile returning True, login proceeds normally."""
        r = self.client.post('/api/auth/login', json={
            'username': 'admin', 'password': 'admin123',
            'turnstile_token': 'valid-token',
        })
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertIn('access_token', data)
        self.assertIn('refresh_token', data)


# ---------------------------------------------------------------------------
#  Dev-mode skip — real verify_turnstile, no env vars set, no mock
# ---------------------------------------------------------------------------

class TurnstileDevSkipTestCase(BaseTestCase):

    def test_turnstile_disabled_in_dev_mode(self):
        """When CF_TURNSTILE_SECRET_KEY is empty and CF_TURNSTILE_ENABLED is
        not set, verification is skipped and login proceeds without a token."""
        os.environ.pop('CF_TURNSTILE_SECRET_KEY', None)
        os.environ.pop('CF_TURNSTILE_ENABLED', None)
        r = self.client.post('/api/auth/login', json={
            'username': 'admin', 'password': 'admin123',
        })
        self.assertEqual(r.status_code, 200)
        self.assertIn('access_token', r.get_json())
