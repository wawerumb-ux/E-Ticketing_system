"""Configurable ticket priority rules engine:
pure evaluation + validation, admin CRUD endpoints, and the create-ticket
derivation/audit path. 24 tests -> baseline 145 + 24 = 169.
"""

import json

import unittest

from helpers import (
    PRIORITY_DEFAULT_RULES,
    build_priority_config,
    evaluate_priority,
    validate_priority_rules,
)
from models import AuditLog, Ticket
from tests.base import BaseTestCase


def _builtin_config():
    return {
        'version': 'builtin',
        'default_priority': 'medium',
        'rules': PRIORITY_DEFAULT_RULES,
    }


def _evidence(**overrides):
    evidence = {
        'title': 'x',
        'description': 'y',
        'category': 'other',
        'department': None,
        'role': 'staff',
        'created_at': '2026-09-18T08:00:00Z',
    }
    evidence.update(overrides)
    return evidence


def _valid_rule(**overrides):
    rule = {
        'rule_id': 'r1',
        'name': 'Rule one',
        'enabled': True,
        'condition': [{'field': 'category', 'op': 'equals', 'value': 'Software'}],
        'resulting_priority': 'medium',
        'stop': True,
        'explanation_template': 'Matched {matched_value}.',
    }
    rule.update(overrides)
    return rule


class PriorityEngineTestCase(unittest.TestCase):
    """Pure evaluation of the default rule set (first-match-wins, stop and
    running-best semantics, fallback, case-insensitivity, UTC time rules)."""

    def test_security_keyword_in_title_high(self):
        r = evaluate_priority(
            _evidence(title='Phishing attempt in the mail'),
            _builtin_config())
        self.assertEqual(r['priority'], 'high')
        self.assertEqual(r['rule_id'], 'security_incident')
        self.assertEqual(r['matched_keyword'], 'phishing')
        self.assertFalse(r['fallback'])
        self.assertTrue(r['stop'])

    def test_network_keyword_in_title_case_insensitive(self):
        r = evaluate_priority(
            _evidence(title='No InTeRnEt in building 3'),
            _builtin_config())
        self.assertEqual(r['priority'], 'high')
        self.assertEqual(r['rule_id'], 'network_outage')
        self.assertEqual(r['matched_keyword'], 'no internet')

    def test_keyword_in_description_matches(self):
        r = evaluate_priority(
            _evidence(title='Something odd', description='someone saw a data leak'),
            _builtin_config())
        self.assertEqual(r['rule_id'], 'security_incident')
        self.assertEqual(r['matched_field'], 'description')
        self.assertEqual(r['priority'], 'high')

    def test_network_category_gets_high_via_in_op(self):
        r = evaluate_priority(
            _evidence(category='Network'),
            _builtin_config())
        self.assertEqual(r['rule_id'], 'critical_outage')
        self.assertEqual(r['matched_field'], 'category')
        self.assertEqual(r['matched_value'], 'Network')
        self.assertEqual(r['priority'], 'high')

    def test_hardware_keyword_gets_medium(self):
        r = evaluate_priority(
            _evidence(category='hardware', title='Printer wont boot'),
            _builtin_config())
        self.assertEqual(r['rule_id'], 'hardware_failure')
        self.assertEqual(r['matched_keyword'], 'wont boot')
        self.assertEqual(r['priority'], 'medium')

    def test_disabled_rules_skipped_and_non_stop_running_best(self):
        config = {
            'version': 't',
            'default_priority': 'medium',
            'rules': [
                {'rule_id': 'disabled_high', 'name': 'Disabled', 'enabled': False,
                 'condition': [{'field': 'department', 'op': 'equals', 'value': 'IT'}],
                 'resulting_priority': 'high', 'stop': True, 'explanation_template': 'x'},
                {'rule_id': 'general_low', 'name': 'General', 'enabled': True,
                 'condition': [{'field': 'category', 'op': 'equals', 'value': 'General'}],
                 'resulting_priority': 'low', 'stop': False, 'explanation_template': 'x'},
                {'rule_id': 'hardware_med', 'name': 'Hardware', 'enabled': True,
                 'condition': [{'field': 'title', 'op': 'contains', 'values': ['wont boot']}],
                 'resulting_priority': 'medium', 'stop': True, 'explanation_template': 'x'},
            ],
        }
        r = evaluate_priority(_evidence(category='General', title='printer wont boot', department='IT'), config)
        self.assertEqual(r['rule_id'], 'hardware_med')
        self.assertEqual(r['priority'], 'medium')

        r2 = evaluate_priority(_evidence(category='General', title='nothing here'), config)
        self.assertEqual(r2['rule_id'], 'general_low')
        self.assertEqual(r2['priority'], 'low')
        self.assertFalse(r2['fallback'])

    def test_no_match_falls_back_to_default_priority(self):
        r = evaluate_priority(_evidence(category='Beta', title='Timesheet'), _builtin_config())
        self.assertTrue(r['fallback'])
        self.assertEqual(r['priority'], 'medium')
        self.assertIsNone(r['rule_id'])
        self.assertEqual(r['rules_version'], 'builtin')

    def test_between_rule_uses_utc_hours(self):
        config = {
            'version': 't',
            'default_priority': 'medium',
            'rules': [_valid_rule(
                rule_id='office_hours', name='Office hours',
                condition=[{'field': 'time_of_day', 'op': 'between', 'values': ['07:00', '09:00']}],
                resulting_priority='high')],
        }
        inside = evaluate_priority(_evidence(created_at='2026-09-18T08:00:00Z'), config)
        self.assertEqual(inside['rule_id'], 'office_hours')
        self.assertEqual(inside['priority'], 'high')
        self.assertEqual(inside['matched_value'], '08:00')

        outside = evaluate_priority(_evidence(created_at='2026-09-18T10:00:00Z'), config)
        self.assertTrue(outside['fallback'])
        self.assertEqual(outside['priority'], 'medium')

    def test_department_equals_requires_a_department(self):
        config = {
            'version': 't',
            'default_priority': 'medium',
            'rules': [_valid_rule(
                rule_id='dept_norm', name='IT default',
                condition=[{'field': 'department', 'op': 'equals', 'value': 'IT'}],
                resulting_priority='low')],
        }
        with_dept = evaluate_priority(_evidence(department='IT'), config)
        self.assertEqual(with_dept['rule_id'], 'dept_norm')
        self.assertEqual(with_dept['priority'], 'low')

        without = evaluate_priority(_evidence(department=None), config)
        self.assertTrue(without['fallback'])
        no_dept_field = evaluate_priority(_evidence(department='Support'), config)
        self.assertTrue(no_dept_field['fallback'])


