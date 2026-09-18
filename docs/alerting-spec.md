# Alerting Specification (Phase 2 — C3)

Status: **specification only**. No detector process is installed. Everything
below is specified against signals that exist TODAY and can be probed without
any new infrastructure. Nothing is fabricated.

## 1. Real signal sources (all verified working)

| Source | What it reports | Verified |
|---|---|---|
| `GET /api/health` | `200` healthy / `503` database-unreachable / refused = app down | yes (routes/main.py:27) |
| `GET /api/metrics` | monotonic counters: `requests_5xx_total`, `requests_4xx_total`, `auth_login_failure_total`, `http_request_max_ms`, `email_failed_total`, `email_skipped_total`, `webhook_failed_total`, `sla_breaches_total`, … | yes (routes/main.py:50) |
| `scripts/backup-local.sh` | exit code 0/1 + fresh daily artifact in `backend/backups/daily/` | yes (Phase B) |
| process check | `pgrep -f "venv313/bin/python app.py"` | yes (Phase D to automate) |

Counters reset on process restart — **detection must use deltas between two
samples**, never raw counter values.

## 2. Alert definitions

| Alert | Severity | Signal (delta-based unless noted) | Detection cadence | Response within | Action |
|---|---|---|---|---|---|
| **AppDown** | critical | no response to `/api/health` (connection refused) or process absent | 60 s poll | 5 min | Read `/tmp/ict-server.log`; restart from `backend/`; confirm port 5000 free first (port-collision failure mode known) |
| **DatabaseDown** | critical | `/api/health` returns 503 | 60 s poll | 5 min | `sudo /opt/lampp/lampp startmysql` (E2); verify `SELECT 1`; app recovers without code change |
| **ErrorRate5xx** | warning | `requests_5xx_total` delta >= 5 within 5 min | 60 s poll | 15 min | Correlate `[request_id]` lines in the log; trace the failing `METHOD /path -> 5xx` line; review last deployed code |
| **AuthFailBurst** | warning | `auth_login_failure_total` delta >= 10 within 5 min | 60 s poll | 15 min | Check for brute-force; account lockout (`locked_until`) already mitigates; rate limiter present on login |
| **BackupFailed** | critical | `backup-local.sh` exit != 0 **or** newest daily artifact older than 24 h (checked once/day after the scheduled run) | daily 02:30 | 24 h | Re-run the script; inspect `mysqldump` errors (1577/1558 known, documented in the script header); re-run the restore drill before trusting the next backup |
| **EmailFailed** | warning | `email_failed_total` delta > 0 | 5 min poll | 30 min | Only relevant **if** SMTP is configured; if it is, check `SMTP_*` env and retry. `email_skipped_total` growth is **informational** (SMTP unconfigured is the current default posture, not an incident) |
| **WebhookFailed** | info | `webhook_failed_total` delta > 0 | 5 min poll | 1 h | Verify the webhook endpoint is reachable; check `X-Ict-Signature` flow |
| **SLABreach** | info | `sla_breaches_total` delta > 0 | 5 min poll | none (operational) | Review priority rules + SLA targets; notifications already fire in-app |

`http_request_max_ms` is advisory for capacity (no SLO is currently declared —
a declared SLO would be fabrication until traffic exists).

## 3. Severity and escalation

- **critical** — data loss, app/DB unavailable, backup failing. First response
  within 5 min; escalation to the operator immediately.
- **warning** — degradation, suspicious burst. First response within 15–30 min.
- **info** — operational metrics. No response obligation.

Escalation chain today is a single operator (the project's admin/dev). A
rotating-on-call stub is **future infrastructure** (needs >1 operator).

## 4. Delivery channels

| Channel | Available today? | Notes |
|---|---|---|
| Local alert log (`backend/logs/alerts.log` via stdout redirect) + console lines with `[request_id]` | **yes** | Detector writes lines; visible in the same stream as app logs |
| Email via existing `send_email()` (helpers.py) | **conditional** | Works only when `SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD` are set in `backend/.env`. Today they are NOT set — specified, not silently assumed |
| Hosted uptime monitor / pager / SMS | **no — future infrastructure** | Requires a provider decision; the HTTP probe target `/api/health` is already correct for them. Do not claim a hosted monitor exists |

## 5. Proposed detector (not built — future task)

`scripts/health_watch.py` — stdlib `urllib` only:

- sample `GET /api/health` + `GET /api/metrics` every 60 s, keep last snapshot
- compute the deltas above; evaluate the rules table; write an alert line
  (`timestamp level alert message`) to an append-only log; `exit` 0
- run from cron (replacing/stub for the scheduler wiring in Phase B)

This is a **proposed follow-up task**, to be built and tested in a later phase —
no detector process is claimed to exist today.

## 6. Honest testing plan for the detector (when built)

| Test | Procedure | Safety |
|---|---|---|
| AppDown | `kill` the app process | safe, restart immediately |
| DatabaseDown | `sudo /opt/lampp/lampp stopmysql` then poll health | maintenance window only; XAMPP restart (E2) |
| BackupFailed | point `BACKUP_DIR` at an unwritable path | safe (exit 1 proven in Phase B) |
| AuthFailBurst | 10 bad logins via curl loop | safe (rate limiter present) |

Live-testing DatabaseDown is only safe with no active users — schedule it
during a maintenance window.

## 7. Known gaps (honest)

- No persistent alert log rotation yet.
- No remote delivery; operator must read the local alert log.
- Detection latency bounded by the 60 s poll.
- No declared SLO/SLA for availability — no traffic basis exists (documented,
  not asserted).