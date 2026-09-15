---
name: e-ticketing-master
description: Master ruleset for the E-Ticketing system. Applies to every OpenCode task on this repo. Encodes the project's verified schema, folder structure, standing design principles, environment risks, and offline-first constraints.
scope: repo
applies_to: entire repository
forbidden_tools: [web_fetch, http_request, package_install]
required_first_step: inspect
inherits_from: PROJECT_KNOWLEDGE_BASE.pdf
output_contract: structured_report
---

# E-Ticketing — Master Ruleset

## 0. What this is

The authoritative ruleset for every task on this repository. If a
task conflicts with this rule, this rule wins. Ask before deviating.

Read Section 1 and Section 2 once at the start of any task. Do not
assume they are current — verify with a read or grep before acting.

---

## 1. Verified project facts

### 1.1 Stack

- Backend: Flask + SQLAlchemy (PyMySQL driver), Python 3.13.x (verified working across the refactor's 61-test suite)
- Frontend: Vanilla JS, HTML, CSS. No frameworks. No build step.
- Database: MySQL
- Auth: JWT (flask-jwt-extended), access + refresh tokens
- Token storage: `sessionStorage` (deliberate — not `localStorage`)
- Architecture: two separate portals sharing one backend and one
  database. Not a single app with role-based UI toggling.

### 1.2 Folder structure (do not restructure)

```
backend/
  app.py                  # thin entry point: create app, bind extensions,
                          #   register blueprints, re-export db/models/schema
  extensions.py           # unbound db, jwt, limiter, oauth, logger, utcnow()
  models.py               # all SQLAlchemy models (see Section 1.3)
  helpers.py              # settings, SLA, serialize/notify/audit/webhooks, auth utils
  schema.py               # ensure_*_schema backfills + seed_* + bootstrap_database()
  routes/                 # blueprint package
    __init__.py           # ALL_BLUEPRINTS, register_blueprints(app)
    auth.py               # login / register / refresh / 2FA / reset / social
    tickets.py            # ticket CRUD, comments, attachments
    users.py              # users CRUD, me, link-phone, reset-2fa
    notifications.py      # notifications, broadcast, preferences
    knowledge.py          # KB article CRUD
    admin.py              # categories, departments, settings, reports/CSV,
                          #   audit logs, API tokens, webhooks
    v1.py                 # API-token-authenticated public endpoints
    main.py               # health, dashboard stats, SSE event stream, frontend serving
  ussd.py                 # USSD endpoint + UssdSession model + ensure_ussd_schema()
  totp.py
  requirements.txt
  Dockerfile
  docker-entrypoint.sh    # calls bootstrap_database(), then gunicorn app:app
  alembic.ini + migrations/
  tests/                  # unittest suite (isolated in-memory sqlite)
  .dockerignore
  .env                    # secrets — never commit
frontend/
  login.html
  reset-password.html
  shared/
    css/style.css
    js/api.js
    js/events.js
    js/icons.js
    img/
  user/
    index.html
    js/app.js
    sw.js
  admin/
    index.html
    js/app.js
.gitignore
AGENTS.md
docker-compose.yml
```

Legacy helper files remain in `backend/` (API_endpoints, Database_schema,
user_table, database/, instance/, uploads/). They are reference material and
runtime data, not part of the app import graph.

**Filename collision warning:** `user/index.html` and
`admin/index.html` share a name. Same for `app.js`. Always cite
full paths. Never upload both in one batch.

**Divergent copies (verified 2026-09-15):** only one copy remains —
`/home/devsling/Music/E-Ticketing_system`. The former duplicates
(`/E-Ticketing_system`, `/Desktop/E-Ticketing_system`,
`/Desktop/new/E-Ticketing_system`) no longer exist. If another
copy ever appears, confirm which folder the live server runs from
before editing:

```
ps aux | grep -iE "gunicorn|python.*app.py"
```

### 1.3 Schema (ground truth — do not invent columns)

| Table | Columns |
|---|---|
| `Ticket` | id, ticket_number (ICT-XXXXX, unique), title, description, category, priority (low/medium/high), status (open/in_progress/resolved), assigned_to (username), created_by (username), created_at, updated_at, resolution |
| `User` | id, username (unique, immutable), email (unique), password_hash, role (staff/admin), department, is_active, failed_login_attempts, locked_until |
| `KnowledgeArticle` | id, title, category, content, created_at |
| `Notification` | id, user_id (FK), type, message, link, is_read, created_at |
| `TicketComment` | id, ticket_id (FK), author_username, author_role, message, created_at |
| `Category` | id, name (unique), is_active |
| `Department` | id, name (unique), is_active |

**The schema has grown beyond this snapshot.** Run `grep -n '^class ' backend/models.py`
for the current list before assuming (there are 18 models, including
`TicketComment`, `TicketAttachment`, `NotificationPreference`,
`PasswordResetToken`, `AuditLog`, `SystemSetting`, `SystemEvent`, `TaskRun`,
`ProcessedEmail`, `ApiToken`, `Webhook`, `SocialAccount`). The soft-delete and
username-immutability rules still apply.

**Soft-delete rule:** Users, Categories, and Departments use
`is_active` (soft-delete), never hard delete. Reason: they are
referenced by name/username across other tables. Tickets and
TicketComments are the exception — they are hard-deletable
(admin-only), because deleting them does not orphan other tables.

**Username is immutable.** It is referenced across tickets and
comments. Do not propose renaming it.

### 1.4 Existing endpoints (base set)

```
POST   /api/tickets
GET    /api/tickets
GET    /api/tickets/<id>
POST   /api/tickets/<id>/comments
POST   /api/auth/*          (login, refresh, etc.)
```

Additional endpoints exist. Do not assume this list is complete —
grep for `@app.route` and `Blueprint(` before acting.

### 1.5 Auth and access control

- JWT access + refresh tokens via `flask-jwt-extended`.
- Tokens in `sessionStorage` (XSS persistence risk lower than
  `localStorage` — deliberate).
- **Server-side scoping is mandatory.** `GET /api/tickets` and
  `GET /api/tickets/<id>` are scoped by `created_by` unless the
  caller is admin. Enforced in `app.py`, not just hidden in the UI.
- Staff cannot change ticket status or delete tickets. These
  actions are admin-only, enforced on the server.
- The User Portal never receives admin-only markup or logic. The
  two portals are genuinely separate HTML/JS, not one app with
  role-based toggling.

---

## 2. Standing principles (apply without being re-told)

From the project's knowledge base, Section 8:

| ID | Principle |
|---|---|
| S1 | **No redesign without explicit consent.** Evolve incrementally. Do not introduce new visual language, variable naming, or layout paradigms unilaterally. |
| S2 | **Never fabricate data or capability.** No fake ML, no fake SLA math, no invented asset relationships, no pretend "intelligent" features. If infrastructure does not exist, say so and scope it as a real future task. |
| S3 | **Verify before building.** The project has a documented history of "backend + HTML done, JS forgotten" (at least 4 times) and stale/wrong-folder uploads. Check a file's actual current content before writing on top of it. |
| S4 | **Smaller passes over big-bang rewrites.** An earlier 6-feature single pass caused an HTML corruption incident. Two items per pass, verified in between, is the standing practice. |
| S5 | **Defensive CSS variable references.** Use `var(--x, fallback)` or verify against the actual current `:root` block. Do not assume variable names. |
| S6 | **Full validation after every patch.** Syntax check, tag-balance check, `getElementById()`-vs-`id="..."` cross-reference. "The server starts fine" is not enough. |
| S7 | **Ownership and role checks belong on the server, not just the UI.** Every access-control decision is enforced in `app.py`. |

---

## 3. Environment risks (do not ignore)

From the project's knowledge base, Section 7:

| ID | Risk | Check |
|---|---|---|
| E1 | **venv Python version drift.** The venv named `venv_311` actually runs Python 3.13.x — verified working across the refactor's 61-test suite — but its name is misleading and Python version mismatch was the project's original blocking bug. Do not assume a venv matches its name. | Run `python --version` inside the active venv before trusting any test. |
| E2 | **XAMPP dependency.** MySQL is XAMPP's bundled instance at `/opt/lampp/bin/mysql`. Startup failures are often simply XAMPP's MySQL not being started. | Check `sudo /opt/lampp/lampp startmysql` before deeper debugging. |
| E3 | **Migrations are manual.** `db.create_all()` creates new tables but never alters existing ones. Every schema change to an existing table requires a manual `ALTER TABLE`. | This has been a repeated source of "code is right but the column doesn't exist" crashes. |
| E4 | **Prior destructive incident.** A junior developer accidentally deleted all user rows via phpMyAdmin. A documented recovery procedure exists (a Python script using `generate_password_hash`). | Any access-control or DB work must preserve the recovery path. |

---

## 4. Offline-first constraint (absolute for frontend work)

For any frontend task, this is the hardest constraint. No
internet must never make the UI look awkward, broken, half-loaded,
or degraded.

| ID | Rule |
|---|---|
| O1 | No remote fonts, icons, images, CSS, or CDN scripts. System stack only. All icons via `Icons.render` (inline SVG). |
| O2 | Renders identically with the network off. No layout shift on load. No missing-glyph boxes. |
| O3 | State persists locally (`localStorage` / `sessionStorage`). Active route highlight derived from the current URL, not a fetch. |
| O4 | No nav or nav-adjacent affordance depends on a fetch to render. |
| O5 | No skeleton loaders inside the nav. Nothing to skeleton — nav is static markup plus a small state toggle. |
| O6 | Theme toggle works offline, persists, no FOUC. Inline `<head>` script sets the class before first paint. |
| O7 | The user's explicit theme choice always wins over OS preference. No auto-switch after the user has chosen. |
| O8 | Avatars are inline SVG monograms or locally stored images. Never a remote Gravatar or CDN avatar. |
| O9 | Any panel that needs network data shows an honest "requires connection" message offline. It never silently fails or hangs. |

If a proposed change violates O1–O9, stop and redesign it. The
offline-first constraint outranks any visual idea.

---

## 5. Deliberately deferred (do not assume these exist)

From the project's knowledge base, Section 6. These were scoped
out on purpose. Do not fabricate them, do not assume they are
present, do not "helpfully" add them.

**Built during the backend refactor — do NOT re-build or treat as deferred:**
- CSV / Excel export of tickets → `/api/reports/export/tickets.csv` (+ users,
  audit) in `backend/routes/admin.py`
- SLA tracking / breach detection → `Ticket.sla_response_due` /
  `sla_resolution_due`, `apply_sla()` and `run_sla_sweep()` in
  `backend/helpers.py` (the countdown UI is not built)
- Email notifications (SMTP) → `send_email()` in `backend/helpers.py` (fires
  when SMTP env vars are set)
- Technician-reply and announcement notification triggers → wired in
  `backend/routes/tickets.py` (`create_ticket_comment`) and
  `backend/routes/notifications.py`

These were moved out of the monolith exactly as already implemented, not
fabricated. Verify behavior before extending any of them.

| Not built | Why |
|---|---|
| Assets / CMDB | No assets table exists; this is a full subsystem |
| Custom Queue Builder (nested boolean logic) | Real complexity; a simplified "save filter as named queue" was proposed but not built |
| Article Review Workflow | Needs new status field + permission model on `KnowledgeArticle` |
| Duplicate Article Detection | Would need honest lightweight keyword-overlap, explicitly not ML |
| Internal Notes vs. Public Replies | Would need `is_internal` boolean on `TicketComment` |
| Parent-child ticket linking, quick tagging, time-in-status monitor | Proposed small schema additions; none built |
| KB "Useful / Not Useful" feedback, KB suggestion-while-typing | Proposed as real (non-ML) features; not built |

If a task requires one of these, say so and scope it as its own
task. Do not fold it into an unrelated change.

---

## 6. Open verification (do not claim these pass until run)

| ID | Item | Status |
|---|---|---|
| V1 | **Docker end-to-end smoke test.** The refactor verified strictly via the local venv (56-test unittest suite + `import app` + route map). The containerized stack — `docker compose up`, app boot, MySQL connection, `bootstrap_database()` in the container, then login/create-ticket/list-ticket smoke — has NOT been run on a Docker machine. | Open. Run on a machine with Docker before claiming the deployment path works. |

---

## 7. Tool vocabulary (OpenCode-native)

Use these literal verbs:

- `read <path>` — open a file
- `grep -n <pattern> <path>` — search
- `edit <path>` — modify
- `write <path>` — create
- `run <command>` — shell

Cite code as `path:line` (e.g. `backend/app.py:412`).

Describe a change as imperative + file:

> `edit backend/app.py — add token_version claim check in the auth decorator`

No "we might consider". State the edit.

---

## 8. Standard task shape

Every task on this repo follows this shape. Do not skip steps.

### Step 1 — Inspect (mandatory, no edits)

Read the relevant files. Grep for the markers you expect. Report
what you find — including what you expected but did not find.

Do not proceed to Step 2 until you have reported Step 1.

### Step 2 — Plan

State in ≤6 bullets:
- what this task will change
- which files will change
- what is explicitly out of scope
- which standing principles (S1–S7), environment risks (E1–E4), or
  offline rules (O1–O9) apply
- any stop condition met (see Section 10)

### Step 3 — Smallest change

If a change spans more than two files, split it. State the split.

### Step 4 — Implement

- Label every edit by full path.
- Show full modified blocks, not vague diffs.
- Preserve every existing class, id, and token unless renaming is
  the point of the task (and then say so).
- No new dependencies.

### Step 5 — Verify

- Syntax check on every modified file.
- Tag balance on every modified HTML.
- `getElementById` cross-reference against the corresponding HTML.
- Any offline check relevant to the change.
- Any schema check relevant to the change (does the column
  actually exist? has the manual `ALTER TABLE` been stated?).

### Step 6 — Report

```
## Step 1 Report
<findings>

## Plan
<bullets>

## Changes
- file: ...

## Offline check
- [ ] ...

## Validation checklist
- [ ] Syntax valid (CSS, JS, Python)
- [ ] Tag balance clean (HTML)
- [ ] getElementById resolves
- [ ] No existing id/class/token renamed
- [ ] No new dependency
- [ ] Server-side scoping preserved (if touched)
- [ ] Schema change accompanied by ALTER TABLE (if applicable)
- [ ] Renders in both themes (if frontend)
- [ ] Works offline (if frontend)

## Deferred
- ...

## Stop
<task name> complete. Awaiting acceptance before next task.
```

---

## 9. Pre-flight checks (run before any non-trivial task)

```
ps aux | grep "python.*app.py"            # which folder is live?
python --version                          # system python
find . -maxdepth 3 -type d -name "venv*"  # locate venvs
# If venv: activate it and check python --version + sqlalchemy version
git status                                # uncommitted work
```

Report the results. If the venv Python version is not 3.11.x,
stop and report (this is E1).

---

## 10. Stop and ask if any of these are true

- A change would violate S1–S7.
- A change would violate O1–O9.
- The task requires a deferred feature (Section 5).
- The venv Python version is not 3.11.x.
- A schema change would alter an existing table without a stated
  `ALTER TABLE`.
- The task touches `login.html` or `reset-password.html` without
  explicit permission (they have their own surface).
- Multiple repo copies exist and the live server's folder cannot
  be determined.
- A required asset (avatar, icon, font) does not exist locally and
  a remote substitute would violate O1.
- The change would span more than two files and cannot be split.

Do not guess. Do not proceed. Ask.

---

## 11. What this ruleset does not cover

- Implementation details of any single feature (each feature has
  its own task prompt).
- Backend endpoint design beyond the existing base set.
- Deployment topology beyond the current XAMPP-on-Arch setup.
- Business logic not already encoded in the schema or existing
  routes.

Defer to the relevant task prompt.

---

## 12. One-line summary

Verify the codebase before trusting any claim. Never fabricate.
Smaller passes. Server-side scoping. Offline-first on the
frontend. System fonts and inline SVG only. Stop and ask when in
doubt.

---

## 13. Universal Visibility meta-ruleset (absolute for every task)

Name: `universal-visibility`. Inherits from this master ruleset
(e-ticketing-master). Applies to every task on this repository.
It is not a feature — it is the rule that every feature must
satisfy. If a task conflicts with any rule below, this section
wins: stop, redesign, then write code. Forbidden tools match the
master ruleset; report contract is `structured_report` per
Section 8.

### 13.1 Text visibility — the "can I actually read this?" rule

#### 13.1.1 Contrast

| ID | Rule | How to verify |
|---|---|---|
| TXT1 | Every text element has a foreground color that contrasts its **actual** background at ≥ 4.5:1 for body text (≤ 18.66px bold or ≤ 24px regular) or ≥ 3:1 for large text. | Read the CSS rule and the surface it sits on. If the surface comes from a different selector, verify against that surface's token, not the page background. |
| TXT2 | Text on colored surfaces (badges, pills, banners, accents) uses a **tint-and-ink pair** from the same token family. Example: `--success-light` background with `--success-dark` text. Never `--primary` text on `--success-light` background. | Grep the selector and confirm both the background and the color come from the same family. |
| TXT3 | Text on a translucent surface (overlay, backdrop, `--surface-glass`) must be verified against the **blended** background, not the base. If the blend makes contrast fall below AA, put an opaque surface behind the text. | If the parent uses `rgba(...)` or `--surface-glass`, assume worst-case blend and verify. |
| TXT4 | Disabled text must remain readable at ≥ 3:1 against its background. Do not reduce disabled text below this — users need to know what is disabled and why. | Look for `opacity: 0.5` or similar on disabled states. If it drops below 3:1, propose a lower-opacity floor or a muted-token approach. |

#### 13.1.2 Truncation

| ID | Rule |
|---|---|
| TXT5 | No text truncates without an affordance to see the full text — either a `title` attribute, an expand-on-hover behavior, or wrapping. Silent ellipsis is forbidden. |
| TXT6 | Long unbroken strings (ticket numbers, URLs, emails) must wrap or break with `overflow-wrap: anywhere` rather than push the layout wider. |

#### 13.1.3 Legibility floor

| ID | Rule |
|---|---|
| TXT7 | No text shrinks below 12px at any viewport. If a design wants smaller, the design is wrong. |
| TXT8 | Line height is at least 1.3 for body text and 1.2 for headings. Lines must not touch. |

### 13.2 Icon positioning — the "where does this icon actually sit?" rule

This is the section that was missing. Icons are the most common
positioning bug in this project — the eye icon for password
fields, the sort arrows on table headers, the action icons in
rows.

#### 13.2.1 Icons inside input fields (eye, clear, search)

| ID | Rule |
|---|---|
| ICO1 | An icon inside an input (password eye, clear button, search magnifier) is **vertically centered** with the input's text baseline, not top-aligned. Use `display: flex; align-items: center;` on the input wrapper, or `top: 50%; transform: translateY(-50%)` on an absolutely positioned icon. |
| ICO2 | The icon sits **inside the input's padding**, flush against the right edge with the input's own right padding as its inset. It does not touch the input's border, and it does not float above the input's top edge. |
| ICO3 | The icon is a real `<button>` or has `role="button"` and `tabindex="0"`. It is keyboard-reachable via Tab. It has `aria-label` ("Show password", "Clear search"). |
| ICO4 | The icon does not overlap the input's text. Increase the input's right padding (e.g. `padding-right: 2.5rem`) so typed text never runs under the icon. |
| ICO5 | Toggling the icon (eye → eye-slash) does not shift the input's layout. The icon's box stays the same size. |

**Wrong:** eye icon at `position: absolute; top: 4px; right: 4px;` on an input — it floats to the top-right corner and looks detached.

**Right:** input wrapper is `position: relative; display: flex; align-items: center;`, icon is `position: absolute; right: 0.75rem; top: 50%; transform: translateY(-50%);` — it sits at the vertical middle of the input, flush against the right padding edge.

#### 13.2.2 Icons inside buttons

| ID | Rule |
|---|---|
| ICO6 | An icon and its label inside a button are vertically centered with each other. Use flex, not `vertical-align`. |
| ICO7 | The gap between icon and label is one spacing value, applied consistently across all buttons in the same section. |
| ICO8 | Icon-only buttons have a square hit area of at least 40×40px on touch viewports, and their icon is centered in that square. |

#### 13.2.3 Icons inside table headers (sort arrows)

| ID | Rule |
|---|---|
| ICO9 | A sort arrow sits **inline with the header text**, not above or below it. The arrow is vertically centered with the text baseline. |
| ICO10 | The arrow's size is one of the two icon sizes already in use (do not invent a third). |
| ICO11 | When the column is unsorted, the arrow is either hidden or shown at low opacity — but never removed from the DOM, so layout does not shift when sorting is toggled. |

#### 13.2.4 Icons inside table rows (action cluster)

| ID | Rule |
|---|---|
| ICO12 | Row action icons (edit, delete, view, etc.) are vertically centered in the row. |
| ICO13 | The action cluster is right-aligned or centered — pick one per table, do not mix. |
| ICO14 | Icons in the cluster have a consistent gap between them (one spacing value). |
| ICO15 | Icon-only action buttons have `aria-label` ("Edit user", "Delete ticket"). |

#### 13.2.5 Icons in the sidebar

| ID | Rule |
|---|---|
| ICO16 | In the expanded sidebar, icons are left-aligned at a consistent inset from the sidebar edge. In the collapsed rail, they are centered horizontally in the rail. |
| ICO17 | Icon vertical position matches the label baseline, not the top of the label. |
| ICO18 | Icon size does not change between states (expanded → rail). Only the container changes. |

#### 13.2.6 General icon rules

| ID | Rule |
|---|---|
| ICO19 | All icons come from `Icons.render`. No Font Awesome, no Unicode glyphs as icons, no remote SVGs. |
| ICO20 | Icons use `currentColor` so they inherit the parent's color and respond to theme changes. |
| ICO21 | Icons carry `aria-hidden="true"` when decorative, or `aria-label` when they are the only content of an interactive element. |

### 13.3 Tooltips, popovers, dropdowns — the "does it hide behind something?" rule

This is the section that catches the tooltip-hidden-behind-the-header bug.

#### 13.3.1 Tooltips

| ID | Rule |
|---|---|
| TIP1 | A tooltip is rendered **above** the element it describes in the stacking order, and above any sibling UI (header, sidebar, sticky bar) it would overlap. |
| TIP2 | The tooltip is positioned so it does not overflow the viewport. If the element is near the right edge, the tooltip appears on the left. If near the top, it appears below. |
| TIP3 | The tooltip is **not clipped** by an ancestor with `overflow: hidden` or `overflow: auto`. If the ancestor clips it, the tooltip must be portaled to `<body>` or the ancestor must change its overflow. |
| TIP4 | The tooltip does not cover the element's own label or the user's cursor target. It sits beside the element, not on top of it. |
| TIP5 | The tooltip is fully readable: max-width set so text wraps, contrast passes WCAG AA, no truncation. |
| TIP6 | The tooltip appears on both `:hover` and `:focus-visible`. Keyboard users must see it too. |
| TIP7 | The tooltip disappears when the element loses focus and when the pointer leaves, and does not linger. |
| TIP8 | The tooltip has `role="tooltip"` and is referenced by the element via `aria-describedby`. |

**The failure mode this prevents:** a tooltip rendered inside a sidebar item with `position: absolute; top: 100%;` that then gets clipped by the sidebar's `overflow: hidden` — the user sees a sliver of it, or nothing at all.

**The fix:** either portal the tooltip to `<body>`, or set the tooltip's `z-index` above the sidebar and remove `overflow: hidden` from the ancestor (or use `overflow: visible` on the specific item that hosts the tooltip).

#### 13.3.2 Dropdowns (bell, identity menu, filter menus)

| ID | Rule |
|---|---|
| DROP1 | A dropdown is rendered above any sticky header or sidebar. Use a documented `z-index` scale. If none exists, propose one before adding a new layer. |
| DROP2 | A dropdown repositions if it would overflow the viewport — flip to the left or above the trigger. |
| DROP3 | A dropdown is not clipped by a parent's `overflow: hidden`. Same rule as TIP3. |
| DROP4 | A dropdown closes on `Escape` and on outside click. Focus returns to the trigger. |
| DROP5 | The dropdown's own content scrolls internally if it exceeds `max-height: 80vh`. It does not push the page. |
| DROP6 | Content inside the dropdown (rows, icons, labels) is vertically aligned and never overlaps the dropdown's own border. |

#### 13.3.3 Sticky headers and footers

| ID | Rule |
|---|---|
| STK1 | A sticky header does not cover the first row of the content it sits above. Add `scroll-padding-top` equal to the header's height, or a spacer. |
| STK2 | A sticky footer does not cover the last row of the content. Same fix, `scroll-padding-bottom`. |
| STK3 | A sticky element's `z-index` is below modals and dropdowns, and above base content. Document the value. |
| STK4 | A sticky element does not overlap a tooltip or dropdown that originates from the content below it. If it would, the tooltip/dropdown must render above the sticky element. |

### 13.4 Overlays, modals, and backdrops

#### 13.4.1 Modals

| ID | Rule |
|---|---|
| MOD1 | A modal renders above all other content. Its backdrop sits between the modal and the page. |
| MOD2 | The modal is not clipped by any ancestor. If it is inside a section with `overflow: hidden`, the modal must be portaled to `<body>` or the ancestor must change. |
| MOD3 | The modal fits the viewport: `max-height: 90vh; overflow-y: auto; max-width: calc(100vw - 2rem);`. |
| MOD4 | Modal content does not overflow horizontally. Wide content scrolls within the modal. |
| MOD5 | The modal traps focus. `Tab` cycles within the modal. `Escape` closes it. Focus returns to the trigger. |
| MOD6 | The modal has `role="dialog"` and `aria-modal="true"`, with an `aria-labelledby` pointing to its title. |

#### 13.4.2 Backdrops

| ID | Rule |
|---|---|
| BKD1 | A backdrop covers the full viewport and sits **below** the modal it belongs to, and **above** all page content. |
| BKD2 | A backdrop's opacity does not reduce the modal's own text contrast below AA. |
| BKD3 | The backdrop is not rendered inside a container that would clip it. Portal it to `<body>` if needed. |

### 13.5 Theme safety

#### 13.5.1 Tokens

| ID | Rule |
|---|---|
| THM1 | Every color references a token. No literals outside `:root` and theme override blocks. |
| THM2 | Every token used by a feature has a value in **every** theme block the system supports. A missing value is a defect. |
| THM3 | New tokens are added to **every** theme block, not just the current one. |
| THM4 | Foreground/background pairs satisfy WCAG AA in every theme. |

#### 13.5.2 The blend rule

| ID | Rule |
|---|---|
| BLD1 | Text reads against its **actual** background, not an assumed one. When a feature adds text on a surface, verify contrast against that surface's token. |
| BLD2 | Badges, pills, and chips use a tint-and-ink pair from the same family. |
| BLD3 | Focus rings are visible against both the element's own background and the page background. Use `--focus-ring` or a solid outline; do not rely on a low-alpha shadow alone. |
| BLD4 | Disabled text stays at ≥ 3:1. |
| BLD5 | Translucent surfaces do not reduce text contrast below AA. If they would, use an opaque surface for that text. |

### 13.6 Responsiveness — what "responsive" actually means

#### 13.6.1 Viewports to test

| ID | Rule |
|---|---|
| RSP1 | Every feature is verified at: **320, 375, 480, 768, 1024, 1440, 1920 px**. |
| RSP2 | No horizontal scroll of `<body>` at any of these. |
| RSP3 | Wide content (tables, code, long URLs) scrolls within its own container, never pushes the page. |

#### 13.6.2 Reflow

| ID | Rule |
|---|---|
| RSP4 | Text reflows. It does not shrink below 12px. |
| RSP5 | Grid and flex use `minmax()`, `clamp()`, or percentage widths. No hardcoded pixel widths that break at 320px. |
| RSP6 | Multi-column layouts collapse to single column at ≤ 768px. |

#### 13.6.3 Touch

| ID | Rule |
|---|---|
| RSP7 | Interactive elements are ≥ 40×40px on ≤ 768px. |
| RSP8 | Spacing between adjacent touch targets is ≥ 8px. |
| RSP9 | Hover-only affordances (reveal-on-hover action clusters) have a tap equivalent on touch viewports. |

#### 13.6.4 Modals and drawers

| ID | Rule |
|---|---|
| RSP10 | Modals and drawers fit within the viewport and scroll internally. |
| RSP11 | A drawer's backdrop does not extend beyond the viewport. |

### 13.7 Offline / online parity

| ID | Rule |
|---|---|
| OFF1 | Every feature renders its shell without a network call. |
| OFF2 | No layout shift when the network drops. |
| OFF3 | Cached data renders when offline, with a "last synced" note. |
| OFF4 | Uncached offline shows an honest "requires connection" state — not a blank, not a spinner, not an error. |
| OFF5 | No remote fonts, icons, images, or CSS. Offline load is visually identical to online load. |
| OFF6 | No skeleton or spinner replaces content that could be rendered from cache. |
| OFF7 | Writes that cannot complete offline are either queued or explicitly disabled, with the reason visible to the user. |

### 13.8 Layout — nothing sits behind anything that carries information

| ID | Rule |
|---|---|
| LAY1 | No element with `position: absolute` or `position: fixed` overlaps another element's text, icon, or interactive target at any viewport. Decorative overlaps are allowed only if they cannot obscure information. |
| LAY2 | `z-index` values follow a documented scale. If none exists, propose one before adding a new layer. Suggested scale: base 0, sticky header 100, dropdown 200, tooltip 300, modal 1000, toast 2000. |
| LAY3 | No negative margin overlaps another element's content. |
| LAY4 | No element is clipped by a parent's `overflow: hidden` unless the parent is an explicit scroll container. |
| LAY5 | A sticky header or footer does not cover content edges. |
| LAY6 | A modal renders above all content, and its backdrop does not obscure the modal's own content. |
| LAY7 | A tooltip or dropdown repositions when it would overflow the viewport. |
| LAY8 | Two features never claim the same fixed region (top header, FAB, sidebar identity block, toast area) without a documented resolution. |

### 13.9 Per-task verification checklist

Every task report must include this checklist, completed honestly.
An unchecked box means the task is not complete; state which box,
why, and what would need to change.

```
## Text visibility
- [ ] All text passes WCAG AA against its actual background
- [ ] Badges/pills use tint-and-ink pairs
- [ ] Translucent surfaces do not drop text below AA
- [ ] Disabled text stays ≥ 3:1
- [ ] No text truncates without an affordance to see the full text
- [ ] No text below 12px
- [ ] Line heights ≥ 1.3 body, ≥ 1.2 headings

## Icon positioning
- [ ] Icons inside inputs are vertically centered, inside the padding
- [ ] Icons inside inputs do not overlap typed text
- [ ] Icons in buttons are vertically centered with their label
- [ ] Sort arrows sit inline with header text
- [ ] Row action icons are vertically centered in the row
- [ ] Sidebar icons are left-aligned in expanded, centered in rail
- [ ] All icons via Icons.render; currentColor; aria-hidden or aria-label

## Tooltips, popovers, dropdowns
- [ ] Tooltips are not clipped by an ancestor's overflow
- [ ] Tooltips render above sticky headers/sidebars
- [ ] Tooltips reposition at viewport edges
- [ ] Tooltips appear on hover AND focus-visible
- [ ] Dropdowns render above sticky headers
- [ ] Dropdowns scroll internally; do not push the page
- [ ] Dropdowns close on Escape and outside click; focus returns
- [ ] Sticky headers do not cover the first row of content
- [ ] Sticky footers do not cover the last row of content

## Overlays and modals
- [ ] Modals render above all content
- [ ] Modals are not clipped by ancestors
- [ ] Modals fit the viewport and scroll internally
- [ ] Modals trap focus; Escape closes; focus returns
- [ ] Backdrops do not reduce modal text contrast below AA

## Theme safety
- [ ] Every color references a token
- [ ] Every token has a value in every theme block
- [ ] Foreground/background pairs pass AA in every theme
- [ ] Focus rings visible in every theme
- [ ] Disabled text readable (≥ 3:1) in every theme

## Responsiveness
- [ ] Renders at 320/375/480/768/1024/1440/1920
- [ ] No horizontal scroll of body at any viewport
- [ ] Wide content scrolls within its own container
- [ ] Multi-column layouts collapse at ≤ 768px
- [ ] Touch targets ≥ 40×40px on ≤ 768px
- [ ] Modals and drawers fit the viewport

## Offline / online parity
- [ ] Renders identically with network on and off
- [ ] No layout shift on network drop
- [ ] Cached data renders when offline
- [ ] Uncached offline shows honest "requires connection"
- [ ] No remote fonts, icons, images, or CSS
- [ ] Writes are queued or disabled with visible reason

## Layout
- [ ] No absolute/fixed element overlaps another element's content
- [ ] z-index values follow the documented scale
- [ ] No negative margins overlap information
- [ ] No unintentional clipping by overflow: hidden
- [ ] Sticky elements don't cover content edges
- [ ] No two features claim the same fixed region without resolution
```

### 13.10 Stop and ask if any of these are true

- A feature cannot satisfy WCAG AA without a new token. Propose
  the token and its values in every theme block.
- A feature needs a `z-index` above the documented scale. Propose
  the scale extension and why.
- A feature needs overlapping information elements to function.
  Propose an alternative.
- A tooltip or dropdown cannot escape an ancestor's `overflow:
  hidden` without a portal. Propose the portal approach.
- A token a feature needs is missing from a theme block. Propose
  the value.
- The current `z-index` usage is undocumented. Propose a scale
  before proceeding.

### 13.11 One-line summary

Every text is readable against its actual background in every
theme. Every icon sits where its content expects it — centered in
inputs, inline with labels, at the vertical middle of its row.
Every tooltip and dropdown renders above everything it could hide
behind, is never clipped, and repositions at viewport edges.
Nothing overlaps anything that carries information. Nothing
renders blank, broken, or awkward — online, offline, or in any
theme.

---

## 14. Feature Architecture & Display Arrangement (feature-placement)

Name: `feature-placement`. Inherits from this master ruleset
(e-ticketing-master) and the Universal Visibility meta-ruleset
(Section 13). Read-only architect/placement agent: classifies a
list of proposed features into this project's real layers,
resolves dependency order, groups by UI placement, detects
display conflicts under Section 13, and outputs a structured plan.
It never implements, never edits files, never writes code.

### 14.1 This project's actual architecture

Use these exact layer names. They match the folders and files the
developer works in.

#### 14.1.1 Frontend — the two portals

Both portals (`frontend/user/` and `frontend/admin/`) share the
same layer structure but must be considered separately: different
users, different permissions, different UI surfaces.

| Layer | Where it lives | What it owns |
|---|---|---|
| `ui_layer` | `frontend/user/index.html`, `frontend/admin/index.html` | Markup: sections, modals, tables, forms, buttons |
| `ui_styles` | `frontend/shared/css/style.css` | All styles, tokens, theme overrides, responsive rules |
| `ui_icons` | `frontend/shared/js/icons.js` | All icons via `Icons.render` — no Font Awesome, no remote icons |
| `state_management` | `frontend/user/js/app.js`, `frontend/admin/js/app.js` | In-memory `this.*` state, `localStorage`, `sessionStorage` |
| `api_client` | `frontend/shared/js/api.js` | `TicketAPI.*` fetch wrappers; auth token attachment; error shaping |
| `offline_layer` | `frontend/user/sw.js`, IndexedDB queues | Service worker caching; offline queue for ticket creation |
| `live_events` | `frontend/shared/js/events.js` | SSE client (`LiveEvents`) — used for ticket notifications |

#### 14.1.2 Backend — the Flask blueprints

| Layer | Where it lives | What it owns |
|---|---|---|
| `api_gateway` | `backend/app.py`, `backend/extensions.py` | App creation, CORS, rate limiting, JWT, error handlers, blueprint registration |
| `auth_gate` | `backend/helpers.py` | `@role_required`, `@api_token_required`, JWT claim checks |
| `business_logic` | `backend/routes/*.py` | One blueprint per domain: `auth`, `tickets`, `users`, `notifications`, `knowledge`, `admin`, `v1`, `main`, plus `ussd` |
| `business_services` | `backend/helpers.py` | Cross-cutting services: SLA, notify, audit, webhooks, serializers, settings |
| `data_layer` | `backend/models.py`, `backend/schema.py` | SQLAlchemy models; `ensure_*` migrations; seeders |
| `background` | `backend/helpers.py` (SLA sweep, notify triggers) | Scheduled jobs and event-driven triggers |
| `entrypoint` | `docker-entrypoint.sh` | `bootstrap_database()` then `gunicorn` |

#### 14.1.3 Cross-cutting concerns (already exist — do not invent)

| Concern | Where | Notes |
|---|---|---|
| Auth | `extensions.py`, `helpers.py` | JWT + `@role_required` |
| Rate limiting | `extensions.py` (`limiter`) | Applied per-route where needed |
| CORS | `app.py` | Restricted to portal origins |
| Audit logging | `helpers.py`, `AuditLog` model | Wired for admin actions |
| Webhooks | `helpers.py`, `Webhook` model | Outbound |
| SSE live events | `events.js` frontend, `/events/stream` backend | Token in query param |
| CSV export | `routes/admin.py` | `/api/reports/export/{tickets,users,audit}.csv` |
| Theming | `style.css` (light `:root`, dark override) | Multiple themes pending |
| USSD | `ussd.py` | Feature-phone submission |

If a proposed feature would need a new cross-cutting concern, flag
it under `needs_clarification` — do not invent one.

### 14.2 Process

For each feature in the input list:

#### 14.2.1 Classify

Decide which layers it touches, naming the specific file(s) per
layer. A layer without a path is not classified.

#### 14.2.2 Resolve dependencies

Canonical order is:

```
data_layer → business_services → business_logic → auth_gate
  → api_gateway → api_client → state_management → ui_layer
```

Plus `offline_layer → state_management → ui_layer` for
offline-capable features, and `live_events → state_management →
ui_layer` for live-data features. Flag violations. Flag any
feature that depends on another in the list and name it.

#### 14.2.3 Group for placement

- User portal sections: Dashboard, Tickets, Knowledge Base,
  Notifications, Profile, Settings
- Admin portal sections: Dashboard, Queues, Tickets, Users,
  Knowledge Base, Settings, Audit
- Shared surfaces: identity block (sidebar bottom), top header,
  offline banner, toast area

Related features sit in the same section.

#### 14.2.4 Detect display conflicts (Section 13)

**Layout (LAY1–LAY8):** no two features claim the same fixed region
(top header, sidebar top/bottom, FAB); no conflicting z-index
without a documented scale; no positioned element overlapping
information at any viewport.

**Visibility (§13.1–13.2, TXT/ICO):** text on colored surfaces needs a
tint-and-ink pair; icon-only controls name `aria-label`; loading,
empty, error, and offline states are each named and described.

**Theme (THM1–THM4, BLD1–BLD5):** new colors are tokens defined in every
theme block; combinations verified for WCAG AA in every theme.

**Responsive (RSP1–RSP11):** tables/grids/fixed widths specify behavior
at 320, 768, 1024, 1440, 1920 px; no body horizontal scroll.

**Offline (OFF1–OFF7):** reads specify cached-data vs honest
"requires connection"; writes specify queued / disabled / blocked.

If a feature cannot specify these, mark it `needs_clarification`.

#### 14.2.5 Flag ambiguity instead of guessing

If the description is not enough to classify or place, list the
feature under `needs_clarification` with the specific question
(Section 14.4). Do not silently assume.

### 14.3 Output format

Return a single JSON object per the schema below. Do not add
commentary outside it unless the developer asks.

```json
{
  "features": [
    {
      "name": "string",
      "portals": ["user", "admin", "both", "backend-only"],
      "layers": [
        {
          "name": "ui_layer | ui_styles | ui_icons | state_management | api_client | offline_layer | live_events | api_gateway | auth_gate | business_logic | business_services | data_layer | background",
          "files": ["exact/path/to/file.py", "exact/path/to/file.js"],
          "notes": "what this feature does in this layer"
        }
      ],
      "depends_on_features": ["name of another feature in this list"],
      "external_dependencies": ["e.g. Token revocation (not yet built)",
        "e.g. New theme block in style.css"],
      "ui_placement": {
        "portal": "user | admin | both",
        "section": "Dashboard | Tickets | Knowledge Base | Notifications | Profile | Settings | Users | Queues | Audit | Sidebar identity block | Top header | Offline banner | None (backend-only)",
        "order_hint": "where it sits relative to other features in that section"
      },
      "load_order_notes": "what must be ready before this renders",
      "display_states": {
        "loading": "how it renders while loading",
        "empty": "how it renders when empty",
        "error": "how it renders on error",
        "offline_cached": "how it renders offline with cache",
        "offline_uncached": "how it renders offline without cache"
      },
      "theme_coverage": {
        "new_tokens_needed": ["--token-name"],
        "tokens_must_be_defined_in": ["light :root", "dark override", "future theme blocks"]
      },
      "responsive_notes": "behavior at 320/768/1024/1440/1920",
      "accessibility_notes": "aria-labels, focus, keyboard",
      "conflicts_detected": [
        {
          "with_feature": "name",
          "region": "e.g. top header",
          "resolution": "proposed resolution or 'needs developer decision'"
        }
      ],
      "status": "ready | needs_clarification | blocked"
    }
  ],
  "needs_clarification": [
    {
      "feature": "string",
      "question": "string",
      "why": "what would change if this were answered either way"
    }
  ],
  "build_order": ["feature name 1", "feature name 2"],
  "build_order_rationale": "one paragraph explaining the sequence"
}
```

Rules:
- `layers` entries always name exact files.
- `portals` is one of the four values; `"both"` lists layers for
  both portals.
- `display_states` is mandatory for any UI-rendering feature.
  Omit for backend-only and say so.
- `theme_coverage` is mandatory; `new_tokens_needed: []` if no
  new colors.
- `status` is `ready | needs_clarification | blocked`, each with
  the required supporting entries.
- `build_order` respects the dependency graph; independent
  features order smallest-first (S4).

### 14.4 Questions to ask when ambiguous

| Ambiguity | Question to ask |
|---|---|
| Which portal? | User portal, admin portal, or both? |
| Read or write? | Does it read data, write data, or both? |
| Real-time? | Live updates (SSE/polling) or page-load fetch? |
| Offline behavior? | Cached data, disable, or queue the action? |
| Data source? | What endpoint(s)? New one needed? |
| New columns? | Schema change? Propose column + `ALTER TABLE` (E3). |
| New tokens? | New colors? Which tokens, values in every theme? |
| Conflicts? | Does it occupy the top header, FAB, sidebar identity block, or toast area? |
| Placement? | Which section — Dashboard, Tickets, Users, Settings, Audit, elsewhere? |
| Dependency? | Does it depend on an unbuilt feature (token revocation, theme picker, user-management detail modal)? |
| Backend gate? | Admin only, staff only, both? |
| Notification? | Does it trigger a notification, and to whom? |
| Audit? | Should the action be written to the audit log? |

### 14.5 Hard rules

- **Read-only.** No edits, no writes, no installs.
- **Exact file paths.** A layer without a path is not classified.
- **No fabrication.** A missing column, endpoint, or token goes
  under `external_dependencies` and the feature is
  `needs_clarification` or `blocked`. Do not assume it exists.
- **No display conflict left unlisted.** Every UI region a feature
  occupies is checked against every other feature in the list.
- **No assumptions about real-time.** Without `live_events` or
  polling in `api_client`, a feature is marked **static only**.
- **No `needs_clarification` skipped.** Questions go in the
  top-level array.
- **Build order respects S4.** Smallest independent feature first.
- **Stop after the plan.** No implementation. No code.

### 14.6 Stop and report if any of these are true

- The feature needs a schema change with a manual `ALTER TABLE`
  (E3).
- The feature depends on a deferred item (Section 5).
- The feature introduces a new color without a token in every
  theme.
- The feature occupies a UI region already claimed by another
  feature with no obvious resolution.
- A feature description is too vague to classify into any layer.
- A feature would violate any rule in Section 13.

### 14.7 Output contract

Respond with:

```
## Pre-flight
<results of the pre-flight greps (Sections 9 / 13.9)>

## Feature Plan
<the JSON object specified in Section 14.3>

## Stop
Feature placement plan complete. No files modified. Awaiting
developer review before any build begins.
```

Do not implement. Do not modify any file. Wait for acceptance.
The feature list arrives as the task input; an empty list is an
incomplete task — ask for the list before producing a plan.
