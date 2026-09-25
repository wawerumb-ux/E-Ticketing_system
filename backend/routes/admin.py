"""Admin routes: taxonomy (categories/departments), settings, reporting,
audit logs, API tokens and webhooks."""

import csv
import io
import json
import re
import secrets
from collections import Counter
from datetime import datetime, timedelta

from flask import Blueprint, Response, abort, jsonify, request
from flask_jwt_extended import get_jwt

from extensions import db, utcnow
from helpers import (
    CATEGORY_BY_TYPE,
    DEFAULT_SETTINGS,
    NOTIFICATION_CATEGORIES,
    PRIORITY_ALLOWED,
    PRIORITY_ALLOWED_FIELDS,
    PRIORITY_ALLOWED_OPS,
    PRIORITY_DEFAULT_RULES,
    PRIORITY_RULE_LIMITS,
    SLA_SETTING_KEYS,
    _as_str,
    build_priority_config,
    cache_get,
    cache_key,
    cache_set,
    evaluate_priority,
    format_priority_reason,
    get_setting,
    log_audit,
    role_required,
    validate_priority_rules,
)
from models import (
    ApiToken,
    AuditLog,
    Category,
    Department,
    NotificationCategory,
    PriorityRule,
    Role,
    SystemSetting,
    Ticket,
    TicketComment,
    User,
    Webhook,
)

admin_bp = Blueprint('admin', __name__)


# ============ CATEGORIES ============

@admin_bp.route('/api/categories', methods=['GET'])
def get_categories():
    categories = Category.query.filter_by(is_active=True).order_by(Category.name.asc()).all()
    return jsonify([{'id': c.id, 'name': c.name} for c in categories]), 200


@admin_bp.route('/api/categories', methods=['POST'])
@role_required('admin')
def create_category():
    data = request.json
    name = data.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Category name is required'}), 400
    actor = get_jwt().get('username', 'admin')

    existing = Category.query.filter_by(name=name).first()
    if existing:
        if existing.is_active:
            return jsonify({'error': 'Category already exists'}), 400
        existing.is_active = True
        log_audit(actor, 'reactivate', 'category', existing.id, f"Reactivated category '{name}'")
        db.session.commit()
        return jsonify({'id': existing.id, 'name': existing.name}), 201

    category = Category(name=name)
    db.session.add(category)
    log_audit(actor, 'create', 'category', None, f"Created category '{name}'")
    db.session.commit()
    return jsonify({'id': category.id, 'name': category.name}), 201


@admin_bp.route('/api/categories/<int:category_id>', methods=['DELETE'])
@role_required('admin')
def deactivate_category(category_id):
    category = Category.query.get_or_404(category_id)
    category.is_active = False
    actor = get_jwt().get('username', 'admin')
    log_audit(actor, 'deactivate', 'category', category.id, f"Deactivated category '{category.name}'")
    db.session.commit()
    return jsonify({'message': 'Category deactivated'}), 200


# ============ DEPARTMENTS ============

@admin_bp.route('/api/departments', methods=['GET'])
def get_departments():
    departments = Department.query.filter_by(is_active=True).order_by(Department.name.asc()).all()
    return jsonify([{'id': d.id, 'name': d.name} for d in departments]), 200


@admin_bp.route('/api/departments', methods=['POST'])
@role_required('admin')
def create_department():
    data = request.json
    name = data.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Department name is required'}), 400
    actor = get_jwt().get('username', 'admin')

    existing = Department.query.filter_by(name=name).first()
    if existing:
        if existing.is_active:
            return jsonify({'error': 'Department already exists'}), 400
        existing.is_active = True
        log_audit(actor, 'reactivate', 'department', existing.id, f"Reactivated department '{name}'")
        db.session.commit()
        return jsonify({'id': existing.id, 'name': existing.name}), 201

    department = Department(name=name)
    db.session.add(department)
    log_audit(actor, 'create', 'department', None, f"Created department '{name}'")
    db.session.commit()
    return jsonify({'id': department.id, 'name': department.name}), 201


@admin_bp.route('/api/departments/<int:department_id>', methods=['DELETE'])
@role_required('admin')
def deactivate_department(department_id):
    department = Department.query.get_or_404(department_id)
    department.is_active = False
    actor = get_jwt().get('username', 'admin')
    log_audit(actor, 'deactivate', 'department', department.id, f"Deactivated department '{department.name}'")
    db.session.commit()
    return jsonify({'message': 'Department deactivated'}), 200


# ============ ROLES (classification labels) ============
# Roles are soft-deletable labels referenced by name on User, ticket comments
# and history snapshots. They are never renamed. 'admin' is the only role that
# grants elevated access (checked via the JWT role claim from auth.login); every
# other role behaves like 'staff' — staff-tier endpoints are open to any
# authenticated user, so a custom role is an honest classification, not a
# permission grant.

