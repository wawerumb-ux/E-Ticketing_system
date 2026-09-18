# Staging & Rollback — E-Ticketing System

**Last verified:** 2026-09-18  
**Status:** Level 1 PREPARED / Level 2 UNVERIFIED (same status as proxy-requirements.md)  
**Scope:** single XAMPP host on Arch Linux; no separate staging host exists today.

---

## 1. What exists today

| Layer | Live state | Path / command | Notes |
|---|---|---|---|
| App process | Flask dev server on `:5000` | `cd backend && venv313/bin/python app.py` | Calls `bootstrap_database()` (ensure_*_schema) on boot. Stops with Ctrl-C or SIGKILL. |
| Containerized intent (PARKED) | Gunicorn `:8000` via `backend/Dockerfile` + `docker-entrypoint.sh` | `docker compose up` | V1 UNVERIFIED — Docker not installed on this machine. |
| Reverse proxy | nginx installed, **daemon not running** | `sudo nginx` | Config at `nginx/nginx.conf`; proxies edge `:80` → app `:8000`. CF tunnel config: `cloudflared/config.yml.example` only. |
| Database | MariaDB 10.4.32 (XAMPP) | `mysql -uroot -h127.0.0.1 -P3306` | Event scheduler **disabled** (documented hazard — do not use `--events` with mysqldump). |
| Secrets | `backend/.env` (mode 0600) | — | Contains `SECRET_KEY`, `JWT_SECRET_KEY` (generated 2026-09-18), `DATABASE_URL`, placeholder OAuth keys. |
| Backups | `backend/backups/{daily,weekly}/` | `scripts/backup-local.sh` | Rotation: 7 daily / 4 weekly. SHA-256 + zstd verified. **Not cron-scheduled** (manual only). |
| Restore | `scripts/restore-local.sh` | `restore-local.sh <artifact>` | Drill target: `ict_ticketing_drill`. **Refuses live DB** unless `--allow-live`. Drill run time: ~6s. |
| CI gate | `scripts/ci-quality-gate.py` | `python3 scripts/ci-quality-gate.py` | 4 real checks (suite, schema drift, compileall, frontend validator). `--fast` skips DB-backed checks. |

**Single-host constraint:** staging = production = the same XAMPP instance on this machine. There is no separate staging database, staging host, or staging URL.

---

## 2. Pre-deploy gates (all must be green)

Run these **before** any code change reaches the live app:

```bash
# 1. Environment ready (starts MySQL if stopped)
bash scripts/preflight.sh

# 2. Backup (rotate, verify checksum)
bash scripts/backup-local.sh
# Artifacts appear in backend/backups/daily/; SHA-256 + zstd validated.

# 3. Schema drift (models vs live DB)
cd backend && venv313/bin/python ../scripts/check-schema-drift.py
# Exit 0 = no drift. Exit 1 = drift (requires manual ALTER per E3).

# 4. CI gate (full — all 4 checks)
python3 scripts/ci-quality-gate.py
# All PASS required. Exit 1 = BLOCKED.
```

---

## 3. Deploy procedure — local dev path

This is the actual current path (gunicorn/Docker path is PARKED).

### 3.1. Stop the running server

```bash
# Find the running process
ps aux | grep "[v]env313/bin/python app.py"

# Kill by PID
kill <PID>

# Confirm port freed
lsof -i :5000
```

**Never** use `pkill -f "python app.py"` — the shell's own argument string matches and kills the parent.

### 3.2. Apply code changes

```bash
# Apply edits (git working tree — no remote, no branches)
# Verify with the CI gate
python3 scripts/ci-quality-gate.py
```

### 3.3. Restart the server

```bash
cd backend
(venv313/bin/python app.py > /tmp/eticketing-boot.log 2>&1 & echo $! > pid)
sleep 2
tail -1 /tmp/eticketing-boot.log
```

`bootstrap_database()` runs inside `app.py` on boot (guard prevents destructive re-runs — it only creates missing tables or runs additive `ensure_*` migrations).

### 3.4. Smoke test

```bash
# Health
curl -sf http://127.0.0.1:5000/api/health   # expect 200

# Login
curl -s http://127.0.0.1:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | python3 -m json.tool

# Metrics (Phase C2)
curl -s http://127.0.0.1:5000/api/metrics | head -5
```

---

## 4. Rollback procedure

Three independent rollback surfaces: **database**, **code**, **secrets**.

### 4.1. Database rollback (most common)

This is the proven path (restore-local.sh drill verified 2026-09-18: 21 tables, 0 row mismatches, 0 FK orphans, ~6s full restore).

```bash
# Step 1: list available backups
ls -lt backend/backups/daily/

# Step 2: restore to scratch and verify (SAFE — never touches live DB)
bash scripts/restore-local.sh backend/backups/daily/ict_ticketing_YYYY-MM-DDTHH-MM-SS.sql.zst
# Runs table/row/FK verification. On success, scratch DB is dropped.
# On failure, scratch is KEPT for inspection (exit 1).
# Run time: ~6s for full restore + verify.

# Step 3: ONLY if scratch drill passed, promote to live
bash scripts/restore-local.sh --allow-live \
  backend/backups/daily/ict_ticketing_YYYY-MM-DDTHH-MM-SS.sql.zst
# WARNING: --allow-live drops and recreates the live database (ict_ticketing).
# ALL data written since the backup will be lost.
# The uploads archive is restored alongside the DB.
```

