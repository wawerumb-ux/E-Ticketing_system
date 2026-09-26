"""Authentication flow tests: login, lockout, registration, refresh,
password reset and 2FA setup/verify/disable."""

import hashlib
import os
import secrets
from datetime import timedelta
from unittest import mock

from models import PasswordResetToken, User
from tests.base import BaseTestCase
from totp import totp_now

from extensions import db, utcnow
from helpers import send_email, smtp_is_configured


class LoginTestCase(BaseTestCase):
    def test_login_success(self):
        r = self.login('admin', 'admin123')
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertIn('access_token', data)
        self.assertIn('refresh_token', data)
        self.assertEqual(data['user']['role'], 'admin')

    def test_login_missing_fields(self):
        r = self.client.post('/api/auth/login', json={})
        self.assertEqual(r.status_code, 400)

    def test_login_wrong_password(self):
        r = self.login('admin', 'wrongpassword')
        self.assertEqual(r.status_code, 401)
        self.assertIn('Invalid username', r.get_json()['error'])

    def test_unknown_username_same_error(self):
        r = self.login('ghost', 'whatever123')
        self.assertEqual(r.status_code, 401)

    def test_login_locks_after_five_failures(self):
        for _ in range(5):
            self.assertEqual(self.login('admin', 'badpass123').status_code, 401)
        locked = self.login('admin', 'badpass123').get_json()
        # Error message is now generic to prevent account enumeration
        self.assertEqual(locked['error'], 'Invalid username or password')
        self.assertEqual(User.query.filter_by(username='admin').first().failed_login_attempts, 0)


class RegisterTestCase(BaseTestCase):
    def test_register_then_login(self):
        r = self.client.post('/api/auth/register', json={
            'username': 'newuser', 'email': 'newuser@example.com', 'password': 'supersecret1'})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.get_json()['user']['role'], 'staff')
        self.assertEqual(self.login('newuser', 'supersecret1').status_code, 200)

    def test_register_duplicate_username(self):
        r = self.client.post('/api/auth/register', json={
            'username': 'admin', 'email': 'other@example.com', 'password': 'supersecret1'})
        self.assertEqual(r.status_code, 400)

    def test_register_short_password(self):
        r = self.client.post('/api/auth/register', json={
            'username': 'shorty', 'email': 'short@example.com', 'password': 'abc'})
        self.assertEqual(r.status_code, 400)


class RefreshTestCase(BaseTestCase):
    def test_refresh_yields_new_access_token(self):
        data = self.login('admin', 'admin123').get_json()
        r = self.client.post('/api/auth/refresh',
                             headers={'Authorization': f"Bearer {data['refresh_token']}"})
        self.assertEqual(r.status_code, 200)
        self.assertIn('access_token', r.get_json())

    def test_refresh_rejects_access_token(self):
        # flask-jwt-extended reports a mismatched token type as 422 (wrong token
        # kind for this endpoint), not 401.
        data = self.login('admin', 'admin123').get_json()
        r = self.client.post('/api/auth/refresh',
                             headers={'Authorization': f"Bearer {data['access_token']}"})
        self.assertIn(r.status_code, (401, 422))


