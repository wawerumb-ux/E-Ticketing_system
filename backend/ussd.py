"""
USSD Blueprint — feature-phone access to the ICT ticketing system.

```
POST /ussd      single entry point; gateway calls this for every "page"
```

USSD reality this module is built around:
  - Sessions are stateful across gateway POSTs, keyed by a gateway-supplied
    sessionId. A session is short-lived (~180s); the gateway may retry the
    SAME (sessionId, text) pair, so every handler MUST be idempotent on it.
  - The caller is identified by phone number ONLY. There is no JWT on this
    path and no password prompt — authentication is "this phone number".
  - We cannot push to the user. Responses are "CON <text>" (keep the session
    open) or "END <text>" (terminate), and never exceed 160 chars per line.
  - Input is menu-driven digits / short strings. Free text is limited to
    ~160 chars per step; titles/descriptions are truncated server-side.

Run-level note: the raw gateway envelope is isolated in
parse_gateway_request() so a Twilio/Infobip switch is a one-function change.

No JWT, no session cookie, no CSRF on this path — see the blueprint route.
"""

from datetime import timedelta
import json

from flask import Blueprint, request, Response
from sqlalchemy import text as sqla_text
from sqlalchemy.exc import IntegrityError

# Imported from the shared backend modules (never from app.py) so there is no
# circular-import problem: extensions/models/helpers do not depend on routes.
from extensions import db, limiter, utcnow, logger
from models import Category, KnowledgeArticle, Ticket, User
from helpers import (apply_sla, emit_event, get_setting, log_audit, notify_users,
                     _next_ticket_number)

ussd_bp = Blueprint('ussd', __name__)


# ---------------------------------------------------------------------------
# State machine constants (each is a stored value of ussd_sessions.state)
# ---------------------------------------------------------------------------
ST_NEW = 'NEW'                      # at the main menu
ST_REPORT_TITLE = 'REPORT_TITLE'    # capturing the report title
ST_REPORT_DESC = 'REPORT_DESC'      # capturing the report description
ST_REPORT_CATEGORY = 'REPORT_CATEGORY'  # picking category (paginated)
ST_REPORT_CONFIRM = 'REPORT_CONFIRM'    # confirm / change / cancel
ST_MY_TICKETS = 'MY_TICKETS'        # one-shot list of the caller's tickets
ST_KB_SEARCH = 'KB_SEARCH'          # awaiting a keyword
ST_STATUS = 'STATUS'                # one-shot system status check

# Services the caller can choose at the main menu.
MENU_MAIN = (
    'ICT Ticketing\n'
    '1. Report Issue\n'
    '2. My Tickets\n'
    '3. Knowledge Base\n'
    '4. System Status'
)

# A USSD response cannot exceed 160 characters, prefix included.
USSD_MAX = 160

# Session TTL mirroring the gateway's ~180s timeout; older sessions are reset.
SESSION_TTL_SECONDS = 180

# How many category options to show per page (keeps the menu inside 160 chars).
CATEGORY_PAGE_SIZE = 7

# ---------------------------------------------------------------------------
# UssdSession ORM model. db.create_all() / ensure_ussd_schema() create the
# physical table; this class is what the handlers query against.
# ---------------------------------------------------------------------------
class UssdSession(db.Model):
    __tablename__ = 'ussd_sessions'

    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.String(64), unique=True, nullable=False, index=True)
    phone = db.Column(db.String(20), nullable=False)
    state = db.Column(db.String(32), nullable=False, default=ST_NEW)
    payload_json = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=utcnow)
    updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow)

    @property
    def payload(self):
        try:
            return json.loads(self.payload_json or '{}') or {}
        except (ValueError, TypeError):
            return {}

    @payload.setter
    def payload(self, value):
        self.payload_json = json.dumps(value or {})


# ---------------------------------------------------------------------------
# Gateway adapter
# ---------------------------------------------------------------------------
def parse_gateway_request(request_obj):
    """Extract our canonical request shape from the gateway's envelope.

    Returns a dict with keys {session_id, phone, text}.

    Assumed shape (Africa's Talking):
      POST /ussd  body: { "sessionId": "...", "phoneNumber": "+2547...",
                          "servicesCode": "*384*1234#", "text": "1*2" }
      Sent as either application/json or form-encoded — both are handled.

    To swap for Twilio: Twilio POSTs form-encoded { CallSid (or To), From,
    Body, Digits } — map session_id=CALL or To, phone=From, text=Body.
    To swap for Infobip: POSTs JSON { sessionId, sender, text } — map
    session_id=sessionId, phone=sender, text=text. Only this function changes.
    """
    if request_obj.is_json:
        data = request_obj.get_json(silent=True) or {}
    else:
        data = request_obj.form or {}

    return {
        'session_id': str(data.get('sessionId') or data.get('session_id') or '').strip()[:64],
        'phone': str(data.get('phoneNumber') or data.get('phone') or '').strip()[:20],
        'text': str(data.get('text') or '').strip(),
    }


