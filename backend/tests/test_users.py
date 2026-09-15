"""User management access-control tests: the user list must be admin-only."""

import hashlib
from datetime import timedelta

from werkzeug.security import generate_password_hash

from extensions import db, utcnow
from models import Notification, PasswordResetToken, User
from tests.base import BaseTestCase


class UserListAccessTestCase(BaseTestCase):
    """GET /api/users is admin-only (S7): it exposes every user's email."""

    def test_staff_cannot_list_users(self):
        r = self.client.get('/api/users', headers=self.staff_headers())
        self.assertEqual(r.status_code, 403)

    def test_admin_can_list_users(self):
        r = self.client.get('/api/users', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        usernames = {u['username'] for u in data}
        self.assertIn('admin', usernames)
        self.assertIn('staff', usernames)


class UserFilterTestCase(BaseTestCase):
    """Server-side filtering of GET /api/users via query params."""

    def setUp(self):
        super().setUp()
        for username, email, role, department in [
            ('alice', 'alice@example.com', 'admin', 'engineering'),
            ('bob', 'bob@example.com', 'staff', 'helpdesk'),
            ('carol', 'carol@example.com', 'staff', 'engineering'),
        ]:
            u = User(username=username, email=email,
                     password_hash=generate_password_hash('x'),
                     role=role, department=department)
            db.session.add(u)
        db.session.flush()
        carol = User.query.filter_by(username='carol').first()
        carol.is_active = False
        db.session.commit()

    def _usernames(self, url):
        r = self.client.get(url, headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        return {u['username'] for u in r.get_json()}

    def test_no_params_returns_all(self):
        usernames = self._usernames('/api/users')
        self.assertEqual(usernames, {'admin', 'staff', 'alice', 'bob', 'carol'})

    def test_role_filter(self):
        usernames = self._usernames('/api/users?role=admin')
        self.assertEqual(usernames, {'admin', 'alice'})

    def test_status_filter_inactive(self):
        usernames = self._usernames('/api/users?status=inactive')
        self.assertEqual(usernames, {'carol'})

    def test_status_filter_active(self):
        usernames = self._usernames('/api/users?status=active')
        self.assertNotIn('carol', usernames)
        self.assertIn('bob', usernames)

    def test_department_filter(self):
        usernames = self._usernames('/api/users?department=engineering')
        self.assertEqual(usernames, {'alice', 'carol'})

    def test_q_matches_username(self):
        usernames = self._usernames('/api/users?q=ali')
        self.assertEqual(usernames, {'alice'})

    def test_q_matches_email(self):
        usernames = self._usernames('/api/users?q=bob@example')
        self.assertEqual(usernames, {'bob'})

    def test_q_matches_department(self):
        usernames = self._usernames('/api/users?q=helpdesk')
        self.assertEqual(usernames, {'bob'})

    def test_combined_filters(self):
        usernames = self._usernames('/api/users?role=admin&department=engineering&status=active')
        self.assertEqual(usernames, {'alice'})

    def test_unknown_role_returns_empty(self):
        # Roles are now a dynamic registry — any string is a valid literal
        # filter, so an unknown role simply matches nobody.
        usernames = self._usernames('/api/users?role=superadmin')
        self.assertEqual(usernames, set())

    def test_invalid_status_ignored(self):
        usernames = self._usernames('/api/users?status=banned')
        self.assertEqual(usernames, {'admin', 'staff', 'alice', 'bob', 'carol'})


class UserPurgeTestCase(BaseTestCase):
    """Permanent delete is admin-only, refuses self-delete, and removes FK
    children (AGENTS.md 1.3 written exception, developer-approved)."""

    def _create_user(self, username='purge-me', role='staff'):
        r = self.client.post('/api/users', headers=self.admin_headers(), json={
            'username': username,
            'email': f'{username}@example.com',
            'password': 'password123',
            'role': role,
        })
        self.assertEqual(r.status_code, 201, r.get_json())
        return r.get_json()['user']['id']

    def test_admin_purges_user(self):
        uid = self._create_user()
        r = self.client.delete(f'/api/users/{uid}/permanent', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()['message'], 'User permanently deleted')
        self.assertIsNone(User.query.get(uid))

    def test_purged_user_absent_from_list(self):
        uid = self._create_user()
        self.client.delete(f'/api/users/{uid}/permanent', headers=self.admin_headers())
        ids = [u['id'] for u in self.client.get('/api/users', headers=self.admin_headers()).get_json()]
        self.assertNotIn(uid, ids)

    def test_purge_requires_admin(self):
        uid = self._create_user()
        r = self.client.delete(f'/api/users/{uid}/permanent', headers=self.staff_headers())
        self.assertEqual(r.status_code, 403)

    def test_cannot_purge_self(self):
        admin = User.query.filter_by(username='admin').first()
        r = self.client.delete(f'/api/users/{admin.id}/permanent', headers=self.admin_headers())
        self.assertEqual(r.status_code, 403)
        self.assertIsNotNone(User.query.get(admin.id))

    def test_purge_removes_fk_children(self):
        uid = self._create_user()
        db.session.add(PasswordResetToken(
            user_id=uid,
            token_hash=hashlib.sha256(b'purge-test').hexdigest(),
            expires_at=utcnow() + timedelta(hours=1),
        ))
        db.session.add(Notification(user_id=uid, type='info', message='purge-test'))
        db.session.commit()
        self.assertEqual(PasswordResetToken.query.filter_by(user_id=uid).count(), 1)
        self.assertEqual(Notification.query.filter_by(user_id=uid).count(), 1)

        r = self.client.delete(f'/api/users/{uid}/permanent', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(PasswordResetToken.query.filter_by(user_id=uid).count(), 0)
        self.assertEqual(Notification.query.filter_by(user_id=uid).count(), 0)
        self.assertEqual(db.session.query(User).filter_by(id=uid).count(), 0)