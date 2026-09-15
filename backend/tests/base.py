import os
import sys
import unittest
import warnings

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

warnings.filterwarnings('ignore', message='The Query.get\\(\\).*')
warnings.filterwarnings('ignore', message='.*Using the in-memory storage for tracking rate limits')

from flask import Flask

from extensions import db, jwt, limiter, oauth
from routes import register_blueprints
from schema import seed_default_roles, seed_default_users, seed_settings


def make_test_app():
    """A fresh Flask app bound to SQLite in-memory, so the test suite never
    touches the MySQL engine that app.py configures at import time."""
    test_app = Flask(__name__)
    test_app.config.update(
        TESTING=True,
        RATELIMIT_ENABLED=False,
        SQLALCHEMY_DATABASE_URI='sqlite:///:memory:',
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SECRET_KEY='test-secret',
        JWT_SECRET_KEY='test-secret',
        UPLOAD_FOLDER='/tmp/ict-uploads-test',
    )
    db.init_app(test_app)
    jwt.init_app(test_app)
    limiter.init_app(test_app)
    oauth.init_app(test_app)
    register_blueprints(test_app)
    return test_app


class BaseTestCase(unittest.TestCase):
    """Shared setup for the API test suite: isolated in-memory sqlite DB,
    rate limiting disabled, default admin/staff users and settings seeded."""

    @classmethod
    def setUpClass(cls):
        cls.app = make_test_app()

    def setUp(self):
        self.client = self.app.test_client()
        self.ctx = self.app.app_context()
        self.ctx.push()
        db.create_all()
        seed_default_roles()
        seed_default_users()
        seed_settings()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def login(self, username='admin', password='admin123'):
        return self.client.post('/api/auth/login',
                                json={'username': username, 'password': password})

    def auth_headers(self, username='admin', password='admin123'):
        r = self.login(username, password)
        self.assertEqual(r.status_code, 200, r.get_json())
        token = r.get_json()['access_token']
        return {'Authorization': f'Bearer {token}'}

    def admin_headers(self):
        return self.auth_headers('admin', 'admin123')

    def staff_headers(self):
        return self.auth_headers('staff', 'staff123')

    def create_ticket(self, headers=None, **overrides):
        payload = {
            'title': 'Printer not working',
            'description': 'Cannot print from the 2nd floor',
            'category': 'hardware',
            'priority': 'high',
        }
        payload.update(overrides)
        return self.client.post('/api/tickets',
                                json=payload,
                                headers=headers or self.admin_headers())