"""ICT Ticketing System — Flask application entry point.

This module is intentionally thin: it creates the Flask app, wires up the
extensions (DB, JWT, rate limiter, OAuth), registers the route blueprints and
re-exports the shared objects that older entry points expect:

  * gunicorn/docker-entrypoint:        ``app:app`` / ``from app import ...``
  * alembic (migrations/env.py):       ``from app import db``
  * tests:                             ``from app import app, db, seed_*``
  * ussd blueprint:                    registered here via register_blueprints()

The actual logic lives in ``extensions``, ``models``, ``helpers``, ``schema``
and the ``routes`` package.
"""

import os
import socket
import sys
import secrets
import shutil
import subprocess
import threading
import re
import select
import time
import atexit

# ============= RUN-AS-SCRIPT MODULE ALIAS ==================
# `python app.py` executes this file as __main__, so there is no module object
# named "app" for ussd.py / routes' `from app import (...)`. Without the alias
# below, that import re-executes this entire file as a fresh "app" module,
# which hits the imports at the bottom while they are still only partially
# initialized -> ImportError. Under `flask run` / gunicorn "app:app" this file
# is imported as module "app", so the guard is skipped.
if __name__ == '__main__':
    sys.modules['app'] = sys.modules['__main__']
# ===========================================================

from dotenv import load_dotenv
load_dotenv()

# ============= INTELLIGENT DATABASE DRIVER SETUP ======================
try:
    import MySQLdb  # noqa: F401
    print("✓ Using mysqlclient (native driver)")
except ImportError:
    import pymysql
    pymysql.install_as_MySQLdb()
    print("✓ Using PyMySQL (fallback driver)")
# ===============================================================

from flask import Flask, g, request
from flask_cors import CORS
from flask_jwt_extended import create_access_token, create_refresh_token  # noqa: F401 (re-export for callers)

from extensions import db, jwt, limiter, oauth
from helpers import configure_logging, metric_incr, metric_observe_latency, resolve_secret

configure_logging()


# ============= DATABASE CONFIGURATION =====================
def get_database_uri():
    """Get database URI with intelligent fallback options."""
    supabase_url = os.getenv('SUPABASE_DATABASE_URL')
    if supabase_url:
        return supabase_url

    custom_url = os.getenv('DATABASE_URL')
    if custom_url:
        return custom_url

    return 'mysql+pymysql://root:@127.0.0.1:3306/ict_ticketing'
# ==========================================================

app = Flask(__name__)
CORS(app)

app.config['SECRET_KEY'] = resolve_secret('SECRET_KEY')
app.config['JWT_SECRET_KEY'] = resolve_secret('JWT_SECRET_KEY')
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = 900       # 15 minutes
app.config['JWT_REFRESH_TOKEN_EXPIRES'] = 2592000  # 30 days
app.config['SQLALCHEMY_DATABASE_URI'] = get_database_uri()
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# ============ TICKET ATTACHMENTS ============
APP_ROOT = os.path.dirname(os.path.abspath(__file__))
app.config['UPLOAD_FOLDER'] = os.getenv('UPLOAD_FOLDER', os.path.join(APP_ROOT, 'uploads'))
app.config['MAX_CONTENT_LENGTH'] = 25 * 1024 * 1024  # 25 MB upper bound for any request body
# =============================================

# Bind the shared extensions to this app.
db.init_app(app)
jwt.init_app(app)    
limiter.init_app(app)
oauth.init_app(app)
from extensions import logger  # noqa: E402

# ============ CLOUDFLARE TURNSTILE CONFIG ============
# Site key is public (embedded in the login/reset HTML). Secret is read by
# verify_turnstile() in helpers.py directly from the environment.
app.config['CF_TURNSTILE_SITE_KEY'] = os.getenv('CF_TURNSTILE_SITE_KEY', '')
app.config['CF_TURNSTILE_SECRET_KEY'] = os.getenv('CF_TURNSTILE_SECRET_KEY', '')
app.config['CF_TURNSTILE_ENABLED'] = os.getenv('CF_TURNSTILE_ENABLED', '').strip().lower() == 'true'
if app.config['CF_TURNSTILE_ENABLED'] and not app.config['CF_TURNSTILE_SECRET_KEY']:
    logger.warning(
        'CF_TURNSTILE_ENABLED is true but CF_TURNSTILE_SECRET_KEY is empty — '
        'login/reset Turnstile verification will reject all requests (fail-closed).'
    )
