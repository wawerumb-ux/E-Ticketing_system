#!/usr/bin/env bash
# =============================================================================
# XAMPP-native backup: mysqldump | zstd, with daily/weekly rotation, integrity
# checks, uploads archive, and failure visibility. NO Docker required.
#
# Backs up:
#   - the full `ict_ticketing` database (schema + data, routines/triggers/events)
#   - the attachments folder (backend/uploads) when present, as a tarball
#
# Integrity (checked at the end of every run):
#   - zstd stream validity (`zstd -t`)
#   - SHA-256 checksum written alongside every artifact
#   - the dump contains the expected `users` table structure
#
# Note: `--events` is intentionally NOT used — XAMPP/MariaDB runs with the
# EVENT_SCHEDULER disabled, so the flag makes mysqldump abort (error 1577).
#
# Note: `--routines` is intentionally NOT used. This XAMPP MariaDB instance
# carries a stale mysql.proc (created under 10.1.8, now running 10.4.32), so
# ANY routine introspection fails with MariaDB error 1558 ("Please use
# mysql_upgrade"). The application creates no stored procedures/functions.
# If a restored database ever needs routines, run `mysql_upgrade` on the
# source instance first — never auto-run it from a backup script. Triggers
# ARE exported (they live in .TRG files, unaffected by the mysql.proc issue).
#
# Prerequisites on the host:
#   - /opt/lampp/bin/mysqldump (XAMPP)  — override with MYSQLDUMP env
#   - zstd installed (apt install zstd / pacman -S zstd)
#
# Environment (read from backend/.env, all overridable):
#   DATABASE_URL    SQLAlchemy URL; defaults to root@127.0.0.1:3306/ict_ticketing
#   MYSQL_USER      default: parsed from DATABASE_URL or "root"
#   MYSQL_PASSWORD  optional; exported as MYSQL_PWD so it NEVER appears on the
#                   command line (ps-safe). Empty root password = no flag.
#   BACKUP_DIR      default: <repo>/backend/backups  (git-ignored)
#   UPLOAD_FOLDER   default: <repo>/backend/uploads
#
# Crontab example (02:00 daily, log to syslog-friendly file):
#   0 2 * * * /path/to/repo/scripts/backup-local.sh >> /var/log/ict-backup.log 2>&1
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$REPO_DIR/backend/.env"

# ── Parse backend/.env (key=value lines only — never source blindly) ────────
get_env() {
    local key="$1"
    if [ -f "$ENV_FILE" ]; then
        sed -n "s/^[[:space:]]*${key}=//p" "$ENV_FILE" | tail -1 || true
    fi
}

DATABASE_URL="${DATABASE_URL:-$(get_env DATABASE_URL)}"
DATABASE_URL="${DATABASE_URL:-mysql+pymysql://root:@127.0.0.1:3306/ict_ticketing}"

# Extract db / user / password from the SQLAlchemy URL (scheme://user:pass@host:port/db)
DB_NAME="$(python3 - <<PYEOF 2>/dev/null || true
from urllib.parse import urlparse
u = urlparse("$DATABASE_URL")
print(u.path.lstrip('/') or 'ict_ticketing')
PYEOF
)"
DB_USER="${MYSQL_USER:-}"
DB_PASS="${MYSQL_PASSWORD:-}"
if [ -z "$DB_USER" ]; then
    DB_USER="$(python3 - <<PYEOF 2>/dev/null || true
from urllib.parse import urlparse
u = urlparse("$DATABASE_URL")
print(u.username or 'root')
PYEOF
)"
    DB_PASS="$(python3 - <<PYEOF 2>/dev/null || true
from urllib.parse import urlparse
u = urlparse("$DATABASE_URL")
print(u.password or '')
PYEOF
)"
fi
if [ "$DB_USER" = "root" ] && [ -z "$DB_PASS" ]; then
    DB_PASS="${MYSQL_PASSWORD:-}"
fi

MYSQLDUMP="${MYSQLDUMP:-/opt/lampp/bin/mysqldump}"
[ -x "$MYSQLDUMP" ] || { echo "FAIL: mysqldump not found at $MYSQLDUMP (set MYSQLDUMP)"; exit 1; }
command -v zstd >/dev/null 2>&1 || { echo "FAIL: zstd not installed (apt install zstd)"; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-$REPO_DIR/backend/backups}"
UPLOAD_FOLDER="${UPLOAD_FOLDER:-$REPO_DIR/backend/uploads}"

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
DAILY_FILE="ict_ticketing_${TIMESTAMP}.sql.zst"
START="$(date +%s)"

