"""Shared backend helpers: email, settings, SLA, notifications, audit,
serializers, authorization decorators and the periodic background jobs.

Everything here is import-safe: it only depends on ``extensions`` and
``models``, never on ``app`` or the route blueprints.
"""

import hashlib
import hmac
import html
import json
import logging
import os
import re
import secrets
import smtplib
import threading
import time

import requests
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from functools import wraps

from flask import jsonify, current_app
from flask_jwt_extended import get_jwt, jwt_required
from werkzeug.security import generate_password_hash

from extensions import db, limiter, logger, utcnow
from models import (
    AuditLog,
    ApiToken,
    KnowledgeArticle,
    Notification,
    NotificationPreference,
    ProcessedEmail,
    Role,
    SystemEvent,
    SystemSetting,
    TaskRun,
    Ticket,
    TicketComment,
    User,
    Webhook,
)

# ============= IDLE MONITORING HOOK ==================
try:
    _monitoring_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'scripts')
    if _monitoring_path not in __import__('sys').path:
        __import__('sys').path.insert(0, _monitoring_path)
    from monitoring_hook import report as _monitoring_report  # noqa: E402
except Exception:
    _monitoring_report = lambda *a, **k: None  # noqa: E731


# ============= NOTIFICATION CATEGORY REGISTRY =============
# One configurable category per notification type where a trigger exists.
# 'active: False' categories have no trigger yet and must be surfaced as
# disabled "coming soon" rows (S2) — never presented as if they work.
NOTIFICATION_CATEGORIES = {
    'ticket_updates': {
        'label': 'Ticket updates',
        'description': 'New, assigned-to-me, or status-changed tickets',
        'icon': 'ticket',
        'role': 'shared',
        'active': True,
    },
    'technician_replies': {
        'label': 'Replies on my tickets',
        'description': 'A technician publicly replies on one of my tickets',
        'icon': 'user',
        'role': 'shared',
        'active': True,
    },
    'announcements': {
        'label': 'Announcements',
        'description': 'Admin announcements and broadcasts',
        'icon': 'bullhorn',
        'role': 'shared',
        'active': True,
    },
    'sla_breaches': {
        'label': 'SLA breaches',
        'description': 'A ticket passed its SLA response deadline',
        'icon': 'exclamation-triangle',
        'role': 'admin',
        'active': True,
    },
    'ticket_reopened': {
        'label': 'Ticket reopened',
        'description': 'A resolved ticket is reopened',
        'icon': 'undo',
        'role': 'shared',
        'active': False,
    },
    'sla_approaching': {
        'label': 'SLA approaching breach',
        'description': 'A ticket is close to its SLA deadline',
        'icon': 'hourglass-end',
        'role': 'admin',
        'active': False,
    },
    'unassigned_high_priority': {
        'label': 'Unassigned high-priority tickets',
        'description': 'A high-priority ticket has no assignee',
        'icon': 'ticket-alt',
        'role': 'admin',
        'active': False,
    },
    'user_account_locked': {
        'label': 'User account locked',
        'description': 'An account is automatically locked after failed logins',
        'icon': 'key',
        'role': 'admin',
        'active': False,
    },
    'new_user_created': {
        'label': 'New user created',
        'description': 'A new user account is created',
        'icon': 'user-plus',
        'role': 'admin',
        'active': False,
    },
    'webhook_failed': {
        'label': 'Webhook delivery failure',
        'description': 'An outbound webhook fails to deliver',
        'icon': 'plug',
        'role': 'admin',
        'active': False,
    },
    'audit_event_interest': {
        'label': 'Audit events of interest',
        'description': 'Security-relevant audit log events',
        'icon': 'shield-alt',
        'role': 'admin',
        'active': False,
    },
}

CATEGORY_BY_TYPE = {
    'ticket_update': 'ticket_updates',
    'technician_reply': 'technician_replies',
    'announcement': 'announcements',
    'sla_breach': 'sla_breaches',
}


def category_role(category):
    meta = NOTIFICATION_CATEGORIES.get(category)
    return (meta or {}).get('role', 'shared')


