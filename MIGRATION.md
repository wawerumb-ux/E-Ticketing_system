# MIGRATION.md — Phase 1 (Forge) Cutover Guide

One-time procedure to move from XAMPP's local MySQL to the containerized stack.

---

## Prerequisites

Install on the host:

```bash
sudo apt install zstd docker.io docker-compose-v2
```

---

## Step 1 — Set secrets

```bash
cp .env.example .env
# Edit .env and fill in:
#   MYSQL_ROOT_PASSWORD  (use the same password as your XAMPP MySQL root, or pick a new one)
#   SECRET_KEY           (run: python3 -c "import secrets; print(secrets.token_hex(32))")
#   JWT_SECRET_KEY       (same method)
#   CF_TUNNEL_TOKEN      (from the Cloudflare Zero Trust dashboard)
```

---

## Step 2 — Dump from XAMPP

```bash
# If XAMPP MySQL has a root password:
/opt/lampp/bin/mysqldump -u root -p ict_ticketing > /tmp/ict_ticketing_xampp.sql

# If no password:
/opt/lampp/bin/mysqldump -u root ict_ticketing > /tmp/ict_ticketing_xampp.sql
```

Compress for archival:

```bash
zstd -3 /tmp/ict_ticketing_xampp.sql -o /tmp/ict_ticketing_xampp.sql.zst
```

---

## Step 3 — Start the containerized stack

```bash
docker compose up -d mysql
```

Wait for MySQL to be healthy:

```bash
docker compose exec mysql mysqladmin ping -u root -p"$MYSQL_ROOT_PASSWORD" --silent
```

---

## Step 4 — Load the dump into the container

```bash
docker compose exec -T mysql \
    mysql -u root -p"$MYSQL_ROOT_PASSWORD" ict_ticketing \
    < /tmp/ict_ticketing_xampp.sql
```

---

## Step 5 — Verify row counts

Run each query and compare with the XAMPP database:

```bash
docker compose exec mysql mysql -u root -p"$MYSQL_ROOT_PASSWORD" ict_ticketing \
    -e "SELECT 'tickets' AS tbl, COUNT(*) AS cnt FROM tickets
        UNION ALL SELECT 'users', COUNT(*) FROM users
        UNION ALL SELECT 'knowledge_articles', COUNT(*) FROM knowledge_articles
        UNION ALL SELECT 'notifications', COUNT(*) FROM notifications
        UNION ALL SELECT 'ticket_comments', COUNT(*) FROM ticket_comments
        UNION ALL SELECT 'categories', COUNT(*) FROM categories
        UNION ALL SELECT 'departments', COUNT(*) FROM departments;"
```

Every count must match the XAMPP source exactly.

---

## Step 6 — Start the full stack

```bash
docker compose up -d
```

Verify the health endpoint:

```bash
curl -s http://localhost/api/health | python3 -m json.tool
```

---

## Step 7 — Run the restore drill (optional but recommended)

```bash
chmod +x scripts/restore_drill.sh
scripts/restore_drill.sh
```

---

## Step 8 — Decommission XAMPP MySQL

Once you have confirmed the containerized stack is serving correctly:

```bash
# Stop XAMPP services
sudo /opt/lampp/lampp stop

# Optionally disable XAMPP from starting at boot
sudo systemctl disable lampp 2>/dev/null || true
```

Do **not** delete `/opt/lampp` yet — keep it as a rollback path for at least one week.

---

## Schema Migrations (Alembic)

After the initial load, capture the current schema as the Alembic baseline:

```bash
cd backend
alembic revision --autogenerate -m "initial schema"
alembic upgrade head
```

This stamps the current table structure so future `alembic upgrade head` calls
apply only new changes.  **Never edit generated migration files after the fact.**

---

## Backup Schedule

Add to crontab:

```bash
0 2 * * * /path/to/scripts/backup.sh >> /var/log/ict-backup.log 2>&1
```

Weekly backups (Sundays) are kept for 4 weeks; daily backups are kept for 7 days.

---

## IDLE — costs money when enabled

All paid-capable components ship built, wired, and **disabled**. Each lives
behind a single boolean flag in `.env` (all default `false`). While a flag is
`false` the component short-circuits before any paid call, consumes no paid
resource, and needs no credentials — it cannot break startup or fail a
healthcheck. Flip a flag to `true` to activate the component later **without
redesign**.

| Flag | What it activates | Approximate cost | How to turn on |
| --- | --- | --- | --- |
| `OFFSITE_BACKUP_ENABLED` | Uploads the newest local backup to Backblaze B2 (or any rclone remote) via `scripts/offsite_backup.sh` | Pay-per-GB storage + egress (~$0.005–0.02/GB/mo B2) | 1. `rclone config` → create remote named per `OFFSITE_BACKUP_PROVIDER`; 2. set `OFFSITE_BACKUP_ENABLED=true`; 3. run `scripts/backup.sh` (it calls the offsite script after the local copy). |
| `CUSTOM_DOMAIN_ENABLED` | Uses your own hostname + real cert for the Cloudflare tunnel instead of the free `*.trycloudflare.com` URL | ~$5/mo or Cloudflare free-tier limits | 1. Set `CUSTOM_DOMAIN_ENABLED=true`; 2. set `CF_TUNNEL_TOKEN` to a named-tunnel token; 3. follow `cloudflared/config.yml.example` (uncomment the custom-domain block); 4. add the DNS CNAME in the Cloudflare dashboard. |
| `MONITORING_ENABLED` | `scripts/monitoring_hook.py` posts app events (currently periodic-task errors) to `MONITORING_ENDPOINT` | Whatever the monitoring provider charges | Set `MONITORING_ENABLED=true` and `MONITORING_ENDPOINT` in `.env`. Optional `MONITORING_API_KEY`. Optional standalone agent: `docker compose --profile paid up -d`. |
| `PUSH_ENABLED` | Paid web-push notifications to users (`maybePushNotify` idle stub in the User Portal calls `/api/push/subscribe`) | Push provider fees (e.g. OneSignal/APNs) | Set `PUSH_ENABLED=true` and flip `window.__PUSH_ENABLED` to `true` in `frontend/user/index.html`, then implement `/api/push/subscribe` + a real push provider. |
| Paid CI (not in this repo) | CI minutes on a hosted runner | Runner minutes/hours pricing | Out of scope here — activate in your CI provider's dashboard when you want automated builds/tests on every push. |

`docker compose up` (no profile) starts **only** the free stack: `flask`,
`mysql`, `nginx`, `cloudflared` (quick tunnel). Paid sidecars live under the
`paid` compose profile and start only on explicit request.

---

## Rollback

If anything goes wrong, stop the containers and restart XAMPP:

```bash
docker compose down
sudo /opt/lampp/lampp start
```