class PriorityValidationTestCase(unittest.TestCase):
    """.validate_priority_rules rejects anything outside developer boundaries."""

    def test_rejects_invalid_resulting_priority(self):
        ok, errors = validate_priority_rules([_valid_rule(resulting_priority='urgent')])
        self.assertFalse(ok)
        self.assertTrue(any('resulting_priority' in e for e in errors))

    def test_rejects_unknown_field_and_operator(self):
        ok, errors = validate_priority_rules([_valid_rule(
            condition=[{'field': 'hostname', 'op': 'like', 'values': ['x']}])])
        self.assertFalse(ok)
        self.assertTrue(any('field "hostname"' in e for e in errors))
        self.assertTrue(any('op "like"' in e for e in errors))

    def test_rejects_equals_condition_without_value(self):
        ok, errors = validate_priority_rules([_valid_rule(
            condition=[{'field': 'category', 'op': 'equals'}])])
        self.assertFalse(ok)
        self.assertTrue(any('requires a value' in e for e in errors))

    def test_enforces_rule_and_condition_limits(self):
        many_rules = [_valid_rule(rule_id=f'r{i}') for i in range(21)]
        ok, errors = validate_priority_rules(many_rules)
        self.assertFalse(ok)
        self.assertTrue(any('Too many rules' in e for e in errors))

        many_conditions = [_valid_rule(condition=[
            {'field': 'title', 'op': 'contains', 'values': ['a']},
            {'field': 'title', 'op': 'contains', 'values': ['b']},
            {'field': 'title', 'op': 'contains', 'values': ['c']},
            {'field': 'title', 'op': 'contains', 'values': ['d']},
            {'field': 'title', 'op': 'contains', 'values': ['e']},
        ])]
        ok2, errors2 = validate_priority_rules(many_conditions)
        self.assertFalse(ok2)
        self.assertTrue(any('too many conditions' in e for e in errors2))

    def test_rejects_malformed_between_times(self):
        bad_times = [_valid_rule(
            rule_id='bt', condition=[{'field': 'time_of_day', 'op': 'between', 'values': ['07:00']}])]
        ok, errors = validate_priority_rules(bad_times)
        self.assertFalse(ok)
        self.assertTrue(any('exactly two HH:MM' in e for e in errors))

        non_time_field = [_valid_rule(
            rule_id='bt2', condition=[{'field': 'category', 'op': 'between', 'values': ['a', 'b']}])]
        ok2, errors2 = validate_priority_rules(non_time_field)
        self.assertFalse(ok2)
        self.assertTrue(any('between is only valid on time_of_day' in e for e in errors2))