def configure_logging(level=logging.INFO):
    """One-time logging setup."""
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter('%(levelname)s %(name)s: %(message)s'))
        logger.addHandler(handler)
        logger.setLevel(level)


def resolve_secret(name):
    """Read a secret from the environment, or generate a fresh ephemeral one."""
    value = os.getenv(name)
    if value and value.strip():
        return value.strip()
    logger.warning(
        f'{name} is not set — using a random secret generated at startup. '
        'Set it in .env for stable sessions across restarts.'
    )
    return secrets.token_hex(32)


# ============ CLOUDFLARE TURNSTILE VERIFICATION ============

TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'


def verify_turnstile(token, remote_ip=None):
    """Verify a Cloudflare Turnstile response token.

    Returns True when Cloudflare confirms the challenge was passed.
    Returns True (skips) when CF_TURNSTILE_SECRET_KEY is empty and
    CF_TURNSTILE_ENABLED is not set — dev-mode bypass with a warning.
    Returns False on any failure (network, timeout, invalid response).
    """
    secret = os.getenv('CF_TURNSTILE_SECRET_KEY', '').strip()
    enabled = os.getenv('CF_TURNSTILE_ENABLED', '').strip().lower()

    if not secret:
        if enabled == 'true':
            logger.warning(
                'CF_TURNSTILE_ENABLED is true but CF_TURNSTILE_SECRET_KEY is empty — '
                'rejecting all requests (fail-closed).'
            )
            return False
        logger.warning(
            'Cloudflare Turnstile verification disabled — CF_TURNSTILE_SECRET_KEY '
            'is not set. Set it in .env for production.'
        )
        return True

    if not token:
        return False

    payload = {'secret': secret, 'response': token}
    if remote_ip:
        payload['remoteip'] = remote_ip

    try:
        resp = requests.post(TURNSTILE_VERIFY_URL, data=payload, timeout=5)
        result = resp.json()
        if result.get('success'):
            return True
        error_codes = result.get('error-codes', [])
        logger.warning(f'Turnstile verification failed: {error_codes}')
        return False
    except requests.exceptions.Timeout:
        logger.warning('Turnstile verification timed out after 5s')
        return False
    except Exception as exc:
        logger.warning(f'Turnstile verification error: {exc}')
        return False


# ============ IN-PROCESS ROUTE CACHE ============
# A deliberately small, per-process memoization layer for the few backend
# routes that repeat identical queries on every hit. It is NOT a distributed
# cache: with multiple gunicorn workers, every worker owns its own dict, so
# consistency is per-process only and staleness is bounded per worker by the
# TTL. Nothing invalidates on writes. In-memory only — no Redis, Memcached, or
# Flask-Caching.

_route_cache_lock = threading.Lock()
_route_cache = {}


def cache_key(*parts):
    """Build a flat string key from route/param fragments. None becomes empty."""
    return ':'.join(str(p) for p in parts if p is not None)


def cache_get(key):
    """Return the cached value, or None when missing or expired. Expired
    entries are evicted lazily inside the lock on read."""
    with _route_cache_lock:
        entry = _route_cache.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if time.monotonic() > expires_at:
            _route_cache.pop(key, None)
            return None
        return value


def cache_set(key, value, ttl_seconds):
    """Store a value for ttl_seconds. Values must have a positive TTL."""
    if ttl_seconds < 1:
        raise ValueError('ttl_seconds must be >= 1 second')
    with _route_cache_lock:
        _route_cache[key] = (value, time.monotonic() + ttl_seconds)


def cache_delete(key):
    """Drop one entry (no-op when absent)."""
    with _route_cache_lock:
        _route_cache.pop(key, None)


def cache_clear():
    """Drop every entry (used by tests)."""
    with _route_cache_lock:
        _route_cache.clear()


# ============ EMAIL ============

def render_email_html(title, content_html, footer_hint=''):
    site = html.escape(get_setting('site_name', 'ICT E-Ticketing') or 'ICT E-Ticketing')
    return f"""<!DOCTYPE html>
<html><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#333;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e4e7ec;">
      <div style="background:#1976d2;color:#ffffff;padding:16px 24px;font-size:18px;font-weight:bold;">{site}</div>
      <div style="padding:24px;">
        <h2 style="margin:0 0 12px;font-size:16px;">{title}</h2>
        <div style="font-size:14px;line-height:1.6;">{content_html}</div>
      </div>
      <div style="background:#f9fafb;border-top:1px solid #e4e7ec;padding:12px 24px;font-size:12px;color:#888;">{footer_hint or site}</div>
    </div>
  </div>
</body></html>"""


