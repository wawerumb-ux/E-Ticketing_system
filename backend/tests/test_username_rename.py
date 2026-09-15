"""Username-rename tests: self-service rename requires the current password,
admin rename is allowed via PUT /api/users/<id>, every string reference is
cascaded, and refresh tokens re-issue with the CURRENT identity."""

from extensions import db
from models import Ticket, TicketComment, User
from tests.base import BaseTestCase


class SelfRenameTestCase(BaseTestCase):
    def _rename_me(self, headers, username, password):
        return self.client.put('/api/users/me/username',
                               json={'username': username, 'password': password},
                               headers=headers)

    def test_requires_current_password(self):
        r = self.client.put('/api/users/me/username',
                            json={'username': 'newname', 'password': 'wrong'},
                            headers=self.staff_headers())
        self.assertEqual(r.status_code, 401)

    def test_rename_without_password_rejected(self):
        r = self.client.put('/api/users/me/username',
                            json={'username': 'newname'},
                            headers=self.staff_headers())
        self.assertEqual(r.status_code, 401)

    def test_self_rename_returns_tokens_and_updates_user(self):
        r = self._rename_me(self.staff_headers(), 'newstaff', 'staff123')
        self.assertEqual(r.status_code, 200, r.get_json())
        data = r.get_json()
        self.assertEqual(data['user']['username'], 'newstaff')
        self.assertIn('access_token', data)
        self.assertIn('refresh_token', data)

        user = User.query.filter_by(username='newstaff').first()
        self.assertIsNotNone(user)
        self.assertIsNone(User.query.filter_by(username='staff').first())

    def test_new_username_works_at_login(self):
        self._rename_me(self.staff_headers(), 'newstaff', 'staff123')
        r = self.login('staff', 'staff123')
        self.assertEqual(r.status_code, 401)
        r = self.login('newstaff', 'staff123')
        self.assertEqual(r.status_code, 200)

    def test_duplicate_username_rejected(self):
        r = self._rename_me(self.staff_headers(), 'admin', 'staff123')
        self.assertEqual(r.status_code, 400)

    def test_same_username_rejected(self):
        r = self._rename_me(self.staff_headers(), 'staff', 'staff123')
        self.assertEqual(r.status_code, 400)

    def test_cascades_ticket_and_comment_references(self):
        self.create_ticket(headers=self.staff_headers())
        ticket = Ticket.query.order_by(Ticket.id.desc()).first()
        self.client.post(f'/api/tickets/{ticket.id}/comments',
                         json={'message': 'follow up'},
                         headers=self.staff_headers())

        r = self._rename_me(self.staff_headers(), 'newstaff', 'staff123')
        self.assertEqual(r.status_code, 200, r.get_json())

        ticket = Ticket.query.get(ticket.id)
        self.assertEqual(ticket.created_by, 'newstaff')
        comment = TicketComment.query.filter_by(ticket_id=ticket.id).first()
        self.assertEqual(comment.author_username, 'newstaff')

    def test_scoped_ticket_list_follows_new_name(self):
        self.create_ticket(headers=self.staff_headers())
        self._rename_me(self.staff_headers(), 'newstaff', 'staff123')

        r = self.client.get('/api/tickets', headers=self.auth_headers('newstaff', 'staff123'))
        tickets = r.get_json()
        self.assertTrue(any(t['created_by'] == 'newstaff' for t in tickets))
        self.assertTrue(all(t['created_by'] != 'staff' for t in tickets))


class AdminRenameTestCase(BaseTestCase):
    def test_admin_can_rename_user(self):
        staff = User.query.filter_by(username='staff').first()
        r = self.client.put(f'/api/users/{staff.id}',
                            json={'username': 'bob'},
                            headers=self.admin_headers())
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(r.get_json()['user']['username'], 'bob')
        r = self.login('bob', 'staff123')
        self.assertEqual(r.status_code, 200)

    def test_admin_rename_duplicate_rejected(self):
        staff = User.query.filter_by(username='staff').first()
        r = self.client.put(f'/api/users/{staff.id}',
                            json={'username': 'admin'},
                            headers=self.admin_headers())
        self.assertEqual(r.status_code, 400)

    def test_admin_renaming_self_gets_fresh_tokens(self):
        admin = User.query.filter_by(username='admin').first()
        r = self.client.put(f'/api/users/{admin.id}',
                            json={'username': 'boss'},
                            headers=self.admin_headers())
        # admin_headers() asserts the login worked with the OLD token; the
        # response to the rename re-issues tokens because the actor==target.
        self.assertEqual(r.status_code, 200, r.get_json())
        data = r.get_json()
        self.assertIn('access_token', data)
        self.assertIn('refresh_token', data)
        self.assertEqual(data['user']['username'], 'boss')
        r = self.login('boss', 'admin123')
        self.assertEqual(r.status_code, 200)

    def test_old_refresh_token_after_rename_uses_new_identity(self):
        self.create_ticket(headers=self.staff_headers())
        login = self.login('staff', 'staff123')
        old_refresh = login.get_json()['refresh_token']

        staff = User.query.filter_by(username='staff').first()
        r = self.client.put(f'/api/users/{staff.id}',
                            json={'username': 'staff9'},
                            headers=self.admin_headers())
        self.assertEqual(r.status_code, 200, r.get_json())

        rref = self.client.post('/api/auth/refresh',
                                headers={'Authorization': f'Bearer {old_refresh}'})
        self.assertEqual(rref.status_code, 200, rref.get_json())
        new_access = rref.get_json()['access_token']

        rt = self.client.get('/api/tickets',
                             headers={'Authorization': f'Bearer {new_access}'})
        creators = [t['created_by'] for t in rt.get_json()]
        self.assertIn('staff9', creators)
        self.assertNotIn('staff', creators)

    def test_disabled_user_cannot_refresh(self):
        login = self.login('staff', 'staff123')
        old_refresh = login.get_json()['refresh_token']
        staff = User.query.filter_by(username='staff').first()
        staff.is_active = False
        db.session.commit()

        r = self.client.post('/api/auth/refresh',
                             headers={'Authorization': f'Bearer {old_refresh}'})
        self.assertEqual(r.status_code, 401)