@admin_bp.route('/api/roles', methods=['GET'])
@role_required('admin')
def get_roles():
    roles = Role.query.order_by(Role.name.asc()).all()
    return jsonify([{'id': r.id, 'name': r.name, 'is_active': r.is_active} for r in roles]), 200


@admin_bp.route('/api/roles', methods=['POST'])
@role_required('admin')
def create_role():
    data = request.json
    name = data.get('name', '').strip().lower()
    if not name:
        return jsonify({'error': 'Role name is required'}), 400
    if len(name) > 20:
        return jsonify({'error': 'Role name must be 20 characters or fewer'}), 400
    actor = get_jwt().get('username', 'admin')

    existing = Role.query.filter_by(name=name).first()
    if existing:
        if existing.is_active:
            return jsonify({'error': 'Role already exists'}), 400
        existing.is_active = True
        log_audit(actor, 'reactivate', 'role', existing.id, f"Reactivated role '{name}'")
        db.session.commit()
        return jsonify({'id': existing.id, 'name': existing.name, 'is_active': True}), 201

    role = Role(name=name)
    db.session.add(role)
    log_audit(actor, 'create', 'role', None, f"Created role '{name}'")
    db.session.commit()
    return jsonify({'id': role.id, 'name': role.name, 'is_active': True}), 201


@admin_bp.route('/api/roles/<int:role_id>', methods=['DELETE'])
@role_required('admin')
def deactivate_role(role_id):
    role = Role.query.get_or_404(role_id)
    if role.name == 'admin':
        return jsonify({'error': 'The admin role cannot be deactivated'}), 400
    role.is_active = False
    actor = get_jwt().get('username', 'admin')
    log_audit(actor, 'deactivate', 'role', role.id, f"Deactivated role '{role.name}'")
    db.session.commit()
    return jsonify({'message': 'Role deactivated'}), 200


# ============ NOTIFICATION CATEGORIES (custom-trigger subsystem) ============
# Rows are soft-deletable via active=False (never hard-deleted — referenced by
# cid on notifications.category and in every user's preference JSON).
# cid is immutable once created (same rule as username). The static built-ins
# in helpers.NOTIFICATION_CATEGORIES remain the migration seed; live rows win.

_ALLOWED_TRIGGERS = {None, 'broadcast'}  # the only real triggers available today (S2)
_ICON_RE = re.compile(r'^[a-z0-9-]{1,30}$')


def _slug_cid(label):
    """Derive a unique, stable cid from a label: lowercase ASCII slug."""
    slug = re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')
    return slug[:40]


def _serialize_category_row(c):
    return {
        'cid': c.cid,
        'label': c.label,
        'description': c.description or '',
        'icon': c.icon or 'bell',
        'role': c.role or 'shared',
        'trigger': c.trigger_type,
        'active': bool(c.active),
        'built_in': c.cid in NOTIFICATION_CATEGORIES,
    }


def _category_row_or_404(cid):
    row = NotificationCategory.query.filter_by(cid=cid).first()
    if row is None:
        # Built-in may be missing only if the seed has not run — surface it as
        # a stable 404 rather than a 500 (registry gaps stay data, not crashes).
        abort(404, description='Unknown notification category')
    return row


def _validate_category_payload(data, partial=False):
    """Validate an admin category payload. Returns (error, cleaned) or (None, {})."""
    cleaned = {}
    if not partial or 'label' in data:
        label = (data.get('label') or '').strip()
        if not label:
            return 'Label is required', None
        if len(label) > 80:
            return 'Label must be 80 characters or fewer', None
        cleaned['label'] = label
    if 'description' in data:
        desc = (data.get('description') or '').strip()
        if len(desc) > 255:
            return 'Description must be 255 characters or fewer', None
        cleaned['description'] = desc
    if 'icon' in data:
        icon = (data.get('icon') or 'bell').strip()
        if not _ICON_RE.match(icon):
            return 'Icon must be a lowercase slug (a-z, 0-9, -), max 30 chars', None
        cleaned['icon'] = icon
    if 'role' in data:
        role = (data.get('role') or 'shared').strip().lower()
        if role not in ('shared', 'admin'):
            return "role must be 'shared' or 'admin'", None
        cleaned['role'] = role
    if 'trigger' in data:
        trigger = data.get('trigger') or None
        if trigger not in _ALLOWED_TRIGGERS:
            return "trigger must be 'broadcast' or null (only real triggers today)", None
        cleaned['trigger'] = trigger
    if 'active' in data:
        cleaned['active'] = bool(data.get('active'))
    return None, cleaned


