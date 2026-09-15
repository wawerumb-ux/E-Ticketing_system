"""Health, dashboard, categories/departments/settings/reports and KB tests."""

from models import Category, Department, KnowledgeArticle
from tests.base import BaseTestCase


class HealthTestCase(BaseTestCase):
    def test_health_ok(self):
        r = self.client.get('/api/health')
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body['status'], 'healthy')
        self.assertEqual(body['database'], True)
        # No DB host / URI leakage on a public endpoint.
        text = r.get_data(as_text=True)
        self.assertNotIn('127.0.0.1', text)
        self.assertNotIn('@', text)
        self.assertNotIn('password', text.lower())


class DashboardTestCase(BaseTestCase):
    def test_dashboard_stats_require_auth(self):
        r = self.client.get('/api/dashboard/stats')
        self.assertEqual(r.status_code, 401)

    def test_dashboard_stats_shape(self):
        r = self.client.get('/api/dashboard/stats', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        for key in ('total', 'open', 'in_progress', 'resolved', 'priority_breakdown', 'sla'):
            self.assertIn(key, data)


class ManagementTestCase(BaseTestCase):
    def test_category_lifecycle(self):
        create = self.client.post('/api/categories', json={'name': 'Network'},
                                  headers=self.admin_headers())
        self.assertEqual(create.status_code, 201)
        cid = create.get_json()['id']

        listed = self.client.get('/api/categories')
        names = [c['name'] for c in listed.get_json()]
        self.assertIn('Network', names)

        deactivate = self.client.delete(f'/api/categories/{cid}', headers=self.admin_headers())
        self.assertEqual(deactivate.status_code, 200)
        self.assertFalse(Category.query.get(cid).is_active)

    def test_duplicate_active_category_rejected(self):
        self.client.post('/api/categories', json={'name': 'Network'}, headers=self.admin_headers())
        r = self.client.post('/api/categories', json={'name': 'Network'}, headers=self.admin_headers())
        self.assertEqual(r.status_code, 400)
        self.assertIn('already exists', r.get_json()['error'])
        self.assertEqual(Category.query.filter_by(name='Network').count(), 1)

    def test_deactivated_category_can_be_reactivated(self):
        cid = self.client.post('/api/categories', json={'name': 'Network'},
                               headers=self.admin_headers()).get_json()['id']
        self.client.delete(f'/api/categories/{cid}', headers=self.admin_headers())
        r = self.client.post('/api/categories', json={'name': 'Network'}, headers=self.admin_headers())
        self.assertEqual(r.status_code, 201)
        self.assertEqual(Category.query.filter_by(name='Network').count(), 1)

    def test_department_lifecycle(self):
        create = self.client.post('/api/departments', json={'name': 'Finance'},
                                  headers=self.admin_headers())
        self.assertEqual(create.status_code, 201)
        listed = self.client.get('/api/departments')
        self.assertIn('Finance', [d['name'] for d in listed.get_json()])

    def test_settings_get_put(self):
        r = self.client.get('/api/settings', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        self.assertIn('sla_response_high', r.get_json())

        put = self.client.put('/api/settings', json={'sla_response_high': 4},
                              headers=self.admin_headers())
        self.assertEqual(put.status_code, 200)

        after = self.client.get('/api/settings', headers=self.admin_headers()).get_json()
        self.assertEqual(after['sla_response_high'], '4')

    def test_settings_reject_non_positive_sla(self):
        put = self.client.put('/api/settings', json={'sla_response_high': -1},
                              headers=self.admin_headers())
        self.assertEqual(put.status_code, 400)

    def test_reports_summary_shape(self):
        self.create_ticket(priority='high')
        r = self.client.get('/api/reports/summary', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertEqual(data['totals']['total'], 1)
        self.assertIn('daily', data)
        self.assertIn('categories', data)

    def test_reports_export_csv(self):
        self.create_ticket()
        r = self.client.get('/api/reports/export/tickets.csv', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        self.assertIn('text/csv', r.mimetype)
        self.assertTrue(r.get_data(as_text=True).startswith('\ufeffid,ticket_number'))

    def test_audit_logs_list_and_clear(self):
        self.create_ticket()
        r = self.client.get('/api/audit/logs', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        self.assertGreaterEqual(len(r.get_json()), 1)

        clear = self.client.delete('/api/audit/logs', headers=self.admin_headers())
        self.assertEqual(clear.status_code, 200)


class KnowledgeBaseTestCase(BaseTestCase):
    def test_article_crud(self):
        create = self.client.post('/api/kb/articles',
                                  json={'title': 'VPN Setup', 'category': 'software',
                                        'content': 'How to connect to the VPN'},
                                  headers=self.admin_headers())
        self.assertEqual(create.status_code, 201)

        listed = self.client.get('/api/kb/articles', headers=self.admin_headers())
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(len(listed.get_json()), 1)

        # Staff can also read the knowledge base.
        staff_listed = self.client.get('/api/kb/articles', headers=self.staff_headers())
        self.assertEqual(staff_listed.status_code, 200)

    def test_article_creation_requires_role(self):
        r = self.client.post('/api/kb/articles',
                             json={'title': 'x', 'content': 'y'},
                             headers=self.staff_headers())
        self.assertEqual(r.status_code, 403)