class PasswordResetTestCase(BaseTestCase):
    def _create_reset(self, user):
        token = secrets.token_urlsafe(32)
        db.session.add(PasswordResetToken(
            user_id=user.id, token_hash=hashlib.sha256(token.encode()).hexdigest(),
            expires_at=utcnow() + timedelta(hours=1)))
        db.session.commit()
        return token

    def test_reset_password_flow(self):
        user = User.query.filter_by(username='staff').first()
        token = self._create_reset(user)
        r = self.client.post('/api/auth/reset-password',
                             json={'token': token, 'password': 'brandnewsecret'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.login('staff', 'brandnewsecret').status_code, 200)

    def test_reset_password_rejects_reuse(self):
        user = User.query.filter_by(username='staff').first()
        token = self._create_reset(user)
        r = self.client.post('/api/auth/reset-password',
                             json={'token': token, 'password': 'brandnewsecret'})
        self.assertEqual(r.status_code, 200)
        r2 = self.client.post('/api/auth/reset-password',
                              json={'token': token, 'password': 'anothersecret'})
        self.assertEqual(r2.status_code, 400)
        self.assertIn('already been used', r2.get_json()['error'])

    def test_forgot_password_returns_generic_message(self):
        r = self.client.post('/api/auth/forgot-password', json={'email': 'staff@ict.local'})
        self.assertEqual(r.status_code, 200)
        self.assertIn('reset link has been sent', r.get_json()['message'])
        self.assertEqual(r.get_json()['message'],
                         self.client.post('/api/auth/forgot-password',
                                          json={'email': 'nobody@nowhere.com'}).get_json()['message'])


class ForgotPasswordHonestyTestCase(BaseTestCase):
    """The forgot-password reply must not claim an email was sent when SMTP is
    unconfigured, and must stay identical for every submitted address so it
    cannot be used to enumerate registered users."""

    SMTP_VARS = ('SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD')

    def _forgot(self, email):
        r = self.client.post('/api/auth/forgot-password', json={'email': email})
        return r.status_code, r.get_json()['message']

    def _without_smtp(self, fn, *a):
        env = {k: v for k, v in os.environ.items() if k not in self.SMTP_VARS}
        with mock.patch.dict(os.environ, env, clear=True):
            return fn(*a)

    def test_identical_reply_for_known_unknown_and_malformed(self):
        """Status code and wording must not vary with account existence.

        This is the property that stops the endpoint being used to discover
        which email addresses have accounts, so it is asserted across three
        shapes of input rather than just the existing/missing pair.
        """
        codes, messages = set(), set()
        for email in ('staff@ict.local', 'nobody@nowhere.com', 'not-an-email'):
            code, message = self._forgot(email)
            codes.add(code)
            messages.add(message)
        self.assertEqual(len(codes), 1, 'status code leaked account existence')
        self.assertEqual(len(messages), 1, 'wording leaked account existence')

    def test_discloses_unconfigured_delivery_when_smtp_missing(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            _, message = self._forgot('staff@ict.local')
        self.assertIn('not configured', message)
        self.assertIn('no link was sent', message)

    def test_no_disclaimer_once_smtp_is_configured(self):
        env = {'SMTP_HOST': 'smtp.example.com', 'SMTP_USER': 'mailer@example.com'}
        with mock.patch.dict(os.environ, env, clear=True):
            _, message = self._forgot('staff@ict.local')
        self.assertNotIn('not configured', message)

    def test_reply_matches_actual_send_decision(self):
        """smtp_is_configured() must agree with what send_email actually does.

        The reply is only truthful because both derive the condition from one
        helper. If they ever drift, the endpoint starts lying again.

        send_email's return value cannot be used to tell the two cases apart:
        a real attempt against an unreachable relay also returns False. What
        distinguishes them is whether the SMTP connection was opened at all,
        so the constructor is patched out.
        """
        host, user = 'smtp.example.com', 'mailer@example.com'
        combinations = [
            ({}, False),
            ({'SMTP_HOST': host}, False),
            ({'SMTP_USER': user}, False),
            ({'SMTP_HOST': host, 'SMTP_USER': user}, True),
        ]
        for env, expected in combinations:
            with self.subTest(env=sorted(env)):
                with mock.patch.dict(os.environ, env, clear=True):
                    self.assertEqual(smtp_is_configured(), expected)
                    with mock.patch('helpers.smtplib.SMTP') as smtp:
                        send_email('staff@ict.local', 'Subject', 'Body')
                        self.assertEqual(smtp.called, expected)

    def test_reset_body_is_never_written_to_the_log(self):
        """A skipped send must not leak the reset token into the log.

        Anyone able to read deploy logs could otherwise complete a reset.
        """
        import logging
        from io import StringIO

        buf = StringIO()
        handler = logging.StreamHandler(buf)
        logger = logging.getLogger('ict_ticketing')
        # The logger defaults to WARNING, which would suppress the info line
        # being asserted on and make the whole test pass without capturing
        # anything. Set the level explicitly, then restore it.
        previous_level = logger.level
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
        try:
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertFalse(send_email('staff@ict.local', 'Subject', 'SECRET-TOKEN-abc123'))
        finally:
            logger.removeHandler(handler)
            logger.setLevel(previous_level)

        logged = buf.getvalue()
        # Positive assertion first: prove the line really was captured, so the
        # check below cannot pass by observing an empty buffer.
        self.assertIn('SMTP not configured', logged)
        self.assertNotIn('SECRET-TOKEN-abc123', logged)


class TwoFATestCase(BaseTestCase):
    def test_full_2fa_enable_and_login_flow(self):
        headers = self.staff_headers()

        setup = self.client.post('/api/auth/2fa/setup', headers=headers)
        self.assertEqual(setup.status_code, 200)
        secret = setup.get_json()['secret']

        verify = self.client.post('/api/auth/2fa/setup/verify',
                                  json={'code': totp_now(secret)}, headers=headers)
        self.assertEqual(verify.status_code, 200)
        self.assertTrue(verify.get_json()['enabled'])

        # Login now requires a 2FA step.
        r = self.login('staff', 'staff123')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()['needs_2fa'])
        pending = r.get_json()['pending_token']

        final = self.client.post('/api/auth/verify-2fa',
                                 json={'pending_token': pending, 'code': totp_now(secret)})
        self.assertEqual(final.status_code, 200)
        self.assertIn('access_token', final.get_json())

    def test_disable_2fa(self):
        headers = self.staff_headers()
        setup = self.client.post('/api/auth/2fa/setup', headers=headers)
        secret = setup.get_json()['secret']
        self.client.post('/api/auth/2fa/setup/verify',
                         json={'code': totp_now(secret)}, headers=headers)

        r = self.client.post('/api/auth/2fa/disable',
                             json={'code': totp_now(secret)}, headers=headers)
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.get_json()['enabled'])