@admin_bp.route('/api/notification-categories', methods=['GET'])
@role_required('admin')
def get_notification_categories():
    rows = NotificationCategory.query.order_by(NotificationCategory.cid.asc()).all()
    known = {r.cid for r in rows}
    out = [_serialize_category_row(r) for r in rows]
    # Surface any static built-in not yet seeded (migration edge) so the admin
    # list always matches what users can see.
    for cid, meta in NOTIFICATION_CATEGORIES.items():
        if cid not in known:
            trigger = next((v for v, c in CATEGORY_BY_TYPE.items() if c == cid), None)
            out.append({
                'cid': cid,
                'label': meta.get('label', cid),
                'description': meta.get('description', ''),
                'icon': meta.get('icon', 'bell'),
                'role': meta.get('role', 'shared'),
                'trigger': trigger,
                'active': bool(meta.get('active', True)),
                'built_in': True,
            })
    out.sort(key=lambda c: c['cid'])
    return jsonify(out), 200


@admin_bp.route('/api/notification-categories', methods=['POST'])
@role_required('admin')
def create_notification_category():
    data = request.json or {}
    error, cleaned = _validate_category_payload(data)
    if error:
        return jsonify({'error': error}), 400
    actor = get_jwt().get('username', 'admin')

    cid = _slug_cid(cleaned['label'])
    if not cid:
        return jsonify({'error': 'Label must contain at least one letter or digit'}), 400

    existing = NotificationCategory.query.filter_by(cid=cid).first()
    if existing:
        if existing.active:
            return jsonify({'error': f"A category with id '{cid}' already exists"}), 400
        existing.active = True
        for key in ('label', 'description', 'icon', 'role'):
            if key in cleaned:
                setattr(existing, key, cleaned[key])
        if 'trigger' in cleaned:
            existing.trigger_type = cleaned['trigger']
        log_audit(actor, 'reactivate', 'notification_category', existing.cid,
                  f"Reactivated notification category '{existing.label}'")
        db.session.commit()
        return jsonify(_serialize_category_row(existing)), 201

    row = NotificationCategory(
        cid=cid,
        label=cleaned['label'],
        description=cleaned.get('description', ''),
        icon=cleaned.get('icon', 'bell'),
        role=cleaned.get('role', 'shared'),
        trigger_type=cleaned.get('trigger', 'broadcast'),
        active=cleaned.get('active', True),
    )
    db.session.add(row)
    log_audit(actor, 'create', 'notification_category', cid,
              f"Created notification category '{row.label}' (trigger={row.trigger_type}, role={row.role})")
    db.session.commit()
    return jsonify(_serialize_category_row(row)), 201


@admin_bp.route('/api/notification-categories/<cid>', methods=['PUT'])
@role_required('admin')
def update_notification_category(cid):
    row = _category_row_or_404(cid)
    data = request.json or {}
    if 'label' in data:
        new_label = (data.get('label') or '').strip()
        if not new_label:
            return jsonify({'error': 'Label is required'}), 400
        if _slug_cid(new_label) != row.cid:
            return jsonify({'error': 'Label cannot change the category id (cid is immutable)'}), 400
    error, cleaned = _validate_category_payload(data, partial=True)
    if error:
        return jsonify({'error': error}), 400

    diff = {}
    for key, value in cleaned.items():
        current = getattr(row, 'trigger_type' if key == 'trigger' else key)
        if current != value:
            diff[key] = {'from': current, 'to': value}
            setattr(row, 'trigger_type' if key == 'trigger' else key, value)
    if diff:
        log_audit(actor := get_jwt().get('username', 'admin'),
                  'update', 'notification_category', row.cid, json.dumps(diff, default=str))
        db.session.commit()
    return jsonify(_serialize_category_row(row)), 200


@admin_bp.route('/api/notification-categories/<cid>', methods=['DELETE'])
@role_required('admin')
def deactivate_notification_category(cid):
    row = _category_row_or_404(cid)
    row.active = False
    actor = get_jwt().get('username', 'admin')
    log_audit(actor, 'deactivate', 'notification_category', row.cid,
              f"Deactivated notification category '{row.label}'")
    db.session.commit()
    return jsonify({'message': 'Notification category deactivated'}), 200


# ============ SETTINGS ============

@admin_bp.route('/api/settings', methods=['GET'])
@role_required('admin')
def get_settings():
    settings = {s.key: s.value for s in SystemSetting.query.all()}
    for key, value in DEFAULT_SETTINGS.items():
        settings.setdefault(key, value)
    return jsonify(settings), 200