class PriorityRulesApiTestCase(BaseTestCase):
    """Admin CRUD over the seeded rule set. All endpoints are admin-only."""

    def setUp(self):
        super().setUp()
        from schema import seed_priority_rules
        seed_priority_rules()

    def test_get_rules_requires_admin(self):
        r = self.client.get('/api/rules/priority', headers=self.staff_headers())
        self.assertEqual(r.status_code, 403)

    def test_get_rules_returns_config_with_meta(self):
        r = self.client.get('/api/rules/priority', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertEqual(len(data['rules']), len(PRIORITY_DEFAULT_RULES))
        self.assertEqual(data['default_priority'], 'medium')
        self.assertNotEqual(data['version'], 'builtin')
        self.assertEqual(data['meta']['allowed_priorities'], ['low', 'medium', 'high'])
        self.assertIn('time_of_day', data['meta']['allowed_fields'])
        self.assertIn('between', data['meta']['allowed_ops'])
        self.assertEqual(data['meta']['limits']['max_rules'], 20)

    def test_put_rule_updates_values_and_audits(self):
        r = self.client.put('/api/rules/priority/software_issue',
                            json={'resulting_priority': 'high'},
                            headers=self.admin_headers())
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(r.get_json()['rule']['resulting_priority'], 'high')
        rules = build_priority_config()['rules']
        software = next(rr for rr in rules if rr['rule_id'] == 'software_issue')
        self.assertEqual(software['resulting_priority'], 'high')

        audit = AuditLog.query.filter_by(action='priority_rule_updated',
                                         entity_type='priority_rule',
                                         entity_id='software_issue').all()
        self.assertEqual(len(audit), 1)
        details = json.loads(audit[0].details)
        self.assertEqual(details['new_value']['resulting_priority'], 'high')
        self.assertEqual(details['previous_value']['resulting_priority'], 'medium')

    def test_put_rule_rejects_developer_controlled_content(self):
        rename = self.client.put('/api/rules/priority/security_incident',
                                 json={'rule_id': 'hacked'},
                                 headers=self.admin_headers())
        self.assertEqual(rename.status_code, 403)

        change_scope = self.client.put('/api/rules/priority/network_outage',
                                       json={'condition': [
                                           {'field': 'category', 'op': 'equals', 'value': 'Security'},
                                       ]},
                                       headers=self.admin_headers())
        self.assertEqual(change_scope.status_code, 403)

        add_condition = self.client.put('/api/rules/priority/hardware_failure',
                                        json={'condition': [
                                            {'field': 'title_or_description', 'op': 'contains',
                                             'values': ['wont boot']},
                                            {'field': 'title', 'op': 'contains', 'values': ['x']},
                                        ]},
                                        headers=self.admin_headers())
        self.assertEqual(add_condition.status_code, 403)

    def test_put_rule_rejects_unknown_keys_and_bad_types(self):
        unknown = self.client.put('/api/rules/priority/hardware_failure',
                                  json={'surprise': 1},
                                  headers=self.admin_headers())
        self.assertEqual(unknown.status_code, 400)

        bad_bool = self.client.put('/api/rules/priority/hardware_failure',
                                   json={'enabled': 'yes'},
                                   headers=self.admin_headers())
        self.assertEqual(bad_bool.status_code, 400)

        bad_priority = self.client.put('/api/rules/priority/hardware_failure',
                                       json={'resulting_priority': 'urgent'},
                                       headers=self.admin_headers())
        self.assertEqual(bad_priority.status_code, 400)

    def test_reorder_rules_updates_order_and_audits(self):
        current = self.client.get('/api/rules/priority', headers=self.admin_headers()).get_json()
        ids = [r['rule_id'] for r in current['rules']]
        reversed_ids = list(reversed(ids))

        r = self.client.post('/api/rules/priority/reorder',
                             json={'rule_ids': reversed_ids},
                             headers=self.admin_headers())
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(r.get_json()['order'], reversed_ids)

        after = self.client.get('/api/rules/priority', headers=self.admin_headers()).get_json()
        self.assertEqual([rr['rule_id'] for rr in after['rules']], reversed_ids)

        audit = AuditLog.query.filter_by(action='priority_rule_reordered').all()
        self.assertEqual(len(audit), 1)
        self.assertEqual(json.loads(audit[0].details)['new_order'], reversed_ids)

    def test_reset_restores_developer_defaults(self):
        self.client.put('/api/rules/priority/software_issue',
                        json={'resulting_priority': 'high'},
                        headers=self.admin_headers())
        version_after_edit = build_priority_config()['version']

        r = self.client.post('/api/rules/priority/reset', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200, r.get_json())
        data = r.get_json()
        self.assertEqual(len(data['rules']), len(PRIORITY_DEFAULT_RULES))
        software = next(rr for rr in data['rules'] if rr['rule_id'] == 'software_issue')
        self.assertEqual(software['resulting_priority'], 'medium')
        self.assertNotEqual(data['version'], version_after_edit)
        self.assertNotEqual(data['version'], 'builtin')

        audit = AuditLog.query.filter_by(action='priority_rules_reset').all()
        self.assertEqual(len(audit), 1)


class CreateTicketPriorityTestCase(BaseTestCase):
    """Server-side derivation, manual override, and client mirror persistence."""

    def test_server_derives_priority_and_logs_audit(self):
        r = self.client.post('/api/tickets',
                             json={'title': 'No internet on the 2nd floor',
                                   'description': 'Cannot reach the office wifi',
                                   'category': 'other'},
                             headers=self.admin_headers())
        self.assertEqual(r.status_code, 201, r.get_json())
        data = r.get_json()
        self.assertEqual(data['priority'], 'high')
        self.assertEqual(data['priority_source'], 'rule_engine')
        self.assertEqual(data['priority_explanation']['rule_id'], 'network_outage')

        ticket = Ticket.query.filter_by(ticket_number=data['ticket_number']).first()
        self.assertEqual(ticket.priority, 'high')

        audit = AuditLog.query.filter_by(action='priority_derived',
                                         entity_type='ticket').all()
        self.assertEqual(len(audit), 1)
        details = json.loads(audit[0].details)
        self.assertEqual(details['priority'], 'high')
        self.assertEqual(details['source'], 'rule_engine')
        self.assertEqual(details['explanation']['rule_id'], 'network_outage')

    def test_manual_priority_honored_without_audit(self):
        r = self.client.post('/api/tickets',
                             json={'title': 'No internet on the 2nd floor',
                                   'description': 'Cannot reach the office wifi',
                                   'category': 'other',
                                   'priority': 'low',
                                   'priority_source': 'manual'},
                             headers=self.admin_headers())
        self.assertEqual(r.status_code, 201, r.get_json())
        data = r.get_json()
        self.assertEqual(data['priority'], 'low')
        self.assertEqual(data['priority_source'], 'manual')
        self.assertIsNone(data['priority_explanation'])

        audit = AuditLog.query.filter_by(action='priority_derived').all()
        self.assertEqual(len(audit), 0)

    def test_create_row_persists_source_and_explanation(self):
        """G2: what was shown to the user survives on the row, not just in the
        audit log — the UI explainability path depends on the row, not on a
        JS-side mirror re-deriving on every view."""
        r = self.client.post('/api/tickets',
                             json={'title': 'No internet on the 2nd floor',
                                   'description': 'Cannot reach the office wifi',
                                   'category': 'other'},
                             headers=self.admin_headers())
        self.assertEqual(r.status_code, 201, r.get_json())
        data = r.get_json()

        row = Ticket.query.filter_by(
            ticket_number=data['ticket_number']).first()
        self.assertEqual(row.priority, 'high')
        detail = self.client.get(f"/api/tickets/{row.id}",
                                 headers=self.admin_headers())
        self.assertEqual(detail.status_code, 200, detail.get_json())
        d = detail.get_json()
        self.assertEqual(d['priority'], row.priority)
        self.assertEqual(d['priority_source'], row.priority_source)
        self.assertEqual(d['priority_explanation'], row.priority_explanation)
        self.assertEqual(row.priority_source, 'rule_engine')
        self.assertIsNotNone(row.priority_explanation)
        self.assertIn('network', row.priority_explanation.lower())

        detail = self.client.get(f"/api/tickets/{row.id}",
                                 headers=self.admin_headers())
        self.assertEqual(detail.status_code, 200, detail.get_json())
        d = detail.get_json()
        self.assertEqual(d['priority'], row.priority)
        self.assertEqual(d['priority_source'], row.priority_source)
        self.assertEqual(d['priority_explanation'], row.priority_explanation)

    def test_human_triage_override_stamps_manual_and_reaudits(self):
        """G3: a technician/admin change broadcasts 'this is now human set'
        (priority_source='manual') and keeps the prior derivation in the
        explanation so the chain is never lost."""
        r = self.client.post('/api/tickets',
                             json={'title': 'No internet on the 2nd floor',
                                   'description': 'Cannot reach the office wifi',
                                   'category': 'other'},
                             headers=self.admin_headers())
        data = r.get_json()

        row = Ticket.query.filter_by(
            ticket_number=data['ticket_number']).first()

        upd = self.client.put(f"/api/tickets/{row.id}",
                              json={'priority': 'low'},
                              headers=self.admin_headers())
        self.assertEqual(upd.status_code, 200, upd.get_json())

        detail = self.client.get(f"/api/tickets/{row.id}",
                                 headers=self.admin_headers())
        self.assertEqual(detail.status_code, 200, detail.get_json())
        u = detail.get_json()
        self.assertEqual(u['priority'], 'low')
        self.assertEqual(u['priority_source'], 'manual')
        self.assertIsNotNone(u['priority_explanation'])

        row = Ticket.query.filter_by(ticket_number=data['ticket_number']).first()
        self.assertEqual(row.priority_source, 'manual')
        self.assertIn(
            f"Priority manually set to low by {self._admin_username() if hasattr(self, '_admin_username') else 'admin'}",
            row.priority_explanation or '')
        audit = AuditLog.query.filter_by(action='update', entity_type='ticket').all()
        diff_details = json.loads(audit[-1].details)
        self.assertIn('priority', diff_details)
        self.assertEqual(diff_details['priority'],
                         {'from': 'high', 'to': 'low'})

    def test_client_rule_engine_explanation_persisted(self):
        client_explanation = {
            'rule_id': 'client_mirror',
            'priority': 'high',
            'rules_version': 'client-cache-v1',
            'evaluated_at': '2026-09-18T07:59:00+00:00',
            'fallback': False,
        }
        r = self.client.post('/api/tickets',
                             json={'title': 'No internet on the 2nd floor',
                                   'description': 'Cannot reach the office wifi',
                                   'category': 'other',
                                   'priority': 'high',
                                   'priority_source': 'rule_engine',
                                   'priority_explanation': client_explanation},
                             headers=self.admin_headers())
        self.assertEqual(r.status_code, 201, r.get_json())
        data = r.get_json()
        self.assertEqual(data['priority'], 'high')
        self.assertEqual(data['priority_source'], 'rule_engine')

        audit = AuditLog.query.filter_by(action='priority_derived').all()
        self.assertEqual(len(audit), 1)
        details = json.loads(audit[0].details)
        self.assertEqual(details['explanation'], client_explanation)


if __name__ == '__main__':
    unittest.main()