def send_email(to_email, subject, body, html_body=None):
    smtp_host = os.getenv('SMTP_HOST')
    smtp_port = int(os.getenv('SMTP_PORT', '587'))
    smtp_user = os.getenv('SMTP_USER')
    smtp_password = os.getenv('SMTP_PASSWORD')
    smtp_tls = os.getenv('SMTP_TLS', 'true').lower() == 'true'
    from_email = os.getenv('SMTP_FROM', smtp_user or 'no-reply@ict.local')

    if not smtp_host or not smtp_user:
        logger.info(f"[SMTP not configured — email NOT sent] to={to_email} subject={subject}")
        return False

    if html_body:
        msg = MIMEMultipart('alternative')
        msg.attach(MIMEText(body, 'plain'))
        msg.attach(MIMEText(html_body, 'html'))
    else:
        msg = MIMEText(body)
    msg['Subject'] = subject
    msg['From'] = from_email
    msg['To'] = to_email
    try:
        server = smtplib.SMTP(smtp_host, smtp_port)
        if smtp_tls:
            server.starttls()
        if smtp_user:
            server.login(smtp_user, smtp_password)
        server.sendmail(from_email, [to_email], msg.as_string())
        server.quit()
        logger.info(f"Email sent to {to_email} — {subject}")
        return True
    except Exception as exc:
        logger.warning(f"Failed to send email to {to_email}: {exc}")
        return False


def _ensure_pref(user):
    pref = user.notification_pref
    if pref is None:
        pref = NotificationPreference(user_id=user.id)
        user.notification_pref = pref
        db.session.add(pref)
        db.session.flush()
    return pref


def get_notification_prefs(user):
    if user is None:
        return True, True
    pref = _ensure_pref(user)
    return pref.email_enabled is not False, pref.in_app_enabled is not False


def notification_category_enabled(user, category):
    if user is None:
        return True
    pref = _ensure_pref(user)
    if not pref.categories:
        return True
    return bool(pref.categories.get(category, True))


def notification_category_prefs(user):
    """All category toggles for a user (defaults to enabled where unset)."""
    pref = _ensure_pref(user)
    cats = pref.categories or {}
    return {cid: bool(cats.get(cid, True)) for cid in NOTIFICATION_CATEGORIES}


def set_notification_category(user, category, enabled):
    """Persist one category toggle. Returns False for unknown categories."""
    if user is None or category not in NOTIFICATION_CATEGORIES:
        return False
    pref = _ensure_pref(user)
    cats = dict(pref.categories or {})
    cats[category] = bool(enabled)
    pref.categories = cats
    return True


def email_global_enabled():
    return get_setting('email_notifications_enabled', 'true').lower() == 'true'


def log_audit(actor, action, entity_type, entity_id=None, details=None):
    db.session.add(AuditLog(
        actor=actor or 'system',
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id) if entity_id is not None else None,
        details=details,
    ))


def notify_users(usernames, ntype, message, link, email_subject, email_body):
    seen = set()
    for uname in usernames:
        if not uname or uname in seen:
            continue
        seen.add(uname)
        user = User.query.filter_by(username=uname).first()
        if not user:
            continue
        category = CATEGORY_BY_TYPE.get(ntype)
        if category and not notification_category_enabled(user, category):
            continue
        email_ok, inapp_ok = get_notification_prefs(user)
        if inapp_ok:
            db.session.add(Notification(user_id=user.id, type=ntype, message=message, link=link))
        if user.email and email_ok and email_global_enabled():
            site = get_setting('site_name', 'ICT E-Ticketing') or 'ICT E-Ticketing'
            send_email(user.email, email_subject, email_body,
                       html_body=render_email_html(html.escape(email_subject),
                                                   '<p>' + html.escape(email_body).replace('\n', '<br>') + '</p>',
                                                   site))


