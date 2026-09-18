"""SQLAlchemy ORM models.

All models are collected here so that any module in the backend can import
them via ``from models import Ticket, User, ...`` without pulling in the Flask
app or any route logic.  Extensions are imported from ``extensions``.
"""

from extensions import db, utcnow


# ---------------------------------------------------------------------------
# Tickets
# ---------------------------------------------------------------------------

class Ticket(db.Model):
    __tablename__ = 'tickets'

    id = db.Column(db.Integer, primary_key=True)
    ticket_number = db.Column(db.String(20), unique=True, nullable=False)
    title = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, nullable=False)
    category = db.Column(db.String(50), nullable=False)
    priority = db.Column(db.String(20), default='medium')
    status = db.Column(db.String(20), default='open')
    assigned_to = db.Column(db.String(100))
    created_by = db.Column(db.String(100), nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)
    updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow)
    resolution = db.Column(db.Text)
    sla_response_due = db.Column(db.DateTime, nullable=True)
    sla_resolution_due = db.Column(db.DateTime, nullable=True)
    sla_breach_notified = db.Column(db.Boolean, default=False)
    client_uuid = db.Column(db.String(36), nullable=True, unique=True)
    comments = db.relationship('TicketComment', backref='ticket', lazy=True, cascade='all, delete-orphan')


# ---------------------------------------------------------------------------
# Users & Social Accounts
# ---------------------------------------------------------------------------

class User(db.Model):
    __tablename__ = 'users'

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(50), unique=True, nullable=False)
    email = db.Column(db.String(100), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    role = db.Column(db.String(20), default='staff')
    department = db.Column(db.String(50))
    phone = db.Column(db.String(20), unique=True, nullable=True)
    is_active = db.Column(db.Boolean, default=True)
    failed_login_attempts = db.Column(db.Integer, default=0)
    locked_until = db.Column(db.DateTime, nullable=True)
    totp_secret = db.Column(db.String(64), nullable=True)
    totp_enabled = db.Column(db.Boolean, default=False)
    notifications = db.relationship('Notification', backref='user', lazy=True, cascade='all, delete-orphan')


class SocialAccount(db.Model):
    """Links a user to their Google / Facebook / Instagram identity."""
    __tablename__ = 'social_accounts'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    provider = db.Column(db.String(20), nullable=False)
    provider_user_id = db.Column(db.String(100), nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)

    __table_args__ = (db.UniqueConstraint('provider', 'provider_user_id', name='uq_social_account'),)
    user = db.relationship('User', backref='social_accounts')


# ---------------------------------------------------------------------------
# Knowledge Base
# ---------------------------------------------------------------------------

class KnowledgeArticle(db.Model):
    __tablename__ = 'knowledge_articles'

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    category = db.Column(db.String(50), nullable=False)
    content = db.Column(db.Text, nullable=False)
    author_username = db.Column(db.String(100))
    is_published = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=utcnow)
    updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow)


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

class Notification(db.Model):
    __tablename__ = 'notifications'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    type = db.Column(db.String(30), default='ticket_update')
    message = db.Column(db.String(255), nullable=False)
    link = db.Column(db.String(50))
    is_read = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=utcnow)


class NotificationPreference(db.Model):
    __tablename__ = 'notification_preferences'

    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    email_enabled = db.Column(db.Boolean, default=True)
    in_app_enabled = db.Column(db.Boolean, default=True)
    categories = db.Column(db.JSON, nullable=True)
    user = db.relationship('User', backref=db.backref('notification_pref', uselist=False))


# ---------------------------------------------------------------------------
# Ticket Comments & Attachments
# ---------------------------------------------------------------------------

class TicketComment(db.Model):
    __tablename__ = 'ticket_comments'

    id = db.Column(db.Integer, primary_key=True)
    ticket_id = db.Column(db.Integer, db.ForeignKey('tickets.id', ondelete='CASCADE'), nullable=False)
    author_username = db.Column(db.String(50), nullable=False)
    author_role = db.Column(db.String(20), nullable=False, default='staff')
    message = db.Column(db.Text, nullable=False)
    is_internal = db.Column(db.Boolean, nullable=False, default=False, server_default='0')
    client_uuid = db.Column(db.String(36), nullable=True, unique=True)
    created_at = db.Column(db.DateTime, default=utcnow)


