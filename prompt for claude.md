You are working on the ICT E-Ticketing System — an internal ticketing
system for an ICT department. This prompt is your complete onboarding
brief. Treat it as the ground truth; the rules below OUTRANK any
assumption you have about web projects. If a task conflicts with these
rules, the rules win and you must stop and ask.

## 0. Before you write any code

Read these files first — they define reality:
- backend/models.py   (all 19 SQLAlchemy models)
- backend/routes/*.py + backend/ussd.py  (every blueprint and route)
- backend/helpers.py  (SLA, notify, audit, webhooks, serializers)
- backend/app.py      (extension binding, server-side scoping)
- frontend/shared/css/style.css  (:root tokens + theme overrides)
- frontend/shared/js/icons.js    (Icons.render — the only icon source)

Never assume a file's content from memory. Grep first, read the actual
current file, then act. The project has a documented history of stale
copies in other folders (/Desktop/E-Ticketing_system, /Desktop/new/
E-Ticketing_system) — confirm the live folder before writing.

## 1. Stack (verified)

- Backend: Python 3.13.x, Flask 2.3.2, SQLAlchemy 2.0.19 (PyMySQL 1.1.0),
  today working across a 113-test unittest suite (backend/tests/, runs
  against isolated in-memory SQLite).
- Frontend: Vanilla JS + HTML + CSS. NO frameworks, NO build step.
- Database: MySQL (XAMPP bundle at /opt/lampp/bin/mysql).
- Auth: JWT (flask-jwt-extended 4.6.0), access + refresh tokens stored
  in sessionStorage (deliberate, not localStorage).
- Architecture: two separate portals (frontend/user/index.html and
  frontend/admin/index.html) sharing ONE backend and ONE database.
  NOT role-based UI toggling. User markup never contains admin controls.
- requirements.txt: Flask, Flask-CORS, Flask-SQLAlchemy, flask-limiter,
  python-dotenv, pymysql, sqlalchemy, flask-jwt-extended, authlib, requests.

## 2. Folder structure (do not restructure)

backend/
  app.py                  # thin entry: create app, bind extensions,
                          #   register blueprints, re-export db/models/schema
  extensions.py           # unbound db, jwt, limiter, oauth, logger, utcnow()
  models.py               # 19 models (see Section 3)
  helpers.py              # settings, SLA, serialize/notify/audit/webhooks/auth utils
  schema.py               # ensure_*_schema backfills + seed_* + bootstrap_database()
  routes/                 # blueprints: __init__.py, auth.py, tickets.py,
                          #   users.py, notifications.py, knowledge.py,
                          #   admin.py, v1.py, main.py
  ussd.py                 # USSD endpoint + UssdSession
  totp.py
  requirements.txt, Dockerfile, docker-entrypoint.sh
  alembic.ini + migrations/, tests/ (unittest, isolated sqlite)
  .env                    # secrets — never commit
frontend/
  login.html, reset-password.html
  shared/css/style.css | shared/js/{api.js,events.js,icons.js,auth.js,
      password-field.js,notification-prefs.js}
  user/index.html, user/js/app.js, user/sw.js
  admin/index.html, admin/js/app.js
AGENTS.md, docker-compose.yml, README.md, MIGRATION.md

Legacy reference files stay in backend/ (API_endpoints, Database_schema,
user_table, database/, instance/, uploads/) — reference only, NOT part
of the import graph. Never import them.

## 3. Schema — verify against backend/models.py, do not invent columns

There are 19 models. The core set:

- Ticket: id, ticket_number (ICT-XXXXX, unique), title, description,
  category, priority (low/medium/high), status (open/in_progress/
  resolved), assigned_to (username), created_by (username),
  created_at, updated_at, resolution
- User: id, username (unique, IMMUTABLE), email (unique), password_hash,
  role (staff/admin), department, is_active, failed_login_attempts,
  locked_until
- KnowledgeArticle, Notification, TicketComment, TicketAttachment,
  Category, Department, Role, PasswordResetToken, AuditLog,
  SystemSetting, SystemEvent, TaskRun, ProcessedEmail, ApiToken,
  Webhook, SocialAccount, NotificationPreference, UssdSession.

Rules:
- Soft-delete (is_active = False) for User, Category, Department — they
  are referenced by name/username elsewhere. NEVER hard-delete them.
- Hard-delete allowed ONLY for Ticket and TicketComment (admin-only) —
  nothing references them.
- username is immutable and referenced across tickets/comments. NEVER
  propose renaming it.

## 4. Endpoint inventory (verified by grep — do not wander beyond it)

Blueprints: auth, tickets, users, notifications, knowledge, admin,
v1, main, ussd.

- auth: /api/auth/login, verify-2fa, register, refresh, 2fa,
  2fa/setup, 2fa/setup/verify, 2fa/disable, forgot-password,
  reset-password, <provider>/login, <provider>/callback
- tickets: /api/tickets (GET/POST), /api/tickets/<id> (GET/PUT/DELETE),
  /api/tickets/<id>/comments (GET/POST),
  /api/tickets/<id>/attachments (GET/POST),
  /api/attachments/<id>/download, /api/attachments/<id> (DELETE)
- users: /api/users (GET/POST), /api/users/<id> (DELETE/ PUT),
  /api/users/<id>/reactivate, /api/users/me,
  /api/users/me/password, /api/users/me/username,
  /api/users/me/notification-preferences (GET/PUT),
  /api/users/<id>/link-phone
- notifications: /api/notifications (GET/POST),
  /api/notifications/<id>/read, read-all, broadcast, preferences (GET/PUT)
- knowledge: /api/kb/articles (GET/POST), /api/kb/articles/<id> (GET/PUT/DELETE)
- admin: /api/categories, /api/departments, /api/roles (GET/POST/DELETE),
  /api/settings (GET/PUT), /api/reports/summary,
  /api/reports/export/{tickets,users,audit}.csv, /api/audit/logs (GET/DELETE),
  /api/tokens (GET/POST/DELETE), /api/webhooks (GET/POST/PUT/DELETE)
- main: /api/health, / (serves login), /login, /reset-password, /share,
  /user, /admin, /<path>, /api/dashboard/stats, /api/events/stream (SSE)
- v1 (API-token auth): /api/v1/tickets (GET/POST), /api/v1/tickets/<id>,
  /api/v1/stats, /api/v1/kb
- ussd: /ussd (POST)

## 5. Auth and access control — SERVER-SIDE, mandatory

- JWT via flask-jwt-extended; tokens in sessionStorage.
- GET /api/tickets and /api/tickets/<id> are scoped by created_by UNLESS
  caller is admin. Enforced in backend/app.py, never just hidden in JS.
- Staff cannot change ticket status or delete tickets. Admin-only, on the
  server.
- The User Portal never receives admin-only markup or logic.

## 6. Standing principles (apply without being re-told)

S1  No redesign without explicit consent. Incremental changes only.
S2  Never fabricate data or capability — no fake ML, fake SLA math,
    pretend intelligence. If infrastructure doesn't exist, say so.
S3  Verify before building. Check a file's ACTUAL current content before
    writing on top of it. (Stale-copy + "backend done, JS forgotten"
    incidents happened >4 times.)
S4  Smaller passes over big-bang rewrites. Max two items per pass,
    verify between passes. Never one giant multi-feature patch.
S5  Defensive CSS vars: use var(--x, fallback) or verify the :root block.
S6  Full validation after every patch: syntax check, HTML tag-balance,
    getElementById-vs-id cross-reference. "Server starts fine" is not enough.
S7  Ownership/role checks belong on the server (app.py), not just the UI.

## 7. Environment risks

E1  The venv named venv_311 actually runs Python 3.13.x (verified). Do
    NOT trust a venv's name — run `python --version` inside it first and
    check SQLAlchemy version. If a task's Python version assumption
    conflicts with reality, stop and report.
E2  MySQL is XAMPP's instance at /opt/lampp/bin/mysql. Startup failures
    are usually just XAMPP's MySQL not started —
    `sudo /opt/lampp/lampp startmysql`.
E3  Migrations are MANUAL. db.create_all() creates new tables but never
    alters existing ones. Every schema change to an existing table needs
    a stated ALTER TABLE. If your task implies a column that doesn't
    exist yet, that's the cause of "code right, column missing" crashes.
E4  A junior dev once deleted all user rows via phpMyAdmin. Preserve the
    recovery path (a Python script using generate_password_hash); never
    block or damage it.

## 8. Offline-first (ABSOLUTE for any frontend work)

The UI must NEVER look broken/degraded without internet:
O1  No remote fonts, icons, images, CSS, or CDN scripts. System stack only.
    All icons via Icons.render (inline SVG).
O2  Renders identically with the network off. No layout shift. No missing
    glyphs.
O3  State persists in localStorage/sessionStorage. Active route highlight
    derives from the URL, not a fetch.
O4  No nav/nav-adjacent affordance depends on a fetch to render.
O5  No skeleton loaders inside the nav (nav is static markup + a toggle).
O6  Theme toggle works offline, persists, no FOUC — inline <head> script
    sets the class before first paint.
O7  User's explicit theme choice always wins over OS preference.
O8  Avatars are inline SVG monograms or local images. Never remote.
O9  Panels needing network data show an honest "requires connection"
    message offline. Never silently fail or hang.

## 9. Universal visibility meta-ruleset (Section 13 of AGENTS.md)

This is the "can I actually read it / does it hide behind something?"
ruleset. Run through every item before finishing work:

- Text: WCAG AA (>=4.5:1 body, >=3:1 large/disabled) against its ACTUAL
  background (check the surface's selector, not the page). Badges use
  tint-and-ink pairs from the same token family. No silent truncation
  (give title attr / wrapping). No text below 12px. Line-height >=1.3
  body, >=1.2 headings.
- Icons: inside inputs = vertically centered, inside the input's padding,
  never overlapping typed text (pad-right the input); real buttons with
  aria-label and tabindex; stable box on toggle. In buttons: flex-centered
  with label. Sort arrows inline with header text. Row actions vertically
  centered, consistent gaps, aria-label. All icons via Icons.render,
  currentColor, aria-hidden when decorative.
- Tooltips/dropdowns: never clipped by ancestor overflow (portal to body
  or fix overflow), render above sticky headers/sidebars, reposition at
  viewport edges, hover + focus-visible, Escape + outside-click to close
  with focus return, role=tooltip + aria-describedby.
- Sticky elements: scroll-padding-top/bottom so content isn't covered.
- Modals: above everything, not clipped, max-height 90vh + internal
  scroll, fit viewport, focus trap, Escape closes, role=dialog +
  aria-modal + aria-labelledby.
- Theme safety: every color is a token defined in EVERY theme block; new
  tokens go in every block; pairs pass AA in every theme; focus rings
  visible; disabled text >=3:1.
- Responsive: test at 320/375/480/768/1024/1440/1920. No body horizontal
  scroll. Wide content scrolls in its own container. Collapse to single
  column <=768px. Touch targets >=40x40px on <=768px, >=8px apart. Hover-only
  affordances need a tap equivalent.
- Offline parity: shell renders without network; no layout shift on drop;
  cached data with last-synced note; uncached shows honest "requires
  connection"; no remote assets; writes queued or disabled with reason.
- Layout: no absolute/fixed element overlaps another element's content;
  z-index follows a documented scale (base 0, sticky header 100,
  dropdown 200, tooltip 300, modal 1000, toast 2000); no negative-margin
  overlap; no clipping by overflow:hidden unless an explicit scroll
  container; no two features claim the same fixed region.

## 10. Deliberately deferred / already built — do NOT rebuild or fake

Already built during the refactor (verify before extending):
- CSV/Excel export -> /api/reports/export/*.csv in routes/admin.py
- SLA tracking/breach detection -> Ticket.sla_response_due,
  sla_resolution_due, apply_sla(), run_sla_sweep() in helpers.py
  (countdown UI is NOT built)
- Email notifications (SMTP) -> send_email() in helpers.py (fires when
  SMTP env vars set)
- Technician-reply and announcement notification triggers -> wired in
  routes/tickets.py and routes/notifications.py

NOT built — do not assume they exist, do not "helpfully" add them:
assets/CMDB, custom queue builder, article review workflow, duplicate
article detection, internal notes vs public replies, parent-child ticket
linking, KB useful/not-useful feedback, KB suggestion-while-typing. If a
task needs one, flag it as out of scope rather than implementing it.

## 11. Open verification (do not claim done until run)

V1: Docker end-to-end smoke test (docker compose up, app boot, MySQL
connection, bootstrap_database, login/create/list ticket inside the
container) has NOT been run on a Docker machine. Do not claim the
containerized deploy path works.

## 12. How to work on a task

1. Inspect first: grep for the markers you expect, read the actual files,
   report what you find (including what you expected but didn't find).
2. Plan in <=6 bullets: what changes, which files, what's out of scope,
   which S/E/O/visibility rules apply, any stop condition.
3. Smallest change: if it spans more than 2 files, split it and say so.
4. Implement: label every edit by full path, show full modified blocks,
   preserve existing classes/ids/tokens, no new dependencies.
5. Verify: syntax check every modified file, HTML tag balance,
   getElementById-vs-id cross-ref, offline checks, schema/ALTER TABLE
   check (E3).
6. Report using the checklist format in AGENTS.md Section 8/13.9
   (text visibility, icon positioning, tooltips/dropdowns, modals,
   theme safety, responsiveness, offline parity, layout).

## 13. Stop and ask if any of these are true

- A change violates S1–S7 or the offline rules O1–O9.
- The task requires a deferred feature (Section 10).
- A venv's real Python version is not 3.11.x (E1).
- A schema change alters an existing table without a stated ALTER TABLE.
- The task touches login.html or reset-password.html without permission.
- Multiple repo copies exist and the live server's folder is unknown.
- A required asset (avatar/icon/font) doesn't exist locally and a remote
  substitute would violate O1.
- The change would span more than two files and cannot be split.
- A feature cannot meet WCAG AA without a new token, or needs a z-index
  above the documented scale.

## 14. One-line summary

Verify the codebase before trusting any claim. Never fabricate. Smaller
passes. Server-side scoping. Offline-first frontend. System fonts and
inline SVG only. Stop and ask when in doubt.