# ============ SETTINGS ============

DEFAULT_SETTINGS = {
    'sla_response_high': '60',
    'sla_response_medium': '240',
    'sla_response_low': '480',
    'sla_resolution_high': '480',
    'sla_resolution_medium': '2880',
    'sla_resolution_low': '7200',
    'ticket_prefix': 'ICT',
    'site_name': 'ICT E-Ticketing System',
    'email_notifications_enabled': 'true',
    'sla_sweep_interval_minutes': '5',
    'sla_auto_escalate': 'false',
    'inbound_email_enabled': 'false',
    'inbound_poll_interval_minutes': '5',
    'inbound_default_category': 'other',
}

SLA_SETTING_KEYS = (
    'sla_response_high', 'sla_response_medium', 'sla_response_low',
    'sla_resolution_high', 'sla_resolution_medium', 'sla_resolution_low',
    'ticket_prefix', 'site_name', 'email_notifications_enabled',
    'sla_sweep_interval_minutes', 'sla_auto_escalate',
    'inbound_email_enabled', 'inbound_poll_interval_minutes',
    'inbound_default_category',
)


def get_setting(key, default=None):
    s = SystemSetting.query.get(key)
    if s is not None:
        return s.value
    if key in DEFAULT_SETTINGS:
        return DEFAULT_SETTINGS[key]
    return default


def settings_int(key, default):
    try:
        return int(get_setting(key))
    except (TypeError, ValueError):
        return default


def seed_settings():
    for key, value in DEFAULT_SETTINGS.items():
        if SystemSetting.query.get(key) is None:
            db.session.add(SystemSetting(key=key, value=value))
    db.session.commit()


def _next_ticket_number():
    """Next sequential ticket number: <prefix>-00001, <prefix>-00002, ...

    Single source of truth shared by the web portal, the API-token v1
    endpoints and USSD. Computes max+1 across every ticket whose
    ticket_number matches the current prefix, so a stray malformed number
    can never break, skip or duplicate ticket identification. Callers
    retry on IntegrityError to cover concurrent creation.
    """
    prefix = get_setting('ticket_prefix', 'ICT') or 'ICT'
    pattern = re.compile(rf'^{re.escape(prefix)}-(\d+)$')
    highest = 0
    for (num,) in db.session.query(Ticket.ticket_number).all():
        match = pattern.match(num)
        if match:
            highest = max(highest, int(match.group(1)))
    return f'{prefix}-{str(highest + 1).zfill(5)}'


def apply_sla(ticket):
    r = settings_int(f'sla_response_{ticket.priority}', 240)
    s = settings_int(f'sla_resolution_{ticket.priority}', 2880)
    ticket.sla_response_due = utcnow() + timedelta(minutes=r)
    ticket.sla_resolution_due = utcnow() + timedelta(minutes=s)

# ============ EVENTS / WEBHOOKS ============

def emit_event(etype, payload):
    db.session.add(SystemEvent(type=etype, payload=json.dumps(payload, default=str)))
    fire_webhooks(etype, payload)


def fire_webhooks(etype, payload):
    import requests

    def _deliver(wh, event_name, event_payload):
        body = json.dumps({'event': event_name, 'data': event_payload}, default=str)
        signature = hmac.new((wh.secret or '').encode('utf-8'), body.encode('utf-8'),
                             hashlib.sha256).hexdigest()
        try:
            requests.post(
                wh.url, data=body, timeout=8,
                headers={'Content-Type': 'application/json',
                         'X-Ict-Signature': f'sha256={signature}'},
            )
        except Exception as exc:
            logger.warning(f"Webhook {wh.name} delivery failed: {exc}")

    try:
        hooks = Webhook.query.filter_by(is_active=True).all()
    except Exception:
        return
    for wh in hooks:
        subscribed = [e.strip() for e in (wh.events or '').split(',') if e.strip()]
        if subscribed and etype not in subscribed:
            continue
        threading.Thread(target=_deliver, args=(wh, etype, payload), daemon=True).start()


