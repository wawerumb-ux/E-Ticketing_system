"""Health, frontend page serving, dashboard stats and the SSE event stream."""

import os

from flask import (
    Blueprint,
    Response,
    current_app,
    jsonify,
    render_template_string,
    request,
    send_from_directory,
)
from flask_jwt_extended import decode_token, jwt_required

from extensions import db, utcnow
from helpers import _run_periodic_tasks, cache_get, cache_key, cache_set
from models import SystemEvent, Ticket
from qr import qr_svg
from datetime import timedelta
import json
import time

main_bp = Blueprint('main', __name__)


@main_bp.route('/api/health', methods=['GET'])
def health_check():
    # Real probe, truthful output: try an actual round-trip to the database.
    # Never echo the database URI/host/credentials — health is public.
    try:
        db.session.execute(db.text('SELECT 1'))
        return jsonify({'status': 'healthy', 'database': True}), 200
    except Exception:
        # Do NOT leak why (no driver error text, no URI) — but say which
        # dependency is down so consumers never see a lying 'healthy'.
        return jsonify({'status': 'degraded', 'database': False,
                        'service': 'database-unreachable'}), 503


# ============ FRONTEND SERVING ============

@main_bp.route('/')
def serve_login():
    # Root deliberately serves login.html directly (200, not a redirect): it is
    # the short link printed in the startup banner (http://<host>:<port>/),
    # resolves straight to the login page, and avoids an extra redirect hop.
    return send_from_directory('../frontend', 'login.html')


@main_bp.route('/login')
def serve_login_page():
    return send_from_directory('../frontend', 'login.html')


@main_bp.route('/reset-password')
def serve_reset_password():
    return send_from_directory('../frontend', 'reset-password.html')


def _detect_lan_ips():
    """LAN IPv4 addresses detected by app.py (lazy import avoids a circular
    import at blueprint registration time)."""
    from app import _lan_ipv4_addresses as _detect
    return _detect()


def _share_base_url():
    """The address the current viewer is using, with a blocked-in LAN URL
    when they reached the server via localhost."""
    scheme = request.headers.get('X-Forwarded-Proto') or request.scheme
    host = request.host
    hostname = host.rsplit(':', 1)[0]
    port = host[len(hostname):]
    if hostname in ('localhost', '127.0.0.1') or hostname.startswith('127.'):
        lan_ips = _detect_lan_ips()
        if lan_ips:
            host = lan_ips[0] + port
    return f'{scheme}://{host}'


@main_bp.route('/share')
def serve_share_page():
    """Self-contained share page: same-Wi-Fi link, portal links and a QR
    code for phone scanning. No external assets (offline-safe)."""
    base = _share_base_url()
    user_url = f'{base}/user'
    admin_url = f'{base}/admin'
    try:
        svg = qr_svg(base)
    except ValueError:
        svg = ''

    page = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ICT Ticketing — Share access</title>
<style>
  :root {
    --bg: #f1f5f9; --surface: #ffffff; --text: #0f172a; --muted: #475569;
    --border: #cbd5e1; --accent: #1d4ed8; --accent-text: #ffffff;
    --ok-bg: #dcfce7; --ok-text: #14532d;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b1220; --surface: #111a2e; --text: #f1f5f9; --muted: #cbd5e1;
      --border: #334155; --accent: #60a5fa; --accent-text: #0b1220;
      --ok-bg: #052e16; --ok-text: #bbf7d0;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif; line-height: 1.5;
  }
  main {
    max-width: 560px; margin: 0 auto; background: var(--surface);
    border: 1px solid var(--border); border-radius: 12px; padding: 24px;
  }
  h1 { font-size: 1.25rem; line-height: 1.2; margin: 0 0 4px; }
  p { margin: 6px 0; }
  .muted { color: var(--muted); }
  .link-line {
    display: flex; align-items: center; gap: 8px; margin: 16px 0;
  }
  #access-link {
    flex: 1; min-width: 0; padding: 10px 12px; border: 1px solid var(--border);
    border-radius: 8px; background: var(--bg); color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9rem; overflow-wrap: anywhere;
  }
  button {
    min-height: 44px; padding: 10px 14px; border: 0; border-radius: 8px;
    background: var(--accent); color: var(--accent-text); font-size: 0.9rem;
    font-weight: 600; cursor: pointer;
  }
  button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .qr-box { text-align: center; margin: 20px 0; }
  .qr-box svg { max-width: 260px; height: auto; }
  .note {
    background: var(--ok-bg); color: var(--ok-text); border-radius: 8px;
    padding: 10px 12px; font-size: 0.85rem;
  }
  ul { margin: 8px 0; padding-left: 20px; }
  li { margin: 4px 0; }
  a { color: var(--accent); overflow-wrap: anywhere; }
  code { overflow-wrap: anywhere; }
  footer { margin-top: 16px; font-size: 0.8rem; color: var(--muted); }
  .screen-reader { position: absolute; width: 1px; height: 1px; overflow: hidden; }
</style>
<script>
  (function () {
    var link = {{ link_json|safe }};
    function fallbackCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
    }
    function showCopied() {
      var btn = document.getElementById('copy-btn');
      var label = btn.getAttribute('data-copied') || 'Copied';
      btn.textContent = label;
      setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
    }
    (function () {
      var btn = document.getElementById('copy-btn');
      if (!btn) { return; }
      btn.addEventListener('click', function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(showCopied, function () {
            fallbackCopy(link); showCopied();
          });
        } else {
          fallbackCopy(link); showCopied();
        }
      });
    })();
  })();