# ==============================================


# ============ OAUTH (SOCIAL LOGIN) SETUP ============
def get_public_base_url():
    """Best guess of the publicly reachable base URL for OAuth redirects."""
    return os.getenv('OAUTH_REDIRECT_URI', 'http://localhost:5000').rstrip('/')


oauth.register(
    name='google',
    client_id=os.getenv('OAUTH_GOOGLE_CLIENT_ID'),
    client_secret=os.getenv('OAUTH_GOOGLE_CLIENT_SECRET'),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid email profile'},
)

oauth.register(
    name='facebook',
    client_id=os.getenv('OAUTH_FACEBOOK_CLIENT_ID'),
    client_secret=os.getenv('OAUTH_FACEBOOK_CLIENT_SECRET'),
    access_token_url='https://graph.facebook.com/v19.0/oauth/access_token',
    authorize_url='https://www.facebook.com/v19.0/dialog/oauth',
    client_kwargs={'scope': 'email public_profile'},
)

# Instagram uses Facebook Login with the Instagram product enabled on the Meta app.
oauth.register(
    name='instagram',
    client_id=os.getenv('OAUTH_INSTAGRAM_CLIENT_ID') or os.getenv('OAUTH_FACEBOOK_CLIENT_ID'),
    client_secret=os.getenv('OAUTH_INSTAGRAM_CLIENT_SECRET') or os.getenv('OAUTH_FACEBOOK_CLIENT_SECRET'),
    access_token_url='https://graph.facebook.com/v19.0/oauth/access_token',
    authorize_url='https://www.facebook.com/v19.0/dialog/oauth',
    client_kwargs={'scope': 'instagram_basic email'},
)
# ============================================

# ============ SERVICE WORKER SCOPE ============
@app.after_request
def add_service_worker_scope(response):
    # The user portal page lives at '/user' (no trailing slash), which is outside
    # the sw.js default scope of '/user/'. Permit the worker to control the whole
    # origin — it still only caches the user shell + ticket GETs (see sw.js).
    if request.path == '/user/sw.js':
        response.headers['Service-Worker-Allowed'] = '/'
    return response
# ============================================

# ============ REQUEST CORRELATION LOGGING ============
@app.before_request
def _attach_request_id():
    g.request_id = secrets.token_hex(6)
    g.request_start = time.monotonic()
    if request.path.startswith('/events/'):
        logger.info('SSE stream open: %s', g.request_id)


@app.after_request
def _log_request_completion(response):
    if request.path.startswith('/events/'):
        return response
    start = getattr(g, 'request_start', None)
    if start is not None:
        ms = (time.monotonic() - start) * 1000
        logger.info('%s %s -> %s %.1fms', request.method, request.path, response.status_code, ms)
        metric_incr('requests_total')
        status_code = response.status_code
        cls = f'{status_code // 100}xx'
        cls = cls if cls in ('2xx', '4xx', '5xx') else 'other'
        metric_incr(f'requests_{cls}_total')
        metric_observe_latency('http_request', ms)
        if request.path == '/api/auth/login':
            if status_code == 200:
                metric_incr('auth_login_success_total')
            else:
                metric_incr('auth_login_failure_total')
    else:
        logger.info('%s %s -> %s', request.method, request.path, response.status_code)
    return response
# =====================================================

# ============ ROUTE BLUEPRINTS ============
# Imported/registered here (not at the top of the file) so db, the models and
# the shared helpers they import are already defined — no circular import.
from routes import register_blueprints  # noqa: E402
from routes import auth_bp, tickets_bp, users_bp, notifications_bp, knowledge_bp, admin_bp, v1_bp, main_bp  # noqa: E402,F401
from ussd import ussd_bp, ensure_ussd_schema  # noqa: E402