@admin_bp.route('/api/settings', methods=['PUT'])
@role_required('admin')
def update_settings():
    data = request.json or {}
    actor = get_jwt().get('username', 'admin')

    updates = {k: str(v).strip() for k, v in data.items() if k in SLA_SETTING_KEYS}
    if not updates:
        return jsonify({'error': 'No valid settings provided'}), 400

    for k, v in updates.items():
        if k.startswith('sla_') and k != 'sla_auto_escalate':
            try:
                if int(v) <= 0:
                    raise ValueError
            except ValueError:
                return jsonify({'error': f'{k} must be a positive integer'}), 400

    old = {k: get_setting(k) for k in updates}
    for k, v in updates.items():
        setting = SystemSetting.query.get(k)
        if setting:
            setting.value = v
        else:
            db.session.add(SystemSetting(key=k, value=v))

    diff = {k: {'from': old[k], 'to': updates[k]} for k in updates}
    log_audit(actor, 'update', 'setting', None, json.dumps(diff))
    db.session.commit()
    return jsonify({'message': 'Settings updated successfully', 'settings': updates}), 200


# ============ PRIORITY RULES (configurable ticket priority engine) ============

def _serialize_priority_rule(row):
    return {
        'rule_id': row.rule_id,
        'name': row.name,
        'enabled': bool(row.enabled),
        'condition': json.loads(row.condition_json) if row.condition_json else [],
        'resulting_priority': row.resulting_priority,
        'stop': bool(row.stop),
        'explanation_template': row.explanation_template,
        'sort_order': row.sort_order,
    }


@admin_bp.route('/api/rules/priority', methods=['GET'])
@role_required('admin')
def get_priority_rules():
    """Full rule configuration plus the developer surfaces an admin may edit."""
    config = build_priority_config()
    return jsonify({
        'rules': config['rules'],
        'default_priority': config['default_priority'],
        'version': config['version'],
        'meta': {
            'allowed_priorities': list(PRIORITY_ALLOWED),
            'allowed_fields': list(PRIORITY_ALLOWED_FIELDS),
            'allowed_ops': list(PRIORITY_ALLOWED_OPS),
            'limits': PRIORITY_RULE_LIMITS,
        },
    }), 200


@admin_bp.route('/api/rules/priority/preview', methods=['POST'])
@role_required('admin')
def preview_priority_rules():
    """Evaluate sample evidence against the current (or a candidate) config.

    Read-only test mode: accepts ``evidence`` (title, description, category,
    department, role, created_at) and an optional ``candidate`` rules list in
    the same shape the client mirror uses. If ``candidate`` is supplied it is
    validated as a whole (401/400 on developer-boundary violation) and used
    for the preview; otherwise the current live config is used. Nothing is
    persisted and nothing is audited — this is a dry run.
    """
    data = request.json or {}
    ev = data.get('evidence') if isinstance(data.get('evidence'), dict) else data
    evidence = {
        'title': str(ev.get('title', '')),
        'description': str(ev.get('description', '')),
        'category': str(ev.get('category', '')),
        'department': ev.get('department') or None,
        'role': ev.get('role') or 'staff',
        'created_at': ev.get('created_at') or utcnow(),
    }

    candidate = data.get('candidate')
    if candidate is not None:
        if not isinstance(candidate, list):
            return jsonify({'error': 'candidate must be a list of rule objects'}), 400
        ok, errors = validate_priority_rules(candidate)
        if not ok:
            return jsonify({'error': 'Invalid candidate config: ' + '; '.join(errors[:5])}), 400
        config = {
            'rules': candidate,
            'default_priority': data.get('default_priority', PRIORITY_ALLOWED[1]),
            'version': data.get('version') or 'candidate',
        }
    else:
        config = build_priority_config()

    result = evaluate_priority(evidence, config)
    result['explanation'] = format_priority_reason(result)
    return jsonify(result), 200


