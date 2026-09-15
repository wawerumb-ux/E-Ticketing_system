"""Role registry (classification labels) tests.

Roles are soft-deletable labels referenced by name across users. Only 'admin'
confers elevated access (JWT role claim); every other role gets staff-tier
access, which is already open to any authenticated user (S2 — labels, not a
permission matrix).
"""

from extensions import db
from helpers import round_robin_assignees
from models import Role, User


from tests.base import BaseTestCase


class RoleRegistryTestCase(BaseTestCase):

    def _staff_id(self):
        return User.query.filter_by(username='staff').first().id

    def test_roles_seeded(self):
        r = self.client.get('/api/roles', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        names = {x['name'] for x in r.get_json()}
        self.assertEqual(names, {'staff', 'admin'})

    def test_staff_cannot_manage_roles(self):
        r = self.client.get('/api/roles', headers=self.staff_headers())
        self.assertEqual(r.status_code, 403)

    def test_admin_creates_role_lowercased(self):
        r = self.client.post('/api/roles', headers=self.admin_headers(), json={'name': 'MANAGER'})
        self.assertEqual(r.status_code, 201, r.get_json())
        self.assertEqual(r.get_json()['name'], 'manager')

    def test_duplicate_role_rejected(self):
        r = self.client.post('/api/roles', headers=self.admin_headers(), json={'name': 'admin'})
        self.assertEqual(r.status_code, 400)

    def test_role_name_too_long_rejected(self):
        r = self.client.post('/api/roles', headers=self.admin_headers(), json={'name': 'a' * 21})
        self.assertEqual(r.status_code, 400)

    def test_admin_role_cannot_be_disabled(self):
        admin_role = Role.query.filter_by(name='admin').first()
        r = self.client.delete(f'/api/roles/{admin_role.id}', headers=self.admin_headers())
        self.assertEqual(r.status_code, 400)

    def test_custom_role_soft_disabled_and_reactivated(self):
        self.client.post('/api/roles', headers=self.admin_headers(), json={'name': 'manager'})
        manager = Role.query.filter_by(name='manager').first()
        r = self.client.delete(f'/api/roles/{manager.id}', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        self.assertFalse(Role.query.get(manager.id).is_active)
        r = self.client.post('/api/roles', headers=self.admin_headers(), json={'name': 'manager'})
        self.assertEqual(r.status_code, 201)
        self.assertTrue(Role.query.get(manager.id).is_active)

    def test_create_user_rejects_unknown_role(self):
        payload = {'username': 'nova', 'email': 'nova@test.com', 'password': 'pw12345678', 'role': 'superduper'}
        r = self.client.post('/api/users', headers=self.admin_headers(), json=payload)
        self.assertEqual(r.status_code, 400)

    def test_create_user_with_custom_role(self):
        self.client.post('/api/roles', headers=self.admin_headers(), json={'name': 'manager'})
        payload = {'username': 'nova', 'email': 'nova@test.com', 'password': 'pw12345678',
                   'role': 'manager', 'department': 'ops'}
        r = self.client.post('/api/users', headers=self.admin_headers(), json=payload)
        self.assertEqual(r.status_code, 201, r.get_json())
        self.assertEqual(r.get_json()['user']['role'], 'manager')

    def test_update_user_with_inactive_role_rejected(self):
        self.client.post('/api/roles', headers=self.admin_headers(), json={'name': 'manager'})
        manager = Role.query.filter_by(name='manager').first()
        self.client.delete(f'/api/roles/{manager.id}', headers=self.admin_headers())
        r = self.client.put(f'/api/users/{self._staff_id()}', headers=self.admin_headers(), json={'role': 'manager'})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(User.query.get(self._staff_id()).role, 'staff')

    def test_users_list_filters_custom_role(self):
        self.client.post('/api/roles', headers=self.admin_headers(), json={'name': 'manager'})
        self.client.post('/api/users', headers=self.admin_headers(),
                         json={'username': 'nova', 'email': 'nova@test.com', 'password': 'pw12345678',
                               'role': 'manager'})
        r = self.client.get('/api/users?role=manager', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        self.assertEqual({u['username'] for u in r.get_json()}, {'nova'})

    def test_custom_role_user_gets_staff_tier_but_not_admin(self):
        self.client.post('/api/roles', headers=self.admin_headers(), json={'name': 'manager'})
        self.client.post('/api/users', headers=self.admin_headers(),
                         json={'username': 'nova', 'email': 'nova@test.com', 'password': 'pw12345678',
                               'role': 'manager'})
        headers = self.auth_headers('nova', 'pw12345678')
        self.assertEqual(self.client.get('/api/users', headers=headers).status_code, 403)
        r = self.client.post('/api/tickets', headers=headers,
                             json={'title': 'T', 'description': 'D', 'category': 'hardware', 'priority': 'low'})
        self.assertEqual(r.status_code, 201, r.get_json())

    def test_round_robin_candidates_include_custom_roles(self):
        self.client.post('/api/roles', headers=self.admin_headers(), json={'name': 'manager'})
        self.client.post('/api/users', headers=self.admin_headers(),
                         json={'username': 'nova', 'email': 'nova@test.com', 'password': 'pw12345678',
                               'role': 'manager'})
        for username in ('admin', 'staff'):
            self.client.post('/api/tickets', headers=self.admin_headers(),
                             json={'title': 'x', 'description': 'y', 'category': 'hardware',
                                   'priority': 'low', 'assigned_to': username})
        pick = round_robin_assignees()
        self.assertEqual(pick, 'nova')