register_blueprints(app)
app.register_blueprint(ussd_bp)
# ==============================================

# ============ RE-EXPORTS (kept for tests / entrypoints / alembic) ============
from models import (  # noqa: E402
    ApiToken,
    AuditLog,
    Category,
    Department,
    KnowledgeArticle,
    Notification,
    NotificationPreference,
    PasswordResetToken,
    ProcessedEmail,
    SocialAccount,
    SystemEvent,
    SystemSetting,
    TaskRun,
    Ticket,
    TicketAttachment,
    TicketComment,
    User,
    Webhook,
)
from schema import (  # noqa: E402
    bootstrap_database,
    ensure_phase3_schema,
    ensure_phase4_schema,
    ensure_user_schema,
    seed_default_users,
    seed_settings,
    seed_starter_articles,
    seed_starter_categories,
    seed_starter_departments,
)
# =======================================================


def _is_private_ipv4(ip):
    """True for RFC1918 addresses (10/8, 172.16/12, 192.168/16)."""
    try:
        first = int(ip.split('.')[0])
        second = int(ip.split('.')[1])
    except (ValueError, IndexError):
        return False
    return (
        first == 10
        or (first == 172 and 16 <= second <= 31)
        or (first == 192 and second == 168)
    )


def _lan_ipv4_addresses():
    """Best-effort list of this machine's LAN IPv4 addresses, no network I/O."""
    candidates = set()

    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        try:
            probe.connect(('10.255.255.255', 1))
            candidates.add(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass

    try:
        _host, _aliases, addrs = socket.gethostbyname_ex(socket.gethostname())
        for addr in addrs:
            if not addr.startswith('127.'):
                candidates.add(addr)
    except (socket.gaierror, OSError):
        pass

    private = [ip for ip in sorted(candidates) if _is_private_ipv4(ip)]
    others = [ip for ip in sorted(candidates) if not _is_private_ipv4(ip)]
    return private + others


def _tunnel_status_text():
    """Single source for the banner's one 'Public' row."""
    if _tunnel_url:
        return f"{_tunnel_url.rstrip('/')}/"
    if _tunnel_started:
        return "(connecting… — will update in place when ready)"
    return "(tunnel unavailable — cloudflared not found)"


def _redraw_public_line(url):
    """Overwrite the banner's 'Public' row in place so the URL lands on that
    same single line (padding erases the logger prefix and the longer
    connecting/resolved text)."""
    row = f"  Public      : {url.rstrip('/')}/"
    sys.stdout.write("\r" + row.ljust(100) + "\n")
    sys.stdout.flush()


def _print_startup_banner(port):
    """Print a minimal startup banner: localhost, the primary LAN short link,
    and the public-tunnel status. Portals and the QR/share page are reachable
    from the short link. The port is passed explicitly so dev (5000) and the
    container (8000) both print the address users actually reach."""
    lan_ips = _lan_ipv4_addresses()

    logger.info("ICT E-Ticketing — server starting")
    logger.info("  Use locally : http://localhost:%d/", port)
    if lan_ips:
        logger.info(
            "  Short link  : http://%s:%d/   (portals & QR work from here)",
            lan_ips[0],
            port,
        )
    else:
        logger.info(
            "  Short link  : (no LAN IP detected — check network/firewall)"
        )

    logger.info("  Public      : %s", _tunnel_status_text())


# ============= PUBLIC TUNNEL (cloudflared Quick Tunnel) =============
# Launched as an external subprocess (never imported as a Python package).
# Dev-only convenience: the container entrypoint does not call start_tunnel().

_TUNNEL_URL_RE = re.compile(r'https://[a-z0-9-]+\.trycloudflare\.com')
_tunnel_process = None
_tunnel_url = None
_tunnel_started = False


def stop_tunnel():
    """Terminate the cloudflared subprocess if it is still running."""
    global _tunnel_process
    proc = _tunnel_process
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
        except OSError:
            pass
        logger.info("Public tunnel stopped")
    _tunnel_process = None


def _capture_tunnel_url(proc, timeout=30.0):
    """Read cloudflared's stderr until the trycloudflare URL appears (it prints
    there, not on stdout). Warns once after `timeout` seconds if the URL is
    still pending, but keeps listening in the background so a late URL is still
    logged when it arrives. Never blocks server startup."""
    global _tunnel_url
    deadline = time.monotonic() + timeout
    warned = False
    while True:
        if proc.poll() is not None:
            if _tunnel_url is None:
                logger.warning(
                    "Public tunnel: cloudflared exited before printing a URL "
                    "(code %s)",
                    proc.returncode,
                )
            return
        readable, _, _ = select.select([proc.stderr], [], [], 1.0)
        if not readable:
            if (not warned and _tunnel_url is None
                    and time.monotonic() >= deadline):
                warned = True
                logger.warning(
                    "Public tunnel: no URL from cloudflared within %.0fs — the "
                    "tunnel may still be connecting in the background and the "
                    "URL will be logged if it appears. LAN access works "
                    "regardless.",
                    timeout,
                )
            continue
        line = proc.stderr.readline()
        if not line:
            continue
        match = _TUNNEL_URL_RE.search(line)
        if match:
            if _tunnel_url is None:
                _tunnel_url = match.group(0)
                _redraw_public_line(_tunnel_url)
            return


def _cloudflared_install_hint():
    """Return the exact install commands for this machine's package manager.
    Dev-only help output, not an installer. Debian-family (apt) uses
    Cloudflare's official repo; everything else falls back to the raw binary."""
    if shutil.which('apt-get'):
        return (
            "sudo mkdir -p --mode=0755 /usr/share/keyrings\n"
            "curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg "
            "| sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null\n"
            "echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] "
            "https://pkg.cloudflare.com/cloudflared any main' "
            "| sudo tee /etc/apt/sources.list.d/cloudflared.list\n"
            "sudo apt-get update\n"
            "sudo apt-get install cloudflared"
        )
    return (
        'f=cloudflared-linux-amd64; '
        'case "$(uname -m)" in aarch64|arm64) '
        'f=cloudflared-linux-arm64;; esac\n'
        'curl -L -o /tmp/cloudflared '
        '"https://github.com/cloudflare/cloudflared/releases/latest/download/$f"\n'
        "sudo mv /tmp/cloudflared /usr/local/bin/cloudflared\n"
        "sudo chmod +x /usr/local/bin/cloudflared"
    )


def start_tunnel(port=5000):
    """Launch a Cloudflare Quick Tunnel pointing at the local Flask server and
    capture its public URL in the background. Returns the process handle, or
    None when cloudflared is not installed. Never blocks startup."""
    global _tunnel_process, _tunnel_started
    if _tunnel_started:
        return _tunnel_process
    binary = shutil.which('cloudflared')
    if not binary:
        logger.warning(
            "Public tunnel: cloudflared not found on PATH. Install it with:\n"
            "%s\n"
            "Authenticated LAN access still works.",
            _cloudflared_install_hint(),
        )
        return None
    _tunnel_started = True
    try:
        proc = subprocess.Popen(
            [binary, 'tunnel', '--url', f'http://localhost:{port}'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
    except OSError as exc:
        logger.warning("Public tunnel: could not launch cloudflared (%s)", exc)
        return None
    _tunnel_process = proc
    threading.Thread(
        target=_capture_tunnel_url, args=(proc,), daemon=True, name='tunnel-url'
    ).start()
    atexit.register(stop_tunnel)
    logger.info("Public tunnel: launching cloudflared (dev-only)…")
    return proc


if __name__ == '__main__':
    with app.app_context():
        bootstrap_database()
        logger.info(f"Using database: {app.config['SQLALCHEMY_DATABASE_URI']}")

    port = 5000
    start_tunnel(port)
    _print_startup_banner(port)

    try:
        app.run(debug=os.getenv('FLASK_DEBUG', 'false').lower() == 'true',
                host='0.0.0.0', port=port)
    except KeyboardInterrupt:
        stop_tunnel()
        sys.exit(0)