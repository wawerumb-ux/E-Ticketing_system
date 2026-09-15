"""Sanity checks that app re-exports still resolve and from app import works —
the exact import surface tests, migrations/env.py and docker-entrypoint rely on.
"""

from app import (
    Category,
    Department,
    KnowledgeArticle,
    Notification,
    Ticket,
    User,
    app,
    bootstrap_database,
    db,
    ensure_phase3_schema,
    ensure_phase4_schema,
    ensure_user_schema,
    seed_default_users,
    seed_settings,
    seed_starter_articles,
    seed_starter_categories,
    seed_starter_departments,
)

from tests.base import BaseTestCase


class AppImportSurfaceTestCase(BaseTestCase):
    def test_all_re_exports_resolve(self):
        self.assertIsNotNone(app)
        self.assertIsNotNone(db)
        self.assertTrue(callable(seed_default_users))
        self.assertTrue(callable(seed_settings))
        self.assertTrue(callable(ensure_user_schema))
        self.assertTrue(callable(ensure_phase3_schema))
        self.assertTrue(callable(ensure_phase4_schema))
        self.assertTrue(callable(bootstrap_database))

    def test_bootstrap_database_is_idempotent(self):
        bootstrap_database()  # tables + seeded rows already exist -> must not raise
        self.assertEqual(User.query.filter_by(username='admin').count(), 1)
        self.assertIsNone(seed_settings())

    def test_default_users_seeded(self):
        self.assertEqual(User.query.filter_by(username='admin').count(), 1)
        self.assertEqual(User.query.filter_by(username='staff').count(), 1)