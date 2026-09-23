"""Schema migration helpers and seed-data bootstrap.

Live-schema backfills (ensure_*_schema) add missing columns on existing MySQL
tables so older installs work with the current code.  seed_* functions create
the starter data on a fresh database.  ``bootstrap_database()`` is the single
entry point called by docker-entrypoint and the ``__main__`` block in app.py.

Every public function in this module is safe to call either inside an
application context (the normal request/CLI path) or without one (one-shot
scripts, ``python -c "from app import bootstrap_database"``).  The
``_with_app_context`` decorator pushes a temporary context when one isn't
already present so Flask-SQLAlchemy works immediately.
"""

from functools import wraps
import json

from flask import has_app_context
from sqlalchemy import text as sqla_text
from extensions import db, logger
from models import (
    Category,
    Department,
    KnowledgeArticle,
    NotificationCategory,
    PriorityRule,
    Role,
    ShowcasePage,
    User,
)


def _with_app_context(fn):
    """Decorator: push a temporary app context when none is already active."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if has_app_context():
            return fn(*args, **kwargs)
        from app import app as _app
        ctx = _app.app_context()
        ctx.push()
        try:
            return fn(*args, **kwargs)
        finally:
            ctx.pop()
    return wrapper


@_with_app_context
def ensure_user_schema():
    """Add missing columns to existing user tables."""
    try:
        inspector = db.inspect(db.engine)
        if 'users' not in inspector.get_table_names():
            return
        columns = {col['name'] for col in inspector.get_columns('users')}
        with db.engine.begin() as connection:
            if 'is_active' not in columns:
                connection.execute(sqla_text('ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT TRUE'))
                logger.info('Added missing users.is_active column to existing schema')
            if 'token_version' not in columns:
                connection.execute(sqla_text('ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0'))
                logger.info('Added missing users.token_version column to existing schema')
    except Exception as exc:
        logger.warning(f'Could not ensure users schema compatibility: {exc}')


@_with_app_context
def ensure_phase3_schema():
    """Backfill knowledge_articles columns."""
    try:
        inspector = db.inspect(db.engine)
        if 'knowledge_articles' not in inspector.get_table_names():
            return
        columns = {col['name'] for col in inspector.get_columns('knowledge_articles')}
        with db.engine.begin() as connection:
            if 'author_username' not in columns:
                connection.execute(sqla_text('ALTER TABLE knowledge_articles ADD COLUMN author_username VARCHAR(100)'))
            if 'is_published' not in columns:
                connection.execute(sqla_text('ALTER TABLE knowledge_articles ADD COLUMN is_published BOOLEAN DEFAULT TRUE'))
            if 'updated_at' not in columns:
                connection.execute(sqla_text('ALTER TABLE knowledge_articles ADD COLUMN updated_at DATETIME'))
        existing = KnowledgeArticle.query.filter_by(author_username=None).all()
        for art in existing:
            art.author_username = 'admin'
            if art.updated_at is None:
                art.updated_at = art.created_at
        if existing:
            db.session.commit()
            logger.info('Backfilled knowledge article author/updated fields')
    except Exception as exc:
        logger.warning(f'Could not ensure phase3 schema compatibility: {exc}')


@_with_app_context
def ensure_phase4_schema():
    """Add Phase 4 columns (2FA, SLA breach flag, client UUID, API token fields)."""
    try:
        inspector = db.inspect(db.engine)
        with db.engine.begin() as connection:
            if 'users' in inspector.get_table_names():
                ucols = {col['name'] for col in inspector.get_columns('users')}
                if 'totp_secret' not in ucols:
                    connection.execute(sqla_text('ALTER TABLE users ADD COLUMN totp_secret VARCHAR(64)'))
                if 'totp_enabled' not in ucols:
                    connection.execute(sqla_text('ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN DEFAULT FALSE'))
            if 'tickets' in inspector.get_table_names():
                tcols = {col['name'] for col in inspector.get_columns('tickets')}
                if 'sla_response_due' not in tcols:
                    connection.execute(sqla_text('ALTER TABLE tickets ADD COLUMN sla_response_due DATETIME'))
                if 'sla_resolution_due' not in tcols:
                    connection.execute(sqla_text('ALTER TABLE tickets ADD COLUMN sla_resolution_due DATETIME'))
                if 'sla_breach_notified' not in tcols:
                    connection.execute(sqla_text('ALTER TABLE tickets ADD COLUMN sla_breach_notified BOOLEAN DEFAULT FALSE'))
                if 'client_uuid' not in tcols:
                    connection.execute(sqla_text('ALTER TABLE tickets ADD COLUMN client_uuid VARCHAR(36) UNIQUE'))
            if 'api_tokens' in inspector.get_table_names():
                acols = {col['name'] for col in inspector.get_columns('api_tokens')}
                if 'scopes' not in acols:
                    connection.execute(sqla_text('ALTER TABLE api_tokens ADD COLUMN scopes VARCHAR(100) DEFAULT "read"'))
                if 'expires_at' not in acols:
                    connection.execute(sqla_text('ALTER TABLE api_tokens ADD COLUMN expires_at DATETIME'))
        logger.info('Phase 4 schema compatibility verified')
    except Exception as exc:
        logger.warning(f'Could not ensure phase4 schema compatibility: {exc}')


@_with_app_context
def ensure_notification_prefs_schema():
    """Add the per-category JSON column to existing notification_preferences
    tables (MySQL only needs the ALTER; fresh installs get it from the model)."""
    try:
        inspector = db.inspect(db.engine)
        if 'notification_preferences' not in inspector.get_table_names():
            return
        columns = {col['name'] for col in inspector.get_columns('notification_preferences')}
        if 'categories' not in columns:
            with db.engine.begin() as connection:
                connection.execute(sqla_text('ALTER TABLE notification_preferences ADD COLUMN categories JSON'))
            logger.info('Added missing notification_preferences.categories column to existing schema')
    except Exception as exc:
        logger.warning(f'Could not ensure notification preferences schema compatibility: {exc}')


@_with_app_context
def ensure_offline_comments_schema():
    """Add client_uuid to ticket_comments for idempotent offline comment replay.

    NULL is allowed and duplicate NULLs remain permissible (like tickets), so
    legacy rows (which never had a UUID) are untouched.
    """
    try:
        inspector = db.inspect(db.engine)
        if 'ticket_comments' not in inspector.get_table_names():
            return
        columns = {col['name'] for col in inspector.get_columns('ticket_comments')}
        if 'client_uuid' not in columns:
            with db.engine.begin() as connection:
                connection.execute(sqla_text('ALTER TABLE ticket_comments ADD COLUMN client_uuid VARCHAR(36) UNIQUE'))
            logger.info('Added missing ticket_comments.client_uuid column to existing schema')
    except Exception as exc:
        logger.warning(f'Could not ensure ticket comments schema compatibility: {exc}')


@_with_app_context
def ensure_priority_rules_schema():
    """Create the priority_rules table on engines that predate it.

    New installs get it from ``db.create_all()``; this guard covers a live
    database whose schema was built before the PriorityRule model existed.
    """
    try:
        inspector = db.inspect(db.engine)
        if 'priority_rules' in inspector.get_table_names():
            return
        PriorityRule.__table__.create(db.engine)
        logger.info('Created priority_rules table to match the current schema')
    except Exception as exc:
        logger.warning(f'Could not ensure priority rules schema compatibility: {exc}')


@_with_app_context
def ensure_showcase_schema():
    """Create the showcase_pages table on engines that predate it.

    New installs get it from ``db.create_all()``; this guard covers a live
    database whose schema was built before the ShowcasePage model existed.
    """
    try:
        inspector = db.inspect(db.engine)
        if 'showcase_pages' in inspector.get_table_names():
            return
        ShowcasePage.__table__.create(db.engine)
        logger.info('Created showcase_pages table to match the current schema')
    except Exception as exc:
        logger.warning(f'Could not ensure showcase schema compatibility: {exc}')


@_with_app_context
def ensure_notification_categories_schema():
    """Create the notification_categories table and add notifications.category.

    New installs get the table from ``db.create_all()``; the guard covers live
    databases that predate the model. The ``notifications.category`` column is
    added via ALTER on existing tables (E3) — custom-category notifications
    need a place to carry their explicit category cid.
    """
    try:
        inspector = db.inspect(db.engine)
        if 'notification_categories' not in inspector.get_table_names():
            NotificationCategory.__table__.create(db.engine)
            logger.info('Created notification_categories table to match the current schema')
        else:
            ncols = {col['name'] for col in inspector.get_columns('notification_categories')}
            if 'trigger' in ncols and 'trigger_type' not in ncols:
                with db.engine.begin() as connection:
                    connection.execute(sqla_text(
                        'ALTER TABLE notification_categories CHANGE `trigger` trigger_type VARCHAR(30)'
                    ))
                logger.info('Renamed notification_categories.trigger to trigger_type (reserved word)')
        if 'notifications' in inspector.get_table_names():
            ncols = {col['name'] for col in inspector.get_columns('notifications')}
            if 'category' not in ncols:
                with db.engine.begin() as connection:
                    connection.execute(sqla_text('ALTER TABLE notifications ADD COLUMN category VARCHAR(40)'))
                logger.info('Added missing notifications.category column to existing schema')
    except Exception as exc:
        logger.warning(f'Could not ensure notification categories schema compatibility: {exc}')


@_with_app_context
def seed_notification_categories():
    """Seed the built-in category registry rows from helpers.py.

    Idempotent: existing rows are left untouched. Built-in rows keep their real
    trigger type (via CATEGORY_BY_TYPE) so they keep firing; categories without
    a trigger are surfaced as disabled 'coming soon' rows (S2).
    """
    from helpers import CATEGORY_BY_TYPE, NOTIFICATION_CATEGORIES
    existing = {c.cid for c in NotificationCategory.query.all()}
    type_by_category = {v: k for k, v in CATEGORY_BY_TYPE.items()}
    to_add = []
    for cid, meta in NOTIFICATION_CATEGORIES.items():
        if cid in existing:
            continue
        trigger = type_by_category.get(cid)
        to_add.append(NotificationCategory(
            cid=cid,
            label=meta.get('label', cid),
            description=meta.get('description', ''),
            icon=meta.get('icon', 'bell'),
            role=meta.get('role', 'shared'),
            trigger_type=trigger,
            active=meta.get('active', True),
        ))
    if to_add:
        db.session.bulk_save_objects(to_add)
        db.session.commit()
        logger.info('Seeded %d notification categories', len(to_add))


@_with_app_context
def seed_priority_rules():
    """Seed the developer-defined default rule set when none exist."""
    from helpers import PRIORITY_DEFAULT_RULES
    if PriorityRule.query.count() > 0:
        return
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
    logger.info('Seeded %d default priority rules', len(PRIORITY_DEFAULT_RULES))


@_with_app_context
def seed_default_users():
    from werkzeug.security import generate_password_hash

    if User.query.filter_by(username='admin').first():
        return
    default_users = [
        {'username': 'admin', 'email': 'admin@ict.local', 'password': 'admin123', 'role': 'admin', 'department': 'ICT'},
        {'username': 'staff', 'email': 'staff@ict.local', 'password': 'staff123', 'role': 'staff', 'department': 'Support'},
    ]
    for user_data in default_users:
        user = User(
            username=user_data['username'],
            email=user_data['email'],
            password_hash=generate_password_hash(user_data['password']),
            role=user_data['role'],
            department=user_data['department'],
        )
        db.session.add(user)
    db.session.commit()
    logger.info('Seeded default users (admin/staff)')


@_with_app_context
def seed_default_roles():
    """Seed the classification-role registry (staff, admin).

    'admin' is the only privileged role; all others behave like 'staff' for
    access. Idempotent — existing registry is left untouched."""
    if Role.query.count() > 0:
        return
    for name in ('staff', 'admin'):
        db.session.add(Role(name=name, is_active=True))
    db.session.commit()
    logger.info('Seeded default roles (staff/admin)')


@_with_app_context
def seed_settings():
    from helpers import seed_settings as _seed_settings
    _seed_settings()


@_with_app_context
def seed_starter_articles():
    if KnowledgeArticle.query.count() > 0:
        return
    articles = [
        KnowledgeArticle(author_username='admin', title="How to reset your password", category="account",
            content="Go to the login page and click 'Forgot Password'. Note: self-service password reset isn't live yet — contact ICT directly for now."),
        KnowledgeArticle(author_username='admin', title="Printer not responding", category="hardware",
            content="Check the printer is powered on and connected to the network. Restart it by holding the power button for 10 seconds. If the issue persists, submit a hardware ticket with the printer's location."),
        KnowledgeArticle(author_username='admin', title="Requesting new software installation", category="software",
            content="Submit a ticket under the Software category with the exact application name and version needed. Include business justification for faster approval."),
        KnowledgeArticle(author_username='admin', title="VPN connection issues", category="network",
            content="Ensure you're on a stable internet connection before connecting. If VPN fails to connect, restart your device and try again. If it still fails, submit a network ticket."),
        KnowledgeArticle(author_username='admin', title="Reporting a suspicious email", category="security",
            content="Do not click any links or attachments. Forward the email to the ICT security team and submit a security-category ticket describing what you noticed."),
    ]
    db.session.bulk_save_objects(articles)
    db.session.commit()
    logger.info('Knowledge base seeded with 5 starter articles')


@_with_app_context
def seed_starter_categories():
    if Category.query.count() > 0:
        return
    cats = [Category(name=n) for n in ['hardware', 'software', 'network', 'security', 'other']]
    db.session.bulk_save_objects(cats)
    db.session.commit()
    logger.info('Categories seeded with 5 starter values')


@_with_app_context
def seed_starter_departments():
    if Department.query.count() > 0:
        return
    depts = [Department(name=n) for n in ['ICT', 'Finance', 'HR', 'Operations', 'Support']]
    db.session.bulk_save_objects(depts)
    db.session.commit()
    logger.info('Departments seeded with 5 starter values')


@_with_app_context
def seed_openserv_showcase():
    """Idempotent starter showcase: the openserv-laptop landing.

    Creates the showcase_pages row the render route requires (enabled) so
    /showcase/openserv-laptop is reachable on a fresh database without the
    admin CRUD UI (which is still Phase 5). Safe to re-run.
    """
    if ShowcasePage.query.filter_by(slug='openserv-laptop').first():
        return
    db.session.add(ShowcasePage(
        slug='openserv-laptop',
        title='ICT E-Ticketing — OpenServ Laptop',
        template='openserv-laptop',
        enabled=True,
        created_by='seed',
        content_json={'subtitle': 'Every component of your ICT landscape, assembled.'},
    ))
    db.session.commit()
    logger.info('Seeded openserv-laptop showcase page')


@_with_app_context
def bootstrap_database():
    """Single entry point that creates tables, runs schema backfills and
    seeds starter data.  Called from docker-entrypoint and app.py __main__."""
    db.create_all()
    ensure_user_schema()
    ensure_phase3_schema()
    ensure_phase4_schema()
    ensure_offline_comments_schema()
    ensure_notification_prefs_schema()
    ensure_ussd_schema_compat()
    ensure_priority_rules_schema()
    ensure_showcase_schema()
    ensure_notification_categories_schema()
    seed_default_roles()
    seed_default_users()
    seed_settings()
    seed_starter_articles()
    seed_starter_categories()
    seed_starter_departments()
    seed_priority_rules()
    seed_notification_categories()
    seed_openserv_showcase()
    logger.info('Database initialization complete')


@_with_app_context
def ensure_ussd_schema_compat():
    """Thin wrapper so bootstrap_database() can call ussd's live-schema helper
    without importing it at module import time (avoids any import cycle)."""
    from ussd import ensure_ussd_schema
    ensure_ussd_schema()