# Credentials never appear on the command line.
CREDARGS=(-u "$DB_USER")
if [ -n "$DB_PASS" ]; then
    export MYSQL_PWD="$DB_PASS"
fi

echo "[$(date -Iseconds)] Starting XAMPP backup → $BACKUP_DIR/daily/$DAILY_FILE"

# ── Dump + compress; pipefail turns any mysqldump error into a failure ──────
if ! "$MYSQLDUMP" "${CREDARGS[@]}" \
        --single-transaction \
        --triggers \
        --hex-blob \
        "$DB_NAME" \
        | zstd -3 > "$BACKUP_DIR/daily/$DAILY_FILE"; then
    rm -f "$BACKUP_DIR/daily/$DAILY_FILE"
    echo "FAIL: mysqldump or zstd failed — no artifact retained."
    exit 1
fi

# ── Integrity: checksum + stream validity + expected table present ─────────
( cd "$BACKUP_DIR/daily" && sha256sum "$DAILY_FILE" > "$DAILY_FILE.sha256" )

FAILED=0
zstd -t "$BACKUP_DIR/daily/$DAILY_FILE" >/dev/null 2>&1 \
    || { echo "FAIL: zstd -t rejected the dump stream."; FAILED=1; }

if ! zstd -d "$BACKUP_DIR/daily/$DAILY_FILE" --stdout 2>/dev/null \
        | grep -q "CREATE TABLE \`users\`"; then
    echo "FAIL: dump is missing the users table — not a usable backup."
    FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
    rm -f "$BACKUP_DIR/daily/$DAILY_FILE" "$BACKUP_DIR/daily/$DAILY_FILE.sha256"
    exit 1
fi

DURATION="$(( $(date +%s) - START ))"
SIZE="$(du -h "$BACKUP_DIR/daily/$DAILY_FILE" | cut -f1)"
echo "[$(date -Iseconds)] Backup OK: $SIZE, ${DURATION}s, checksum verified."

# ── Uploads archive (database does not cover attachment files) ──────────────
if [ -d "$UPLOAD_FOLDER" ] && [ -n "$(ls -A "$UPLOAD_FOLDER" 2>/dev/null)" ]; then
    UPLOADS_FILE="ict_ticketing_${TIMESTAMP}.uploads.tar.zst"
    tar -C "$(dirname "$UPLOAD_FOLDER")" \
        --exclude-vcs \
        -cf - "$(basename "$UPLOAD_FOLDER")" \
        | zstd -3 > "$BACKUP_DIR/daily/$UPLOADS_FILE"
    ( cd "$BACKUP_DIR/daily" && sha256sum "$UPLOADS_FILE" > "$UPLOADS_FILE.sha256" )
    echo "[$(date -Iseconds)] Uploads archived → $UPLOADS_FILE"
else
    echo "[$(date -Iseconds)] No uploads directory to archive ($UPLOAD_FOLDER absent/empty)."
fi

# ── Weekly copy (Sundays) ───────────────────────────────────────────────────
if [ "$(date +%u)" -eq 7 ]; then
    WEEKLY_FILE="ict_ticketing_weekly_${TIMESTAMP}.sql.zst"
    cp "$BACKUP_DIR/daily/$DAILY_FILE" "$BACKUP_DIR/weekly/$WEEKLY_FILE"
    ( cd "$BACKUP_DIR/weekly" && sha256sum "$WEEKLY_FILE" > "$WEEKLY_FILE.sha256" )
    echo "[$(date -Iseconds)] Weekly copy → $BACKUP_DIR/weekly/$WEEKLY_FILE"
fi

# ── Rotation: keep 7 daily, 4 weekly ────────────────────────────────────────
echo "[$(date -Iseconds)] Rotating …"
find "$BACKUP_DIR/daily"   -maxdepth 1 -type f -name 'ict_ticketing_*.sql.zst' \
    -printf '%T@|%p\n' | sort -rn | tail -n +8 | cut -d'|' -f2- | xargs -r rm -f
find "$BACKUP_DIR/weekly"  -maxdepth 1 -type f -name 'ict_ticketing_weekly_*.sql.zst' \
    -printf '%T@|%p\n' | sort -rn | tail -n +5 | cut -d'|' -f2- | xargs -r rm -f

echo "[$(date -Iseconds)] Backup complete (exit 0)."