**Post-restore:** restart the app (Step 3.3) and re-run the smoke test (Step 3.4).

### 4.2. Code rollback

```bash
# View recent commits
git log --oneline -10

# Revert to a previous commit
git revert <commit-hash>
# Or hard reset (destructive — do this only if backup is current)
# git reset --hard <commit-hash>

# Re-run CI gate
python3 scripts/ci-quality-gate.py

# Restart server (Step 3.3)
```

**Caveat:** no git remote exists; all work is in the local working tree. A code rollback requires a recoverable commit history. Current Phase 2 work (B1/F/G...) is uncommitted — **commit now before any live deploy** (not part of this task — flagged as a recommendation below).

### 4.3. Secrets rollback

`backend/.env` is **NOT** captured by `backup-local.sh` (it backs up MySQL + uploads only). Rollback requires a manual copy.

**Recommended recovery path (E4-aligned):**

```bash
# If .env was overwritten and the old copy is lost:
cd backend

# Regenerate secrets (64-hex each, never echoed)
python3 - <<'EOF'
import secrets, os
new_key = secrets.token_hex(32)
new_jwt = secrets.token_hex(32)
print(f"SECRET_KEY={new_key}")
print(f"JWT_SECRET_KEY={new_jwt}")
EOF

# Append to .env (or overwrite the relevant lines)
# Then lock permissions
chmod 600 .env
```

This is the documented E4 recovery pattern (AGENTS.md §3). The standalone recovery script referenced by E4 is **not present in the repo** (see Open Gaps below).

### 4.4. Uploads rollback

Uploads are included in the backup artifact (`uploads.tar.zst`). `restore-local.sh` restores them to `backend/uploads/` on the verified drill path; with `--allow-live` it restores to the live uploads directory.

---

## 5. Honest status — what is NOT built

| Item | Status | Why |
|---|---|---|
| Separate staging host / staging DB | NOT BUILT | No second XAMPP or container available. |
| Dockerized deploy path | UNVERIFIED (V1) | Docker not installed; `docker compose up` not smoke-tested. |
| nginx / cloudflared runtime | DEPLOYMENT PREP only | Config files exist; daemons not running; no TLS termination configured. |
| `backend/.env` backup in `backup-local.sh` | NOT BUILT | Secrets rotate independently; manual copy required. |
| Cron schedule for `backup-local.sh` | NOT BUILT | No crontab entry; manual execution required. |
| E4 standalone recovery script | NOT PERSISTED | AGENTS.md references it; no script file found in the repo. |
| Git remote / PR-based deploy pipeline | NOT BUILT | All work is local working-tree commits only. |
| Schema migration automation (Alembic autogenerated) | NOT BUILT | `alembic/` scaffold exists; migrations are manual `ALTER TABLE` per E3. |

---

## 6. Recommended follow-up tasks (not part of this task)

These are scoped as individual future tasks — do not fold them into unrelated work:

| Task | Priority | Effort |
|---|---|---|
| Add `backup-local.sh` to a systemd timer or cron job | High | Small — add one line, test the timer. |
| Back up `backend/.env` inside `backup-local.sh` (mode 0600 in the archive) | High | Small — add `tar` of `.env` to the uploads archive step. |
| Persist the E4 user-recovery procedure as `backend/recover_admin.py` | High | Small — standalone script using `generate_password_hash`; test against scratch. |
| Commit the Phase 2 work (A–G) to git with a meaningful message | Medium | Required before any live deploy (current work is uncommitted). |
| Smoke-test the containerized path (`docker compose up`) on a machine with Docker | Medium | V1 closure; requires Docker Desktop or equivalent. |
| Provision a second MySQL database or container as a true staging environment | Low | Larger — requires a second DB and a deploy promotion step. |

---

## 7. Emergency procedure (quick reference)

When the live app is broken and needs immediate rollback:

```bash
# 1. Stop the server
kill $(cat backend/pid 2>/dev/null) 2>/dev/null

# 2. Pick the latest backup
BACKUP=$(ls -t backend/backups/daily/ict_ticketing_*.sql.zst | head -1)

# 3. Restore to scratch first (verify it's intact)
bash scripts/restore-local.sh "$BACKUP"
# If this fails, the backup itself is corrupt — use an older one.

# 4. Restore live (--allow-live: drops live DB, restores that backup)
bash scripts/restore-local.sh --allow-live "$BACKUP"

# 5. Restart
cd backend
(venv313/bin/python app.py > /tmp/eticketing-boot.log 2>&1 & echo $! > pid)
sleep 2 && curl -sf http://127.0.0.1:5000/api/health && echo " recovered"
```

**Time to recovery:** ~15–20s (6s restore + 2s boot + 1s smoke; backup age = RPO).
