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

from flask import has_app_context
from sqlalchemy import text as sqla_text
from extensions import db, logger
from models import (
    Category,
    Department,
    KnowledgeArticle,
    Role,
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
        if 'is_active' not in columns:
            with db.engine.begin() as connection:
                connection.execute(sqla_text('ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT TRUE'))
            logger.info('Added missing users.is_active column to existing schema')
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
def bootstrap_database():
    """Single entry point that creates tables, runs schema backfills and
    seeds starter data.  Called from docker-entrypoint and app.py __main__."""
    db.create_all()
    ensure_user_schema()
    ensure_phase3_schema()
    ensure_phase4_schema()
    ensure_notification_prefs_schema()
    ensure_ussd_schema_compat()
    seed_default_roles()
    seed_default_users()
    seed_settings()
    seed_starter_articles()
    seed_starter_categories()
    seed_starter_departments()
    logger.info('Database initialization complete')


@_with_app_context
def ensure_ussd_schema_compat():
    """Thin wrapper so bootstrap_database() can call ussd's live-schema helper
    without importing it at module import time (avoids any import cycle)."""
    from ussd import ensure_ussd_schema
    ensure_ussd_schema()