def task_due(task_name, interval_minutes):
    row = TaskRun.query.get(task_name)
    now = utcnow()
    if row is None:
        db.session.add(TaskRun(task_name=task_name, last_run=now))
        db.session.commit()
        return True
    if now >= row.last_run + timedelta(minutes=max(1, interval_minutes)):
        row.last_run = now
        db.session.commit()
        return True
    return False


def round_robin_assignees():
    # Candidates = any active user with a role active in the registry.
    # 'admin' stays assignable (as before); custom classification roles now
    # participate too. Empty registry (legacy/pre-seed DB) falls back to the
    # historical staff/admin pair.
    if Role.query.count() == 0:
        candidates = User.query.filter(User.role.in_(('staff', 'admin')), User.is_active.is_(True)).all()
    else:
        active_roles = db.select(Role.name).where(Role.is_active.is_(True))
        candidates = User.query.filter(User.role.in_(active_roles), User.is_active.is_(True)).all()
    if not candidates:
        return None
    best, best_count = None, None
    for u in candidates:
        open_count = Ticket.query.filter_by(assigned_to=u.username) \
            .filter(Ticket.status.in_(('open', 'in_progress'))).count()
        if best_count is None or open_count < best_count:
            best, best_count = u, open_count
    return best.username


def run_sla_sweep():
    if not task_due('sla_sweep', settings_int('sla_sweep_interval_minutes', 5)):
        return
    now = utcnow()

    breached = (Ticket.query
                .filter(Ticket.status.in_(('open', 'in_progress')))
                .filter(Ticket.sla_response_due < now)
                .filter(Ticket.sla_breach_notified.is_(False))
                .all())

    escalate = get_setting('sla_auto_escalate', 'false').lower() == 'true'
    for t in breached:
        t.sla_breach_notified = True
        admin_names = [a.username for a in User.query.filter_by(role='admin').all()]
        recipients = set(list(admin_names))
        if t.assigned_to:
            recipients.add(t.assigned_to)
        message = (f"SLA breach: {t.ticket_number} ({t.title}) — "
                   f"{t.priority} priority, still {t.status.replace('_', ' ')}")
        notify_users(
            recipients, 'sla_breach', message, str(t.id),
            f"SLA breached: {t.ticket_number}",
            f"Ticket {t.ticket_number} ({t.title}) has passed its {t.priority}-priority "
            f"response deadline and is still {t.status.replace('_', ' ')}."
        )
        action = 'SLA breached: ' + t.ticket_number
        if escalate and t.priority != 'high':
            t.priority = 'high'
            apply_sla(t)
            action += f" — auto-escalated to high priority"
            log_audit('system', 'escalate', 'ticket', t.id, f"Auto-escalated {t.ticket_number} to high priority after SLA breach")
        log_audit('system', 'sla_breach', 'ticket', t.id, action)
        emit_event('sla.breach', {'ticket_id': t.id, 'ticket_number': t.ticket_number,
                                  'title': t.title, 'escalated': escalate and t.status != 'high'})

    if breached:
        db.session.commit()
        logger.warning(f"SLA sweep: {len(breached)} breached ticket(s) notified")


def run_inbound_poll():
    enabled = os.getenv('MAIL_INBOUND_ENABLED', get_setting('inbound_email_enabled', 'false')).lower() == 'true'
    if not enabled:
        return
    if not task_due('inbound_poll', settings_int('inbound_poll_interval_minutes', 5)):
        return
    try:
        import imaplib
        import email as _email_mod
        from email import policy

        host = os.getenv('MAIL_INBOUND_HOST')
        port = int(os.getenv('MAIL_INBOUND_PORT', '993'))
        user = os.getenv('MAIL_INBOUND_USER')
        pwd = os.getenv('MAIL_INBOUND_PASSWORD')
        folder = os.getenv('MAIL_INBOUND_FOLDER', 'INBOX')
        if not (host and user and pwd):
            logger.info('Inbound email enabled but MAIL_INBOUND_HOST/USER/PASSWORD not set')
            return

        conn = imaplib.IMAP4_SSL(host, port)
        try:
            conn.login(user, pwd)
            conn.select(folder)
            _, nums = conn.search(None, 'UNSEEN')
            default_category = get_setting('inbound_default_category', 'other') or 'other'
            for num in nums[0].split():
                try:
                    _, data = conn.fetch(num, '(RFC822)')
                    raw = data[0][1]
                    msg = _email_mod.message_from_bytes(raw, policy=policy.default)
                    run_inbound_message(msg, default_category)
                    conn.store(num, '+FLAGS', '\\Seen')
                except Exception as exc:
                    logger.info(f'Inbound: skipped one message: {exc}')
        finally:
            try:
                conn.logout()
            except Exception:
                pass
    except Exception as exc:
        logger.info(f'Inbound poll failed: {exc}')


