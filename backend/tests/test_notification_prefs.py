"""Per-category notification preferences: GET/PUT self-service endpoints and
server-side gating inside notify_users()."""

from extensions import db
from helpers import notify_users
from models import Notification, NotificationPreference

from tests.base import BaseTestCase


class NotificationPrefsTestCase(BaseTestCase):

    def fetch(self, headers):
        return self.client.get('/api/users/me/notification-preferences', headers=headers)

    def toggle(self, headers, category, enabled):
        return self.client.put('/api/users/me/notification-preferences',
                               json={'category': category, 'enabled': enabled},
                               headers=headers)

    def test_staff_get_sees_shared_only(self):
        r = self.fetch(self.staff_headers())
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertIn('ticket_updates', data['categories'])
        self.assertIn('technician_replies', data['categories'])
        self.assertIn('announcements', data['categories'])
        self.assertNotIn('sla_breaches', data['categories'])
        self.assertNotIn('sla_breaches', data['registry'])

    def test_admin_get_sees_admin_categories(self):
        r = self.fetch(self.admin_headers())
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertIn('sla_breaches', data['categories'])
        self.assertEqual(data['registry']['sla_breaches']['role'], 'admin')

    def test_all_shared_categories_default_on(self):
        data = self.fetch(self.staff_headers()).get_json()
        for cid, val in data['categories'].items():
            self.assertTrue(val, f'{cid} should default to enabled')

    def test_put_toggle_persists(self):
        headers = self.staff_headers()
        r = self.toggle(headers, 'ticket_updates', False)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()['categories']['ticket_updates'], False)
        data = self.fetch(headers).get_json()
        self.assertEqual(data['categories']['ticket_updates'], False)
        self.assertEqual(data['categories']['announcements'], True)

    def test_put_unknown_category_400(self):
        r = self.toggle(self.staff_headers(), 'not_a_category', True)
        self.assertEqual(r.status_code, 400)

    def test_put_non_boolean_400(self):
        r = self.toggle(self.staff_headers(), 'ticket_updates', 'yes')
        self.assertEqual(r.status_code, 400)

    def test_staff_putting_admin_category_403(self):
        r = self.toggle(self.staff_headers(), 'sla_breaches', False)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.get_json()['error'], 'category_not_permitted')

    def test_admin_can_toggle_admin_category(self):
        r = self.toggle(self.admin_headers(), 'sla_breaches', False)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()['categories']['sla_breaches'], False)

    def test_notify_users_respects_disabled_category(self):
        headers = self.staff_headers()
        self.toggle(headers, 'ticket_updates', False)
        notify_users(['staff'], 'ticket_update', 'New ticket for you', '/api/tickets/1',
                     'subject', 'body')
        db.session.commit()
        n = Notification.query.filter_by(user_id=2).all()
        self.assertEqual([x.type for x in n], [])

    def test_notify_users_creates_when_enabled(self):
        notify_users(['staff'], 'ticket_update', 'New ticket for you', '/api/tickets/1',
                     'subject', 'body')
        db.session.commit()
        n = Notification.query.filter_by(user_id=2).first()
        self.assertIsNotNone(n)
        self.assertEqual(n.type, 'ticket_update')

    def test_existing_pref_row_gets_category_column(self):
        pref = NotificationPreference(user_id=2)
        db.session.add(pref)
        db.session.commit()
        r = self.toggle(self.staff_headers(), 'announcements', False)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(pref.categories.get('announcements'), False)


if __name__ == '__main__':
    import unittest
    unittest.main()