</script>
</head>
<body>
<main>
  <h1>ICT Ticketing — share access</h1>
  <p class="muted">Open this page on the machine running the system, then send
     the link to testers on the same Wi-Fi.</p>

  <div class="note">Works on phones and computers connected to the <strong>same
     network</strong> as this server. An account is required to log in.</div>

  <div class="link-line">
    <span id="access-link" role="text">{{ base }}</span>
    <button id="copy-btn" type="button" aria-label="Copy the host link">Copy</button>
  </div>

  <div class="qr-box" aria-hidden="true">
    {{ svg|safe }}
  </div>

  <p class="muted" style="text-align:center">Phone: scan with the camera app or
     open the link above.</p>

  <p class="muted" style="margin-top:16px">Portal shortcuts</p>
  <ul>
    <li>User portal: <a href="{{ user_url }}" title="{{ user_url }}">{{ user_url }}</a></li>
    <li>Admin portal: <a href="{{ admin_url }}" title="{{ admin_url }}">{{ admin_url }}</a></li>
  </ul>

  <footer>
    If testers cannot connect, check that the host firewall allows inbound on
    this port and that the server is running.
  </footer>
  <span class="screen-reader" id="screen-reader-note" aria-hidden="true"></span>
</main>
</body>
</html>"""
    return Response(
        render_template_string(
            page,
            base=base,
            link_json=json.dumps(base),
            svg=svg,
            user_url=user_url,
            admin_url=admin_url,
        ),
        mimetype='text/html',
    )


@main_bp.route('/user')
def serve_user_frontend():
    return send_from_directory('../frontend/user', 'index.html')


@main_bp.route('/admin')
def serve_admin_frontend():
    return send_from_directory('../frontend/admin', 'index.html')


@main_bp.route('/<path:path>')
def serve_static(path):
    frontend_path = os.path.join('../frontend', path)
    if os.path.exists(frontend_path):
        return send_from_directory('../frontend', path)
    return jsonify({'error': 'File not found'}), 404


# ============ DASHBOARD ============

DASHBOARD_STATS_TTL_S = 30
DASHBOARD_STATS_KEY = cache_key('dashboard', 'stats')

@main_bp.route('/api/dashboard/stats', methods=['GET'])
@jwt_required()
def get_dashboard_stats():
    _run_periodic_tasks()
    cached = cache_get(DASHBOARD_STATS_KEY)
    if cached is not None:
        return jsonify(cached), 200

    total = Ticket.query.count()
    open_tickets = Ticket.query.filter_by(status='open').count()
    in_progress = Ticket.query.filter_by(status='in_progress').count()
    resolved = Ticket.query.filter_by(status='resolved').count()

    high_priority = Ticket.query.filter_by(priority='high').count()
    medium_priority = Ticket.query.filter_by(priority='medium').count()
    low_priority = Ticket.query.filter_by(priority='low').count()

    active_tickets = Ticket.query.filter(Ticket.status.in_(['open', 'in_progress'])).all()
    now = utcnow()
    sla_response_breached = sum(1 for t in active_tickets if t.sla_response_due and now > t.sla_response_due)
    sla_resolution_breached = sum(1 for t in active_tickets if t.sla_resolution_due and now > t.sla_resolution_due)

    payload = {
        'total': total,
        'open': open_tickets,
        'in_progress': in_progress,
        'resolved': resolved,
        'priority_breakdown': {
            'high': high_priority,
            'medium': medium_priority,
            'low': low_priority
        },
        'sla': {
            'active_tickets': len(active_tickets),
            'response_breached': sla_response_breached,
            'resolution_breached': sla_resolution_breached
        }
    }
    cache_set(DASHBOARD_STATS_KEY, payload, DASHBOARD_STATS_TTL_S)
    return jsonify(payload), 200


# ============ REAL-TIME EVENTS (SSE) ============

@main_bp.route('/api/events/stream')
def event_stream():
    token = request.args.get('token')
    if not token:
        return jsonify({'error': 'Token required'}), 401
    try:
        decode_token(token)
    except Exception:
        return jsonify({'error': 'Invalid token'}), 401

    cursor = int(request.args.get('last_id', 0) or 0)

    # Opportunistic purge of events older than 7 days.
    cutoff = utcnow() - timedelta(days=7)
    SystemEvent.query.filter(SystemEvent.created_at < cutoff).delete()
    db.session.commit()

    # A generator's body runs lazily from the WSGI layer, AFTER the
    # request/app context that existed when event_stream() returned has
    # already been popped (current_app is unbound there). Resolve the
    # real app object here, inside the request, and push it explicitly
    # around the DB work below.
    app = current_app._get_current_object()

    def generate():
        last = cursor
        yield ': connected\n\n'
        try:
            while True:
                with app.app_context():
                    _run_periodic_tasks()
                    events = SystemEvent.query \
                        .filter(SystemEvent.id > last) \
                        .order_by(SystemEvent.id.asc()) \
                        .limit(50).all()
                if events:
                    for ev in events:
                        last = ev.id
                        yield (f"id: {ev.id}\n"
                               f"event: {ev.type}\n"
                               f"data: {ev.payload}\n\n")
                        time.sleep(0.1)
                else:
                    time.sleep(2)
                    yield ': ping\n\n'
        except GeneratorExit:
            pass

    resp = Response(generate(), mimetype='text/event-stream')
    resp.headers['Cache-Control'] = 'no-cache'
    resp.headers['Connection'] = 'keep-alive'
    resp.headers['X-Accel-Buffering'] = 'no'
    return resp