def run_inbound_message(msg, default_category):
    message_id = (msg.get('Message-ID') or msg.get('message-id') or '').strip()
    if message_id and ProcessedEmail.query.filter_by(message_id=message_id).first():
        return

    from_addr = (msg.get('From') or '')
    m = re.search(r'[\w.+-]+@[\w.-]+', from_addr)
    if not m:
        return
    sender_email = m.group(0).lower()
    sender = User.query.filter_by(email=sender_email, is_active=True).first()
    if not sender:
        logger.info(f"Inbound: unknown sender {sender_email} — ignored")
        return

    subject = (msg.get('Subject') or '').strip()
    body_parts = []
    for part in msg.walk():
        if part.get_content_type() == 'text/plain' and not part.get('Content-Disposition'):
            body_parts.append(part.get_content())
    body = '\n'.join(body_parts).strip()
    if not body_parts and msg.is_multipart() is False:
        body = msg.get_content().strip() if msg else ''
    body = body.split('\n--')[-1].lstrip()
    body_lines = [ln for ln in body.split('\n') if not ln.strip().startswith('>')]
    body = '\n'.join(body_lines).strip()
    if not body:
        body = '(no text content)'

    tnum_match = re.search(r'ICT-\d{5}', subject)
    if tnum_match:
        ticket = Ticket.query.filter_by(ticket_number=tnum_match.group(0)).first()
        if ticket:
            comment = TicketComment(ticket_id=ticket.id, author_username=sender.username,
                                    author_role=sender.role, message=f"[via email] {body}")
            db.session.add(comment)
            log_audit(sender.username, 'comment', 'ticket', ticket.id, 'reply by inbound email')
            recipients = set(filter(None, [ticket.created_by, ticket.assigned_to, sender.username]))
            notify_users(recipients, 'technician_reply',
                         f"Email reply on {ticket.ticket_number}", str(ticket.id),
                         f"Reply on ticket {ticket.ticket_number}",
                         f"{sender.username} replied by email to {ticket.ticket_number}:\n\n{body[:2000]}")
            emit_event('comment.created', {'ticket_id': ticket.id,
                                           'ticket_number': ticket.ticket_number,
                                           'author': sender.username,
                                           'preview': body[:120], 'source': 'email'})
        else:
            logger.info(f"Inbound: ticket {tnum_match.group(0)} no longer exists")
    else:
        prefix = get_setting('ticket_prefix', 'ICT') or 'ICT'
        last_ticket = Ticket.query.order_by(Ticket.id.desc()).first()
        num = (int(last_ticket.ticket_number.split('-')[1]) + 1) if last_ticket else 1
        ticket_number = f"{prefix}-{str(num).zfill(5)}"
        ticket = Ticket(ticket_number=ticket_number, title=subject or f"Email from {sender.username}",
                        description=f"[via email from {sender.email}]\n\n{body}",
                        category=default_category, priority='low',
                        created_by=sender.username)
        apply_sla(ticket)
        db.session.add(ticket)
        try:
            db.session.flush()
        except Exception:
            db.session.rollback()
            return
        log_audit(sender.username, 'create', 'ticket', ticket.id, f"Created via inbound email {ticket_number}")
        admin_names = [a.username for a in User.query.filter_by(role='admin').all()]
        recipients = set(admin_names) ^ {sender.username}
        notify_users(recipients, 'ticket_update', f"New ticket {ticket_number}: {ticket.title}",
                     str(ticket.id), f"New ticket: {ticket_number}",
                     f"{sender.username} emailed in a new ticket:\n\n{ticket.description[:2000]}")
        emit_event('ticket.created', {'id': ticket.id, 'ticket_number': ticket_number,
                                       'title': ticket.title, 'priority': 'low', 'status': 'open'})

    if message_id:
        db.session.add(ProcessedEmail(message_id=message_id))
    db.session.commit()