# ---------------------------------------------------------------------------
# Small response helpers
# ---------------------------------------------------------------------------
def _fit(body):
    """Truncate a single response line so CON/END + body stays <= 160 chars."""
    if len(body) <= USSD_MAX:
        return body
    return body[:USSD_MAX - 1] + '…'


def _render(body, end=False):
    # The 160-char limit covers the ENTIRE response line, CON/END prefix
    # included, so the body only gets (160 - len(prefix)) chars.
    prefix = 'END ' if end else 'CON '
    budget = USSD_MAX - len(prefix)
    if len(body) <= budget:
        return prefix + body
    return prefix + body[:budget - 1] + '…'


def _mask(phone):
    """Mask a phone number for logs: only the last 4 digits survive."""
    digits = phone or 'unknown'
    return '****' + digits[-4:] if len(digits) >= 4 else '****'


def _load(payload, key, default=None):
    try:
        return payload.get(key, default)
    except AttributeError:
        return default


# ---------------------------------------------------------------------------
# Data access used by the menu handlers
# ---------------------------------------------------------------------------
def _active_categories():
    return Category.query.filter_by(is_active=True).order_by(Category.name.asc()).all()


def _resolve_category(chosen):
    """Resolve a chosen category name; fall back like the spec says:
    chosen name if active, else 'other' if present, else first active. The
    returned value is always a usable category string."""
    names = [c.name for c in _active_categories()]
    if chosen and chosen in names:
        return chosen
    if 'other' in names:
        return 'other'
    return names[0] if names else 'other'


def _category_menu(categories, page):
    """Build a paginated category menu. Returns (body, page_items, has_more)."""
    page = max(1, int(page))
    start = (page - 1) * CATEGORY_PAGE_SIZE
    page_items = categories[start:start + CATEGORY_PAGE_SIZE]

    if not categories:
        return 'No active categories.\n0. Cancel', [], False

    lines = ['Select category:'] + [f'{i}. {c.name}' for i, c in enumerate(page_items, 1)]
    has_more = start + CATEGORY_PAGE_SIZE < len(categories)
    if has_more:
        lines.append('9. More')
    if page > 1:
        lines.append('8. Prev')
    lines.append('0. Cancel')
    return _fit('\n'.join(lines)), page_items, has_more


def _my_tickets(phone):
    """Tickets the caller is allowed to see:
      - linked user account (User.phone == phone) → their username's tickets
      - no linked account → created_by == 'ussd:<phone>'
    Ownership is enforced server-side by this query shape — a caller can never
    reach another phone's (or another user's) tickets from the menu."""
    linked = User.query.filter_by(phone=phone).first()
    if linked:
        rows = Ticket.query.filter_by(created_by=linked.username) \
            .order_by(Ticket.created_at.desc()).limit(5).all()
    else:
        rows = Ticket.query.filter_by(created_by=f'ussd:{phone}') \
            .order_by(Ticket.created_at.desc()).limit(5).all()

    if not rows:
        return 'No tickets found for this number.'

    lines = ['Your tickets:']
    for i, t in enumerate(rows, 1):
        short = t.title if len(t.title) <= 18 else t.title[:17] + '…'
        lines.append(f'{i}. {t.ticket_number} {t.status} {short}')
    return '\n'.join(lines)


def _kb_search(keyword):
    keyword = (keyword or '').strip()
    if not keyword:
        return 'Enter a keyword to search.'

    # Simple LIKE, title only, top 3 — no ML, counts as "best effort" KB access.
    try:
        rows = KnowledgeArticle.query \
            .filter(KnowledgeArticle.is_published.is_(True)) \
            .filter(KnowledgeArticle.title.like(f'%{keyword}%')) \
            .order_by(KnowledgeArticle.created_at.desc()).limit(3).all()
    except Exception:
        db.session.rollback()
        return 'Knowledge Base is unavailable right now.'

    if not rows:
        return 'No articles matched. Try a different word.'
    lines = ['KB results:'] + [f'{i}. {r.title[:48]}' for i, r in enumerate(rows, 1)]
    return '\n'.join(lines)


def _system_status():
    """The System Status item must actually touch the database, not hardcode OK."""
    try:
        db.session.execute(sqla_text('SELECT 1')).fetchall()
        return 'System is up.'
    except Exception:
        db.session.rollback()
        return 'System unavailable.'