@admin_bp.route('/api/rules/priority/<rule_id>', methods=['PUT'])
@role_required('admin')
def update_priority_rule(rule_id):
    """Adjust an existing rule within the developer's boundaries.

    Admins may change: enabled, stop, resulting_priority (within the allowed
    set) and condition **values**. Shape (rule_id, name, condition field/op,
    condition count, default_priority) is developer-governed — attempting to
    change it is rejected with 403, never silently ignored.
    """
    row = PriorityRule.query.filter_by(rule_id=rule_id).first_or_404()
    data = request.json or {}
    actor = get_jwt().get('username', 'admin')

    restricted = set(data) & {'rule_id', 'name', 'field', 'op', 'default_priority'}
    if restricted:
        return jsonify({'error': 'Developer-controlled setting(s) cannot be edited: '
                                  f'{", ".join(sorted(restricted))}'}), 403

    allowed = {'enabled', 'condition', 'resulting_priority', 'stop'}
    unknown = set(data) - allowed
    if unknown:
        return jsonify({'error': 'Unknown setting(s): ' + ', '.join(sorted(unknown))}), 400

    old = _serialize_priority_rule(row)
    current_condition = json.loads(row.condition_json) if row.condition_json else []

    if 'condition' in data:
        if not isinstance(data['condition'], list):
            return jsonify({'error': 'condition must be a list of condition objects'}), 400
        if len(data['condition']) != len(current_condition):
            return jsonify({'error': 'The number of conditions is developer-controlled'}), 403
        for new_cond, old_cond in zip(data['condition'], current_condition):
            if not isinstance(new_cond, dict):
                return jsonify({'error': 'each condition must be an object'}), 400
            if (new_cond.get('field'), new_cond.get('op')) != (old_cond.get('field'), old_cond.get('op')):
                return jsonify({'error': 'Condition fields and operators are developer-controlled'}), 403

    if 'enabled' in data and not isinstance(data['enabled'], bool):
        return jsonify({'error': 'enabled must be true or false'}), 400
    if 'stop' in data and not isinstance(data['stop'], bool):
        return jsonify({'error': 'stop must be true or false'}), 400
    if 'resulting_priority' in data and data['resulting_priority'] not in PRIORITY_ALLOWED:
        return jsonify({'error': 'resulting_priority must be one of low, medium, high'}), 400

    preview = _serialize_priority_rule(row)
    if 'enabled' in data:
        preview['enabled'] = data['enabled']
    if 'stop' in data:
        preview['stop'] = data['stop']
    if 'resulting_priority' in data:
        preview['resulting_priority'] = data['resulting_priority']
    if 'condition' in data:
        preview['condition'] = data['condition']

    assembled = [
        preview if r['rule_id'] == rule_id else r
        for r in build_priority_config()['rules']
    ]
    ok, errors = validate_priority_rules(assembled)
    if not ok:
        return jsonify({'error': 'Invalid rule configuration: ' + '; '.join(errors[:5])}), 400

    if 'enabled' in data:
        row.enabled = data['enabled']
    if 'stop' in data:
        row.stop = data['stop']
    if 'resulting_priority' in data:
        row.resulting_priority = data['resulting_priority']
    if 'condition' in data:
        row.condition_json = json.dumps(data['condition'])
    row.updated_at = utcnow()
    new = _serialize_priority_rule(row)

    action = 'priority_rule_updated'
    if 'enabled' in data:
        action = 'priority_rule_enabled' if data['enabled'] else 'priority_rule_disabled'
    log_audit(actor, action, 'priority_rule', rule_id,
              json.dumps({'previous_value': old, 'new_value': new}))
    db.session.commit()
    return jsonify({'message': 'Priority rule updated', 'rule': new}), 200


@admin_bp.route('/api/rules/priority/reorder', methods=['POST'])
@role_required('admin')
def reorder_priority_rules():
    """Replace the full ordering — a complete permutation of rule ids."""
    data = request.json or {}
    ordered_ids = data.get('rule_ids')
    if not isinstance(ordered_ids, list) or not ordered_ids:
        return jsonify({'error': 'rule_ids must be a non-empty list'}), 400
    if len(ordered_ids) != len(set(ordered_ids)):
        return jsonify({'error': 'rule_ids must not contain duplicates'}), 400

    rows = PriorityRule.query.all()
    by_id = {r.rule_id: r for r in rows}
    if set(ordered_ids) != set(by_id):
        return jsonify({'error': 'rule_ids must contain exactly the current rule ids'}), 400

    previous = [r.rule_id for r in sorted(rows, key=lambda r: r.sort_order)]
    actor = get_jwt().get('username', 'admin')
    for position, rule_id in enumerate(ordered_ids):
        by_id[rule_id].sort_order = position + 1
    log_audit(actor, 'priority_rule_reordered', 'priority_rule', None,
              json.dumps({'previous_order': previous, 'new_order': ordered_ids}))
    db.session.commit()
    return jsonify({'message': 'Priority rules reordered', 'order': ordered_ids}), 200


@admin_bp.route('/api/rules/priority/reset', methods=['POST'])
@role_required('admin')
def reset_priority_rules():
    """Restore the developer-defined default rule set."""
    actor = get_jwt().get('username', 'admin')
    previous_version = build_priority_config().get('version')

    PriorityRule.query.delete()
    for order, rule in enumerate(PRIORITY_DEFAULT_RULES):
        db.session.add(PriorityRule(
            rule_id=rule['rule_id'],
            name=rule['name'],
            enabled=rule['enabled'],
            condition_json=json.dumps(rule['condition']),
            resulting_priority=rule['resulting_priority'],
            stop=rule['stop'],
            explanation_template=rule['explanation_template'],
            sort_order=order + 1,
        ))
    db.session.commit()

    new_config = build_priority_config()
    log_audit(actor, 'priority_rules_reset', 'priority_rule', 'all',
              json.dumps({'previous_config_version': previous_version,
                          'new_config_version': new_config.get('version'),
                          'rules': new_config.get('rules')}))
    db.session.commit()
    return jsonify({
        'message': 'Priority rules reset to developer defaults',
        'rules': new_config['rules'],
        'default_priority': new_config['default_priority'],
        'version': new_config['version'],
    }), 200