class TicketAttachment(db.Model):
    __tablename__ = 'ticket_attachments'

    id = db.Column(db.Integer, primary_key=True)
    ticket_id = db.Column(db.Integer, db.ForeignKey('tickets.id', ondelete='CASCADE'), nullable=False)
    original_filename = db.Column(db.String(255), nullable=False)
    stored_filename = db.Column(db.String(255), nullable=False)
    file_size = db.Column(db.Integer, nullable=False)
    mime_type = db.Column(db.String(100))
    uploaded_by = db.Column(db.String(100))
    created_at = db.Column(db.DateTime, default=utcnow)
    ticket = db.relationship('Ticket',
                             backref=db.backref('attachments', cascade='all, delete-orphan'),
                             lazy=True)


# ---------------------------------------------------------------------------
# Taxonomy
# ---------------------------------------------------------------------------

class Category(db.Model):
    __tablename__ = 'categories'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50), unique=True, nullable=False)
    is_active = db.Column(db.Boolean, default=True)


class Department(db.Model):
    __tablename__ = 'departments'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50), unique=True, nullable=False)
    is_active = db.Column(db.Boolean, default=True)


class Role(db.Model):
    """Classification labels assignable to users (mostly admin-only privileges).

    'admin' is the only role that grants elevated access (checked on the JWT
    role claim at login). Every other role behaves like 'staff' for access:
    staff-tier endpoints are open to any authenticated user. Roles are soft-
    deletable and referenced by name across users, tickets and comments, so
    they are never hard-deleted or renamed.
    """
    __tablename__ = 'roles'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(20), unique=True, nullable=False)
    is_active = db.Column(db.Boolean, default=True)


# ---------------------------------------------------------------------------
# Password Resets
# ---------------------------------------------------------------------------

class PasswordResetToken(db.Model):
    __tablename__ = 'password_reset_tokens'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    token_hash = db.Column(db.String(64), unique=True, nullable=False)
    expires_at = db.Column(db.DateTime, nullable=False)
    used = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=utcnow)
    user = db.relationship('User', backref='reset_tokens')


# ---------------------------------------------------------------------------
# Audit Log
# ---------------------------------------------------------------------------

class AuditLog(db.Model):
    __tablename__ = 'audit_logs'

    id = db.Column(db.Integer, primary_key=True)
    actor = db.Column(db.String(100))
    action = db.Column(db.String(50), nullable=False)
    entity_type = db.Column(db.String(50), nullable=False)
    entity_id = db.Column(db.String(50))
    details = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=utcnow)


# ---------------------------------------------------------------------------
# System / Background Jobs
# ---------------------------------------------------------------------------

class SystemSetting(db.Model):
    __tablename__ = 'system_settings'

    key = db.Column(db.String(50), primary_key=True)
    value = db.Column(db.String(255), nullable=False)


class SystemEvent(db.Model):
    """DB-backed event bus for real-time SSE updates."""
    __tablename__ = 'system_events'

    id = db.Column(db.Integer, primary_key=True)
    type = db.Column(db.String(30), nullable=False)
    payload = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=utcnow)


class TaskRun(db.Model):
    """Last-run timestamps for periodic background jobs."""
    __tablename__ = 'task_runs'

    task_name = db.Column(db.String(50), primary_key=True)
    last_run = db.Column(db.DateTime, default=utcnow)


class ProcessedEmail(db.Model):
    """Message-ids already handled by email-to-ticket ingestion."""
    __tablename__ = 'processed_emails'

    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.String(255), unique=True, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)


# ---------------------------------------------------------------------------
# API Tokens & Webhooks
# ---------------------------------------------------------------------------

class ApiToken(db.Model):
    __tablename__ = 'api_tokens'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    token_hash = db.Column(db.String(64), unique=True, nullable=False)
    token_prefix = db.Column(db.String(16))
    scopes = db.Column(db.String(100), default='read')
    expires_at = db.Column(db.DateTime, nullable=True)
    is_active = db.Column(db.Boolean, default=True)
    created_by = db.Column(db.String(100))
    last_used_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=utcnow)


class Webhook(db.Model):
    __tablename__ = 'webhooks'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    url = db.Column(db.String(500), nullable=False)
    secret = db.Column(db.String(128))
    events = db.Column(db.String(255), default='ticket.created')
    is_active = db.Column(db.Boolean, default=True)
    created_by = db.Column(db.String(100))
    created_at = db.Column(db.DateTime, default=utcnow)