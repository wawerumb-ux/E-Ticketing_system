"""API token + v1 endpoints + webhook admin routes."""

from models import ApiToken, Webhook
from tests.base import BaseTestCase


class ApiTokenTestCase(BaseTestCase):
    def _create_token(self, name='ci-token'):
        return self.client.post('/api/tokens',
                                json={'name': name, 'scopes': 'read,create'},
                                headers=self.admin_headers())

    def test_admin_creates_token(self):
        r = self._create_token()
        self.assertEqual(r.status_code, 201)
        data = r.get_json()
        self.assertTrue(data['token'].startswith('ict_'))
        self.assertIn('not be shown again', data['message'])

    def test_v1_list_tickets_with_token(self):
        token = self._create_token().get_json()['token']
        r = self.client.get('/api/v1/tickets', headers={'Authorization': f'Bearer {token}'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()['count'], 0)

    def test_v1_create_ticket_with_token(self):
        token = self._create_token().get_json()['token']
        r = self.client.post('/api/v1/tickets', headers={'Authorization': f'Bearer {token}'},
                             json={'title': 'API-created', 'description': 'via token',
                                   'category': 'software', 'priority': 'low'})
        self.assertEqual(r.status_code, 201)
        data = r.get_json()
        self.assertEqual(data['ticket_number'], 'ICT-00001')
        self.assertEqual(data['priority'], 'low')
        self.assertEqual(data['priority_source'], 'manual')

    def test_v1_derives_priority_when_none_supplied(self):
        token = self._create_token().get_json()['token']
        r = self.client.post('/api/v1/tickets', headers={'Authorization': f'Bearer {token}'},
                             json={'title': 'No internet on the 2nd floor',
                                   'description': 'Cannot reach the office wifi',
                                   'category': 'other'})
        self.assertEqual(r.status_code, 201, r.get_json())
        data = r.get_json()
        self.assertEqual(data['priority'], 'high')
        self.assertEqual(data['priority_source'], 'rule_engine')
        self.assertIsNotNone(data['priority_explanation'])

    def test_v1_rejects_garbage_token(self):
        r = self.client.get('/api/v1/tickets', headers={'Authorization': 'Bearer not-a-real-token'})
        self.assertEqual(r.status_code, 401)

    def test_v1_kb_requires_token(self):
        r = self.client.get('/api/v1/kb')
        self.assertEqual(r.status_code, 401)

    def test_v1_stats(self):
        token = self._create_token().get_json()['token']
        r = self.client.get('/api/v1/stats', headers={'Authorization': f'Bearer {token}'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()['total_tickets'], 0)

    def test_revoked_token_fails(self):
        token_id = self._create_token().get_json()['id']
        self.client.delete(f'/api/tokens/{token_id}', headers=self.admin_headers())
        self.assertEqual(ApiToken.query.get(token_id).is_active, False)

    def test_tokens_require_admin(self):
        r = self.client.get('/api/tokens', headers=self.staff_headers())
        self.assertEqual(r.status_code, 403)


class WebhookTestCase(BaseTestCase):
    def test_crud_roundtrip(self):
        create = self.client.post('/api/webhooks', json={
            'name': 'slack', 'url': 'https://hooks.example.com/abc', 'events': 'ticket.created'},
            headers=self.admin_headers())
        self.assertEqual(create.status_code, 201)
        wid = create.get_json()['id']

        update = self.client.put(f'/api/webhooks/{wid}',
                                 json={'events': 'ticket.created,ticket.updated'},
                                 headers=self.admin_headers())
        self.assertEqual(update.status_code, 200)
        self.assertEqual(Webhook.query.get(wid).events, 'ticket.created,ticket.updated')

        listed = self.client.get('/api/webhooks', headers=self.admin_headers())
        self.assertEqual(len(listed.get_json()), 1)

        delete = self.client.delete(f'/api/webhooks/{wid}', headers=self.admin_headers())
        self.assertEqual(delete.status_code, 200)
        self.assertIsNone(Webhook.query.get(wid))

    def test_webhook_rejects_bad_url(self):
        r = self.client.post('/api/webhooks', json={'url': 'javascript:alert(1)'},
                             headers=self.admin_headers())
        self.assertEqual(r.status_code, 400)