# ============ REPORTING & ANALYTICS ============

def _report_range(args):
    since = until = None
    try:
        since = datetime.strptime(args.get('from', ''), '%Y-%m-%d') if args.get('from') else None
    except ValueError:
        since = 'invalid'
    try:
        until = datetime.strptime(args.get('to', ''), '%Y-%m-%d') if args.get('to') else None
    except ValueError:
        until = 'invalid'
    if since == 'invalid' or until == 'invalid':
        return None, None, 'Dates must use YYYY-MM-DD format'
    if until:
        until = until + timedelta(days=1)
    if since and until and since >= until:
        return None, None, 'from must be before to'
    return since, until, None


@admin_bp.route('/api/reports/summary', methods=['GET'])
@role_required('admin')
def reports_summary():
    since, until, err = _report_range(request.args)
    if err:
        return jsonify({'error': err}), 400

    query = Ticket.query
    if since:
        query = query.filter(Ticket.created_at >= since)
    if until:
        query = query.filter(Ticket.created_at < until)
    tickets = query.all()

    now = utcnow()
    total = len(tickets)
    open_tickets = sum(1 for t in tickets if t.status in ('open', 'in_progress'))
    resolved = sum(1 for t in tickets if t.status == 'resolved')
    active = [t for t in tickets if t.status in ('open', 'in_progress')]

    resolution_times = [
        (t.updated_at - t.created_at).total_seconds() / 3600.0
        for t in tickets
        if t.status == 'resolved' and t.created_at and t.updated_at
        and t.updated_at >= t.created_at
    ]
    avg_resolution_hours = round(sum(resolution_times) / len(resolution_times), 2) if resolution_times else None

    response_times = []
    for t in tickets:
        if not t.created_at:
            continue
        first = TicketComment.query.filter_by(ticket_id=t.id).order_by(TicketComment.created_at.asc()).first()
        if first and first.created_at >= t.created_at:
            response_times.append((first.created_at - t.created_at).total_seconds() / 3600.0)
    avg_response_hours = round(sum(response_times) / len(response_times), 2) if response_times else None

    response_breaches = sum(1 for t in active if t.sla_response_due and now > t.sla_response_due)
    resolution_breaches = sum(1 for t in active if t.sla_resolution_due and now > t.sla_resolution_due)

    category_breakdown = {}
    priority_breakdown = {}
    technician_stats = {}
    for t in tickets:
        category_breakdown[t.category] = category_breakdown.get(t.category, 0) + 1
        priority_breakdown[t.priority] = priority_breakdown.get(t.priority, 0) + 1
        if t.assigned_to:
            stat = technician_stats.setdefault(t.assigned_to, {'assigned': 0, 'resolved': 0, 'in_progress': 0})
            stat['assigned'] += 1
            if t.status == 'resolved':
                stat['resolved'] += 1
            elif t.status == 'in_progress':
                stat['in_progress'] += 1

    day0 = since.date() if since else (utcnow() - timedelta(days=29)).date()
    day_end = (until.date() if until else utcnow().date())
    if day_end < day0:
        day0 = day_end
    created_by_day = Counter(t.created_at.date() for t in tickets if t.created_at)
    resolved_by_day = Counter(t.updated_at.date() for t in tickets
                              if t.status == 'resolved' and t.updated_at)
    daily, cursor = [], day0
    while cursor <= day_end:
        daily.append({'date': cursor.isoformat(),
                      'created': created_by_day.get(cursor, 0),
                      'resolved': resolved_by_day.get(cursor, 0)})
        cursor += timedelta(days=1)

    return jsonify({
        'period': {'from': request.args.get('from'), 'to': request.args.get('to'), 'total': total},
        'daily': daily,
        'totals': {
            'total': total,
            'open': open_tickets,
            'resolved': resolved,
            'resolution_rate_pct': round(resolved / total * 100, 1) if total else 0,
        },
        'avg_response_hours': avg_response_hours,
        'avg_resolution_hours': avg_resolution_hours,
        'sla': {
            'active_in_period': len(active),
            'response_breaches': response_breaches,
            'resolution_breaches': resolution_breaches,
        },
        'categories': [{'category': k, 'count': v} for k, v in sorted(category_breakdown.items())],
        'priorities': [{'priority': k, 'count': v} for k, v in sorted(priority_breakdown.items())],
        'technicians': [{'username': u, **s} for u, s in sorted(technician_stats.items())],
    }), 200


