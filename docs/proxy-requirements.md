# HTTPS / Reverse-Proxy Preparation (Phase 2 — E)

Status: **Level 1 = PREPARED (analysis + artifacts reviewed). Level 2 =
UNVERIFIED — no reverse proxy or TLS is running or claimed to be live.**

Latency-sensitive reader: today the live stack is Flask on
`http://<host>:5000` directly (no proxy, no TLS). Everything below describes
what must hold when a proxy is actually deployed.

## 1. The intended topology (existing artifacts)

    public ──► Cloudflare (TLS terminated at CF edge)
                 │  https://*.trycloudflare.com   (free quick tunnel, default)
                 │  https://<custom-domain>       (IDLE — costs money)
                 ▼
             cloudflared  (config: cloudflared/config.yml.example)
                 │  plain HTTP on the internal docker net
                 ▼
             nginx :80  (config: nginx/nginx.conf, mounted in docker-compose.yml)
                 │  /api/*, /api/events/stream, /usr/share/nginx/html frontend
                 ▼
             flask :8000  (gunicorn via backend/docker-entrypoint.sh)

## 2. The gap between the artifacts and today's reality

| Item | Artifact (PARKED Docker stack) | Live today | Status |
|---|---|---|---|
| Reverse proxy | nginx container | none — direct :5000 | not deployed |
| TLS | terminated at CF edge / custom-cert block IDLE | none | not deployed |
| cloudflared | quick tunnel default; named tunnel IDLE | not running | not deployed |
| Security headers | nginx `add_header` block (X-Frame-Options, nosniff, Referrer-Policy, CSP) | **absent on direct :5000** | not deployed |

## 3. Level 1 requirements (each mapped to artifact vs. gap)

### 3.1 Forwarded headers and trust boundary — PARTIAL
- nginx already sets `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Real-IP`
  on every proxied location (nginx.conf:86-89, 97-99, 110-112). ✓
- The app's share page already reads `X-Forwarded-Proto` (routes/main.py:71). ✓
- **GAP:** the app has no `ProxyFix` (werkzeug). Behind a proxy, `request.url`,
  `url_for()` and `request.remote_addr` will not reflect the proxy. When the
  proxy deploys, add ProxyFix in `app.py` **scoped to the trusted proxy only**
  (never trust `X-Forwarded-*` from arbitrary clients — set
  `x_for`/`x_proto`/`x_host` counts to exactly 1). This is a planned code
  change, not present today.

### 3.2 Request-size mismatch — DECISION REQUIRED
- App allows `MAX_CONTENT_LENGTH = 25 * 1024 * 1024` (25 MB, app.py:89).
- nginx enforces `client_max_body_size 10M` (nginx.conf:73).
- **Consequence:** attachment uploads between 10 MB and 25 MB would be
  rejected by nginx before Flask ever sees them.
- **Decision:** align nginx to `client_max_body_size 25M` (and if proxying
  without the tunnel, keep it) OR lower the app cap. Attachments are the
  largest request body — pick 25 MB to match the app.

### 3.3 SSE stream — READY
- nginx: `proxy_buffering off; proxy_cache off; proxy_read_timeout 86400s;`
  `proxy_send_timeout 86400s; chunked_transfer_encoding on;`
  (nginx.conf:93-105). ✓
- App sets `X-Accel-Buffering: no` on the event stream (routes/main.py). ✓
- No proxy should buffer events or apply a short read timeout to
  `/api/events/stream`. The artifacts already satisfy this.

### 3.4 TLS / HSTS — PARTIAL
- Free quick tunnel: TLS is terminated at the Cloudflare edge; nginx only
  ever sees cleartext on the internal network (nginx.conf:56-60 comment). ✓
  Browsers therefore always use HTTPS against the tunnel. 
- Custom domain is **IDLE** (nginx.conf:62-71 commented 443/SSL block).
- **HSTS:** the `add_header Strict-Transport-Security` line is correctly
  commented out — over plain HTTP to nginx it is a no-op and would pollute
  the config. It must return to the real TLS listener only (custom-cert
  mode, or set via Cloudflare's HSTS toggle when using the tunnel). Do not
  enable HSTS before real TLS exists.

### 3.5 CORS tightening — REQUIRED BEFORE PUBLIC EXPOSURE
- The app currently runs `CORS(app)` with **no origins restriction**
  (app.py:77), while `ALLOWED_ORIGINS` already exists in `backend/.env`.
- Same-origin serving (nginx serves the frontend and API from one host)
  makes unrestricted CORS mostly moot, but the public API-token surface
  (`/api/v1/*`) is reachable from arbitrary origins.
- **Requirement:** restrict CORS to `ALLOWED_ORIGINS` before any public
  exposure. This is a Phase H security item; the proxy prep does not
  depend on it but must not roll out without it.

### 3.6 USSD gateway allow-list — OPEN (correctly fail-open)
- nginx contains a `location = /ussd` block with commented `allow`/`deny`
  and a VERIFIED note: Africa's Talking publishes no static egress CIDRs and
  no callback signature, so the allow rules must come from
  support@africastalking.com before `deny all;` is enabled (nginx.conf:120-144).
- Shipping `deny all` with guessed ranges = silent total outage. Keep
  fail-open until AT provides the CIDRs.

### 3.7 Rate limiting (proxy + app both exist)
- nginx: `auth_limit` 5 r/m for `/api/auth/*`, separate `ussd_limit`
  20 r/s (burst-tolerant). ✓
- App: Flask-Limiter in-memory per-route limits (warns at boot; in-memory
  store is per-process — document, not fix).
- Both layers are compatible (proxy limit is per-IP; app limit per-route).

### 3.8 Static assets and caching — READY
- nginx is configured with `expires 7d; Cache-Control public, immutable`
  for CSS/JS/images and try-files SPA routing for /user and /admin
  (nginx.conf:146-170). ✓

## 4. Level 2 checklist — UNVERIFIED until this machine or a real host

- [ ] An actual proxy process serving the app (artifacts exist, none runs)
- [ ] A real certificate with a validated chain (or Cloudflare tunneling)
- [ ] HSTS decision recorded for the final topology
- [ ] CORS restricted to `ALLOWED_ORIGINS` before public exposure
- [ ] ProxyFix enabled with the trust boundary documented
- [ ] Upload limit mismatch resolved (25 MB)
- [ ] USSD CIDRs confirmed with Africa's Talking and `deny all` enabled
- [ ] End-to-end smoke over the proxy: login → create ticket → SSE stream
- [ ] The alerting probes (docs/alerting-spec.md) reachable through the proxy

## 5. Honest status

- **Level 1 (prepared):** topology, forwarded-header handling, SSE behavior,
  size limits, security headers, TLS placement and HSTS caveats —
  **documented and identified.** Level 1 is theoretical until a proxy run.
- **Level 2 (real TLS/proxy):** **UNVERIFIED.** No process serves TLS, no
  certificate exists, no HSTS is set, and no end-to-end proxied smoke has
  run. Deploying is a scoped future task (Phase 3), not claimed here.