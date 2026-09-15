#!/usr/bin/env bash
# =============================================================================
# Nightly backup: mysqldump | zstd, with daily/weekly rotation.
#
# Prerequisites on the host:
#   - docker compose v2 available
#   - zstd installed (apt install zstd / brew install zstd)
#   - .env in the project root with MYSQL_ROOT_PASSWORD and BACKUP_DIR
#
# Crontab example (runs at 02:00 daily):
#   0 2 * * * /path/to/scripts/backup.sh >> /var/log/ict-backup.log 2>&1
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ── Load environment ──────────────────────────────────────────────────────────
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    source "$PROJECT_DIR/.env"
    set +a
fi

: "${MYSQL_ROOT_PASSWORD:?MYSQL_ROOT_PASSWORD must be set in .env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ict_ticketing}"

# This backup is LOCAL ONLY unless OFFSITE_BACKUP_ENABLED=true. If
# the laptop is lost, an idle offsite backup is also lost. Copying
# the local backup to an external drive is the developer's
# responsibility.
#
# When OFFSITE_BACKUP_ENABLED=true, this script hands the newest local
# backup to scripts/offsite_backup.sh (an IDLE — costs money when enabled
# component) to upload it offsite.
TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
DAILY_FILE="ict_ticketing_${TIMESTAMP}.sql.zst"

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

# ── Dump and compress ─────────────────────────────────────────────────────────
echo "[$(date -Iseconds)] Starting backup …"

docker compose -f "$PROJECT_DIR/docker-compose.yml" exec -T mysql \
    mysqldump \
        -u root \
        -p"$MYSQL_ROOT_PASSWORD" \
        --single-transaction \
        --routines \
        --triggers \
        --events \
        ict_ticketing \
| zstd -3 > "$BACKUP_DIR/daily/$DAILY_FILE"

echo "[$(date -Iseconds)] Daily backup → $BACKUP_DIR/daily/$DAILY_FILE"

# ── Weekly copy (Sundays) ────────────────────────────────────────────────────
if [ "$(date +%u)" -eq 7 ]; then
    WEEKLY_FILE="ict_ticketing_weekly_${TIMESTAMP}.sql.zst"
    cp "$BACKUP_DIR/daily/$DAILY_FILE" "$BACKUP_DIR/weekly/$WEEKLY_FILE"
    echo "[$(date -Iseconds)] Weekly backup → $BACKUP_DIR/weekly/$WEEKLY_FILE"
fi

# ── Rotation: keep 7 daily, 4 weekly ─────────────────────────────────────────
echo "[$(date -Iseconds)] Rotating old backups …"

cd "$BACKUP_DIR/daily"
ls -t *.sql.zst 2>/dev/null | tail -n +8 | xargs -r rm -f

cd "$BACKUP_DIR/weekly"
ls -t *.sql.zst 2>/dev/null | tail -n +5 | xargs -r rm -f

echo "[$(date -Iseconds)] Backup complete."

# ── Offsite upload (idle unless explicitly enabled) ─────────────────────────
offsite_enabled="$(printf '%s' "${OFFSITE_BACKUP_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')"
if [ "$offsite_enabled" = "true" ]; then
    # IDLE — costs money when enabled (provider storage/egress).
    exec "$SCRIPT_DIR/offsite_backup.sh"
else
    echo "[$(date -Iseconds)] offsite backup idle"
fi