def _create_ussd_ticket(phone, report):
    """Create a ticket in the shared Ticket table. Returns the ticket number.
    Priority defaults to 'medium' (deliberate v1 choice — no priority menu yet).
    client_uuid stays NULL: USSD has no client UUID; the session idempotency
    guard covers gateway retries for this path."""
    category = _resolve_category(report.get('category'))
    title = (report.get('title') or '').strip()[:120] or 'USSD issue'
    description = (report.get('description') or '').strip()[:160] or title
    created_by = f'ussd:{phone}'

    for _ in range(5):
        ticket_number = _next_ticket_number()
        ticket = Ticket(
            ticket_number=ticket_number,
            title=title,
            description=description,
            category=category,
            priority='medium',
            created_by=created_by,
            client_uuid=None,
        )
        apply_sla(ticket)
        db.session.add(ticket)
        try:
            db.session.commit()
            log_audit(f'ussd:{_mask(phone)}', 'create', 'ticket', ticket.id,
                      json.dumps({
                          'ticket_number': ticket_number,
                          'action': 'ussd_ticket_created',
                          'session_keyed_by_phone': True,
                      }))
            # The same notifications the web path sends, so admins/assignees
            # learn about USSD reports immediately.
            admins = [a.username for a in User.query.filter_by(role='admin').all()]
            notify_users(set(admins), 'ticket_update',
                         f'New USSD ticket {ticket_number}: {title}',
                         str(ticket.id),
                         f'New ticket: {ticket_number}',
                         f'USSD ticket from {_mask(phone)}:\n\n{title}\n\n{description}')
            emit_event('ticket.created', {
                'id': ticket.id, 'ticket_number': ticket_number,
                'title': title, 'priority': 'medium', 'status': ticket.status,
            })
            db.session.commit()
            return ticket_number
        except IntegrityError:
            # Collision on ticket_number (parallel request picked the same one)
            # — rollback and retry with the next number.
            db.session.rollback()

    raise RuntimeError('Could not generate a unique ticket number')


# ---------------------------------------------------------------------------
# Menu handler: pure transition given (session state, input parts, payload).
# Returns (response_body, end:bool, next_state:str, payload:dict).
# Side effects (ticket creation) happen ONLY on the confirmed transition.
# ---------------------------------------------------------------------------
def _dispatch(session, phone, parts):
    state = session.state

    # Africa's Talking sends the FULL cumulative path every time ("1", then
    # "1*2", then "1*2*Looking for printer"), so earlier segments are the
    # recorded navigation and the LAST segment is the current user input.
    # For free-text steps a title/description given on its own is parts[0]
    # (== parts[-1]); if it contains '*', we take the final segment only.
    action = parts[-1] if parts else ''

    payload = dict(session.payload)
    report = dict(_load(payload, 'report') or {})

    if state == ST_NEW:
        if action == '':
            return MENU_MAIN, False, ST_NEW, {}
        if action == '1':
            return 'Enter a short title (max 120 chars):', False, ST_REPORT_TITLE, {'report': {}}
        if action == '2':
            return _my_tickets(phone), True, ST_MY_TICKETS, {}
        if action == '3':
            return 'Enter a keyword to search:', False, ST_KB_SEARCH, {}
        if action == '4':
            return _system_status(), True, ST_STATUS, {}
        return 'Invalid choice.\n' + MENU_MAIN, False, ST_NEW, {}

    if state == ST_REPORT_TITLE:
        if action == '0':
            return 'Cancelled.', True, ST_NEW, {}
        title = action[:120]
        report['title'] = title
        return 'Enter a short description (max 160 chars):', False, ST_REPORT_DESC, {'report': report}

    if state == ST_REPORT_DESC:
        if action == '0':
            return 'Cancelled.', True, ST_NEW, {}
        description = action[:160]
        report['description'] = description
        categories = _active_categories()
        body, page_items, _ = _category_menu(categories, 1)
        payload['report'] = report
        payload['cat_page'] = 1
        return body, False, ST_REPORT_CATEGORY, payload

    if state == ST_REPORT_CATEGORY:
        categories = _active_categories()
        page = int(_load(payload, 'cat_page', 1) or 1)
        start = (page - 1) * CATEGORY_PAGE_SIZE
        page_items = categories[start:start + CATEGORY_PAGE_SIZE]

        if action == '0':
            return 'Cancelled.', True, ST_NEW, {}
        if action == '9' and start + CATEGORY_PAGE_SIZE < len(categories):
            next_page = page + 1
            body, items, _ = _category_menu(categories, next_page)
            payload['cat_page'] = next_page
            return body, False, ST_REPORT_CATEGORY, payload
        if action == '8' and page > 1:
            prev_page = page - 1
            body, items, _ = _category_menu(categories, prev_page)
            payload['cat_page'] = prev_page
            return body, False, ST_REPORT_CATEGORY, payload
        if action.isdigit() and 1 <= int(action) <= len(page_items):
            report['category'] = page_items[int(action) - 1].name
            payload['report'] = report
            confirm = (
                f'Confirm report?\n'
                f'Title: {report.get("title", "")[:40]}\n'
                f'Category: {report.get("category", "")}\n'
                f'1. Yes\n2. Change category\n0. Cancel'
            )
            return confirm, False, ST_REPORT_CONFIRM, payload
        return 'Invalid selection.\n0. Cancel', False, ST_REPORT_CATEGORY, payload

    if state == ST_REPORT_CONFIRM:
        if action == '1':
            try:
                ticket_number = _create_ussd_ticket(phone, report)
            except RuntimeError as exc:
                db.session.rollback()
                return f'Could not create ticket. Try again.', True, ST_NEW, {}
            return f'Ticket {ticket_number} created.', True, ST_NEW, {}
        if action == '2':
            categories = _active_categories()
            body, _, _ = _category_menu(categories, 1)
            payload['cat_page'] = 1
            return body, False, ST_REPORT_CATEGORY, payload
        return 'Cancelled.', True, ST_NEW, {}

    if state == ST_KB_SEARCH:
        if action == '0':
            return 'Cancelled.', True, ST_NEW, {}
        return _kb_search(action), True, ST_NEW, {}

    # MY_TICKETS / STATUS reached directly only via the main menu; a leftover
    # session here is unusable, so bounce back to the main menu.
    return MENU_MAIN, False, ST_NEW, {}


