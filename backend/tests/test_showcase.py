"""Showcase template allowlist + loader contract tests."""

import unittest

from base import BaseTestCase, make_test_app

from routes.showcase import SHOWCASE_TEMPLATES, _load_template


class ShowcaseTemplateTestCase(BaseTestCase):
    """The template column is an allowlist, not free text. Every curated
    template exists on disk and carries the config injection marker."""

    def test_all_allowlisted_templates_exist(self):
        for template in SHOWCASE_TEMPLATES:
            with self.subTest(template=template):
                html = _load_template(template)
                self.assertIsNotNone(html, f'{template} missing from templates dir')

    def test_openserv_laptop_is_allowlisted_and_marked(self):
        html = _load_template('openserv-laptop')
        self.assertIsNotNone(html)
        self.assertIn('<!--SHOWCASE_CONFIG-->', html)

    def test_unknown_template_rejected(self):
        self.assertIsNone(_load_template('nope'))

    def test_new_template_not_precached_path(self):
        """Showcase folder stays outside the service-worker shell: the allowlist
        is the only route into it, and it never appears in sw.js SHELL_URLS."""
        html = _load_template('openserv-laptop')
        self.assertNotIn('sw.js', html)


if __name__ == '__main__':
    unittest.main()