def _csv_response(headers, rows, filename):
    output = io.StringIO()
    output.write('\ufeff')  # UTF-8 BOM so Excel renders it correctly
    writer = csv.writer(output)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    payload = output.getvalue().encode('utf-8')
    return _csv_response_payload(payload, filename)


def _csv_response_payload(payload, filename):
    return Response(
        payload,
        mimetype='text/csv',
        headers={'Content-Disposition': f'attachment; filename={filename}'},
    )


CSV_EXPORT_TTL_S = 300


@admin_bp.route('/api/reports/export/tickets.csv', methods=['GET'])
@role_required('admin')
def export_tickets_csv():
    since, until, err = _report_range(request.args)
    if err:
        return jsonify({'error': err}), 400
    key = cache_key('export', 'tickets', request.args.get('from'), request.args.get('to'))
    payload = cache_get(key)
    if payload is not None:
        return _csv_response_payload(payload, 'tickets.csv')
    query = Ticket.query
    if since:
        query = query.filter(Ticket.created_at >= since)
    if until:
        query = query.filter(Ticket.created_at < until)

    fmt = lambda dt: dt.isoformat() if dt else ''
    resp = _csv_response(
        ['id', 'ticket_number', 'title', 'category', 'priority', 'status',
         'assigned_to', 'created_by', 'created_at', 'updated_at', 'resolution',
         'sla_response_due', 'sla_resolution_due'],
        [[t.id, t.ticket_number, t.title, t.category, t.priority, t.status,
          t.assigned_to, t.created_by, fmt(t.created_at), fmt(t.updated_at),
          t.resolution, fmt(t.sla_response_due), fmt(t.sla_resolution_due)]
         for t in query.all()],
        'tickets.csv',
    )
    cache_set(key, resp.get_data(), CSV_EXPORT_TTL_S)
    return resp


@admin_bp.route('/api/reports/export/users.csv', methods=['GET'])
@role_required('admin')
def export_users_csv():
    key = cache_key('export', 'users')
    payload = cache_get(key)
    if payload is not None:
        return _csv_response_payload(payload, 'users.csv')
    fmt = lambda dt: dt.isoformat() if dt else ''
    resp = _csv_response(
        ['id', 'username', 'email', 'role', 'department', 'is_active'],
        [[u.id, u.username, u.email, u.role, u.department, u.is_active] for u in User.query.all()],
        'users.csv',
    )
    cache_set(key, resp.get_data(), CSV_EXPORT_TTL_S)
    return resp


@admin_bp.route('/api/reports/export/audit.csv', methods=['GET'])
@role_required('admin')
def export_audit_csv():
    key = cache_key('export', 'audit')
    payload = cache_get(key)
    if payload is not None:
        return _csv_response_payload(payload, 'audit.csv')
    fmt = lambda dt: dt.isoformat() if dt else ''
    resp = _csv_response(
        ['id', 'actor', 'action', 'entity_type', 'entity_id', 'details', 'created_at'],
        [[a.id, a.actor, a.action, a.entity_type, a.entity_id, a.details, fmt(a.created_at)]
         for a in AuditLog.query.order_by(AuditLog.id.desc()).all()],
        'audit.csv',
    )
    cache_set(key, resp.get_data(), CSV_EXPORT_TTL_S)
    return resp


# ============ AUDIT LOGS ============

@admin_bp.route('/api/audit/logs', methods=['GET'])
@role_required('admin')
def get_audit_logs():
    query = AuditLog.query
    entity = request.args.get('entity')
    action = request.args.get('action')
    if entity:
        query = query.filter_by(entity_type=entity)
    if action:
        query = query.filter_by(action=action)
    logs = query.order_by(AuditLog.created_at.desc()).limit(300).all()
    return jsonify([{
        'id': l.id,
        'actor': l.actor,
        'action': l.action,
        'entity_type': l.entity_type,
        'entity_id': l.entity_id,
        'details': l.details,
        'created_at': l.created_at.isoformat() if l.created_at else None,
    } for l in logs]), 200


@admin_bp.route('/api/audit/logs', methods=['DELETE'])
@role_required('admin')
def clear_audit_logs():
    """Clear the audit trail. Deliberate housekeeping only."""
    actor = get_jwt().get('username', 'admin')
    count = AuditLog.query.count()
    AuditLog.query.delete()
    log_audit(actor, 'clear_audit_log', 'audit', None, f"Cleared {count} audit log entries")
    db.session.commit()
    return jsonify({'message': f'Cleared {count} audit log entries'}), 200


