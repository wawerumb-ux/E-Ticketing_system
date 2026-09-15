"""Authentication flow tests: login, lockout, registration, refresh,
password reset and 2FA setup/verify/disable."""

import hashlib
import secrets
from datetime import timedelta

from models import PasswordResetToken, User
from tests.base import BaseTestCase
from totp import totp_now

from extensions import db, utcnow


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
        self.assertIn('locked', locked['error'].lower())
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