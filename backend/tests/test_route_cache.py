"""Cache-layer tests: the helper contract (miss/hit/expiry/keys/delete/clear)
and the route wiring (dashboard caller-independence, admin CSV gates, cached
CSV bytes). The module-level cache is cleared per test to avoid bleed-over."""

import time

from helpers import cache_clear, cache_delete, cache_get, cache_key, cache_set
from tests.base import BaseTestCase


class RouteCacheUtilityTestCase(BaseTestCase):
    """Direct unit coverage of the cache helpers in helpers.py."""

    def setUp(self):
        super().setUp()
        cache_clear()

    def test_miss_returns_none(self):
        self.assertIsNone(cache_get('missing:key'))

    def test_set_get_hit_and_overwrite(self):
        key = cache_key('stats', 'dashboard')
        cache_set(key, {'total': 3}, 30)
        self.assertEqual(cache_get(key), {'total': 3})
        cache_set(key, {'total': 9}, 30)
        self.assertEqual(cache_get(key), {'total': 9})

    def test_ttl_expiry(self):
        cache_set('expiry', 'x', 1)
        self.assertEqual(cache_get('expiry'), 'x')
        time.sleep(1.05)
        self.assertIsNone(cache_get('expiry'))

    def test_key_helper_delete_and_clear(self):
        self.assertEqual(cache_key('a', None, 'b'), 'a:b')
        a = cache_key('export', 'tickets')
        b = cache_key('export', 'users')
        cache_set(a, 1, 30)
        cache_set(b, 2, 30)
        cache_delete(a)
        self.assertIsNone(cache_get(a))
        self.assertEqual(cache_get(b), 2)
        cache_clear()
        self.assertIsNone(cache_get(b))


class RouteCacheWiringTestCase(BaseTestCase):
    """Route-level behavior through the real app (isolated in-memory sqlite)."""

    def setUp(self):
        super().setUp()
        cache_clear()

    def test_dashboard_stats_identical_across_callers(self):
        """Global key: admin and staff must receive the same cached value. A
        ticket created between the two calls proves the second response is
        served from cache — a fresh computation would differ by one count, so
        equal totals prove caller-independence and cache sharing."""
        admin = self.admin_headers()
        staff = self.staff_headers()
        first = self.client.get('/api/dashboard/stats', headers=admin)
        self.assertEqual(first.status_code, 200)
        before = first.get_json()['total']

        self.create_ticket(headers=admin)

        second = self.client.get('/api/dashboard/stats', headers=staff)
        self.assertEqual(second.status_code, 200)
        after = second.get_json()['total']
        self.assertEqual(after, before,
                         'staff must share the cached dashboard value (global key, no caller scoping)')

    def test_csv_admin_only_gate_survives_cache(self):
        self.client.get('/api/reports/export/tickets.csv', headers=self.admin_headers())
        staff = self.client.get('/api/reports/export/tickets.csv', headers=self.staff_headers())
        self.assertEqual(staff.status_code, 403)
        self.assertEqual(staff.get_json()['error'], 'Insufficient permissions')

    def test_csv_cached_bytes_and_param_keyed_content(self):
        admin = self.admin_headers()
        self.create_ticket(headers=admin)
        first = self.client.get('/api/reports/export/tickets.csv', headers=admin)
        second = self.client.get('/api/reports/export/tickets.csv', headers=admin)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.get_data(), first.get_data(),
                         'second download must be served from cached bytes')
        self.assertEqual(second.mimetype, 'text/csv')
        self.assertEqual(second.headers.get('Content-Disposition'),
                         first.headers.get('Content-Disposition'))

        ranged = self.client.get(
            '/api/reports/export/tickets.csv?from=2020-01-01&to=2020-01-31', headers=admin)
        self.assertEqual(ranged.status_code, 200)
        self.assertNotEqual(ranged.get_data(), first.get_data(),
                            'from/to params must produce a distinct cache entry')

        invalid = self.client.get(
            '/api/reports/export/tickets.csv?from=not-a-date', headers=admin)
        self.assertEqual(invalid.status_code, 400)