def _run_periodic_tasks():
    try:
        run_sla_sweep()
        run_inbound_poll()
    except Exception as exc:
        db.session.rollback()
        logger.warning(f'Periodic task error: {exc}')
        _monitoring_report('periodic_task_error', {'error': str(exc)})
    finally:
        try:
            db.session.remove()
        except Exception:
            pass


# ============ SERIALIZERS / AUTH UTILS ============

def sla_status(ticket):
    now = utcnow()
    active = ticket.status in ('open', 'in_progress')
    response = ticket.sla_response_due is not None and active and now > ticket.sla_response_due
    resolution = ticket.sla_resolution_due is not None and active and now > ticket.sla_resolution_due
    return response, resolution


def serialize_ticket(t):
    r_b, s_b = sla_status(t)
    return {
        'id': t.id,
        'ticket_number': t.ticket_number,
        'title': t.title,
        'description': t.description,
        'category': t.category,
        'priority': t.priority,
        'status': t.status,
        'assigned_to': t.assigned_to,
        'created_by': t.created_by,
        'created_at': t.created_at.isoformat(),
        'updated_at': t.updated_at.isoformat(),
        'resolution': t.resolution,
        'sla_response_due': t.sla_response_due.isoformat() if t.sla_response_due else None,
        'sla_resolution_due': t.sla_resolution_due.isoformat() if t.sla_resolution_due else None,
        'sla_response_breached': r_b,
        'sla_resolution_breached': s_b,
    }


def _as_str(value):
    return str(value) if value is not None else None


def serialize_article(a):
    return {
        'id': a.id,
        'title': a.title,
        'category': a.category,
        'content': a.content,
        'author_username': a.author_username,
        'is_published': a.is_published,
        'created_at': a.created_at.isoformat() if a.created_at else None,
        'updated_at': a.updated_at.isoformat() if a.updated_at else None,
    }


ALLOWED_EXTENSIONS = {
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf', '.txt', '.csv',
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z',
    '.log', '.md',
}


def serialize_attachment(a):
    return {
        'id': a.id,
        'ticket_id': a.ticket_id,
        'original_filename': a.original_filename,
        'file_size': a.file_size,
        'mime_type': a.mime_type,
        'uploaded_by': a.uploaded_by,
        'created_at': a.created_at.isoformat() if a.created_at else None,
    }


def _attachment_access(claims, ticket):
    if claims.get('role') != 'admin' and ticket.created_by != claims.get('username'):
        return (jsonify({'error': 'You do not have access to this ticket'}), 403)
    return (None, None)


def _remove_attachment_files(ticket):
    for att in ticket.attachments:
        try:
            import os
            os.remove(os.path.join(current_app.config['UPLOAD_FOLDER'], att.stored_filename))
        except OSError:
            pass


def role_required(*allowed_roles):
    def decorator(fn):
        @wraps(fn)
        @jwt_required()
        def wrapper(*args, **kwargs):
            claims = get_jwt()
            if claims.get('role') not in allowed_roles:
                return jsonify({'error': 'Insufficient permissions'}), 403
            return fn(*args, **kwargs)
        return wrapper
    return decorator


# ============ API TOKEN AUTH ============

def _hash_token(raw_token):
    return hashlib.sha256(('ict_' + raw_token).encode()).hexdigest()


def api_token_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        from flask import request
        auth = request.headers.get('Authorization', '')
        token = auth[7:].strip() if auth.lower().startswith('bearer ') else None
        if not token:
            return jsonify({'error': 'API token required'}), 401
        row = ApiToken.query.filter_by(token_hash=_hash_token(token)).first()
        if row is None or not row.is_active:
            return jsonify({'error': 'Invalid or revoked API token'}), 401
        if row.expires_at and row.expires_at < utcnow():
            return jsonify({'error': 'API token expired'}), 401
        request.api_token = row
        return fn(*args, **kwargs)
    return wrapped