# ============ API TOKENS ============

@admin_bp.route('/api/tokens', methods=['GET'])
@role_required('admin')
def list_api_tokens():
    rows = ApiToken.query.all()
    return jsonify([{'id': t.id, 'name': t.name, 'token_prefix': t.token_prefix,
                     'scopes': t.scopes, 'is_active': t.is_active,
                     'expires_at': t.expires_at.isoformat() if t.expires_at else None,
                     'created_at': t.created_at.isoformat(),
                     'last_used_at': t.last_used_at.isoformat() if t.last_used_at else None}
                    for t in rows]), 200


@admin_bp.route('/api/tokens', methods=['POST'])
@role_required('admin')
def create_api_token():
    from helpers import _hash_token
    data = request.json or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Token name is required'}), 400
    raw = 'ict_' + secrets.token_urlsafe(32)
    days = data.get('expires_in_days')
    expires_at = None
    if days:
        try:
            expires_at = utcnow() + timedelta(days=int(days))
        except (TypeError, ValueError):
            return jsonify({'error': 'expires_in_days must be a number'}), 400
    row = ApiToken(name=name, token_hash=_hash_token(raw), token_prefix=raw[:11],
                   scopes=(data.get('scopes') or 'read'),
                   expires_at=expires_at, is_active=True)
    db.session.add(row)
    log_audit(get_jwt().get('username', 'admin'), 'create', 'api_token', name)
    db.session.commit()
    return jsonify({'id': row.id, 'name': name, 'token': raw,
                    'message': 'Store this token now — it will not be shown again.'}), 201


@admin_bp.route('/api/tokens/<int:token_id>', methods=['DELETE'])
@role_required('admin')
def revoke_api_token(token_id):
    row = ApiToken.query.get_or_404(token_id)
    row.is_active = False
    log_audit(get_jwt().get('username', 'admin'), 'revoke', 'api_token', row.name)
    db.session.commit()
    return jsonify({'message': 'Token revoked'}), 200


# ============ WEBHOOKS ============

@admin_bp.route('/api/webhooks', methods=['GET'])
@role_required('admin')
def list_webhooks():
    rows = Webhook.query.all()
    return jsonify([{'id': w.id, 'name': w.name, 'url': w.url,
                     'events': w.events, 'secret_masked': bool(w.secret),
                     'is_active': w.is_active,
                     'created_at': w.created_at.isoformat()} for w in rows]), 200


@admin_bp.route('/api/webhooks', methods=['POST'])
@role_required('admin')
def create_webhook():
    data = request.json or {}
    url = (data.get('url') or '').strip()
    name = (data.get('name') or '').strip()
    events = (data.get('events') or 'ticket.created,ticket.updated')
    if not url.startswith('https://') and not url.startswith('http://'):
        return jsonify({'error': 'URL must start with http(s)://'}), 400
    wh = Webhook(name=name or url, url=url, events=str(events),
                 secret=data.get('secret') or '', is_active=True)
    db.session.add(wh)
    log_audit(get_jwt().get('username', 'admin'), 'create', 'webhook', wh.name)
    db.session.commit()
    return jsonify({'id': wh.id, 'name': wh.name, 'url': wh.url,
                    'events': wh.events, 'is_active': True}), 201


@admin_bp.route('/api/webhooks/<int:webhook_id>', methods=['PUT'])
@role_required('admin')
def update_webhook(webhook_id):
    wh = Webhook.query.get_or_404(webhook_id)
    data = request.json or {}
    if 'url' in data:
        wh.url = data['url'].strip()
        if not wh.url.startswith('http://') and not wh.url.startswith('https://'):
            return jsonify({'error': 'URL must start with http(s)://'}), 400
    if 'events' in data:
        wh.events = str(data['events'])
    if 'name' in data:
        wh.name = data['name'].strip() or wh.url
    if 'secret' in data:
        wh.secret = data['secret']
    if 'is_active' in data:
        wh.is_active = bool(data['is_active'])
    log_audit(get_jwt().get('username', 'admin'), 'update', 'webhook', wh.name)
    db.session.commit()
    return jsonify({'id': wh.id, 'name': wh.name, 'url': wh.url,
                    'events': wh.events, 'is_active': wh.is_active}), 200


@admin_bp.route('/api/webhooks/<int:webhook_id>', methods=['DELETE'])
@role_required('admin')
def delete_webhook(webhook_id):
    wh = Webhook.query.get_or_404(webhook_id)
    name = wh.name
    db.session.delete(wh)
    log_audit(get_jwt().get('username', 'admin'), 'delete', 'webhook', name)
    db.session.commit()
    return jsonify({'message': 'Webhook deleted'}), 200