# ---------------------------------------------------------------------------
# The single entry point the gateway calls.
# ---------------------------------------------------------------------------
@ussd_bp.route('/ussd', methods=['POST'])
@limiter.limit('600 per minute', override_defaults=True)
def ussd_entry():
    """Handle one USSD "page". Always idempotent on (session_id, text)."""
    parsed = parse_gateway_request(request)
    session_id = parsed['session_id']
    phone = parsed['phone']
    text = parsed['text']

    if not session_id or not phone:
        return Response('END Invalid request.', content_type='text/plain; charset=utf-8', status=400)

    parts = [p.strip() for p in text.split('*') if p.strip()]

    session = UssdSession.query.filter_by(session_id=session_id).first()
    if session is None:
        session = UssdSession(session_id=session_id, phone=phone,
                              state=ST_NEW, payload_json=json.dumps({}))
        db.session.add(session)
    elif session.phone != phone or (session.created_at and
                                    session.updated_at and
                                    utcnow() - session.updated_at
                                    > timedelta(seconds=SESSION_TTL_SECONDS)):
        # Same sessionId seen from a different phone, or the session aged past
        # the gateway TTL — treat as a brand new session so we never attach a
        # later caller's ticket to an earlier caller's session.
        session.phone = phone
        session.state = ST_NEW
        session.payload = {}

    # ---- Idempotency guard: identical (state, text) replay returns the
    # cached response without re-running the transition (prevents double
    # ticket creation when the gateway retries the same request). ----
    stored = session.payload
    if stored.get('last_text') == text and stored.get('last_state') == session.state \
            and stored.get('last_response'):
        return Response(stored['last_response'], content_type='text/plain; charset=utf-8')

    # ---- Run the transition. ----
    body, end, next_state, next_payload = _dispatch(session, phone, parts)
    response_text = _render(body, end=end)

    session.state = next_state
    session.payload = dict(next_payload, last_text=text, last_state=next_state,
                           last_response=response_text)

    # ---- Audit: masked phone only — we never write the full number or any
    # auth material into the audit trail as a display value. ----
    log_audit(
        f'ussd:{_mask(phone)}',
        'ussd',
        'ussd_session',
        session_id,
        json.dumps({
            'input_state': stored.get('last_state') or session.state or '',
            'result_state': next_state,
            'outcome': 'ticket_created' if (next_state == ST_NEW and end and 'created' in response_text) else 'menu',
            'terminated': bool(end),
        }),
    )

    db.session.commit()
    return Response(response_text, content_type='text/plain; charset=utf-8')


# ---------------------------------------------------------------------------
# Live-schema backfill helper, wired into __main__ and docker-entrypoint.
# ---------------------------------------------------------------------------
def ensure_ussd_schema():
    """Add users.phone to pre-existing tables and create ussd_sessions on live
    MySQL that predates this migration. Idempotent, mirrors the other
    ensure_*_schema() helpers in app.py."""
    try:
        inspector = db.inspect(db.engine)
        tables = set(inspector.get_table_names())
        if 'users' in tables:
            cols = {c['name'] for c in inspector.get_columns('users')}
            if 'phone' not in cols:
                with db.engine.begin() as connection:
                    connection.execute(sqla_text('ALTER TABLE users ADD COLUMN phone VARCHAR(20) UNIQUE'))
        if 'ussd_sessions' not in tables:
            db.create_all()
        logger.info('USSD schema compatibility verified')
    except Exception as exc:
        logger.warning(f'Could not ensure ussd schema compatibility: {exc}')