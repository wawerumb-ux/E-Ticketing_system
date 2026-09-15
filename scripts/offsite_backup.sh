#!/usr/bin/env bash
# =============================================================================
# Offsite backup uploader — IDLE component.
#
# Reads OFFSITE_BACKUP_ENABLED from .env. Default is false:
#   1. logs "offsite backup idle — not configured"
#   2. exits 0 without invoking any provider CLI or reading credentials.
#
# When true, uploads the most recent LOCAL backup to the provider named by
# OFFSITE_BACKUP_PROVIDER using `rclone` (b2 is the default remote name).
# rclone is used because it is provider-agnostic (Backblaze B2, S3, Dropbox,
# ...) and reads its OWN out-of-repo config — no cloud credentials are ever
# stored in this repository. If the CLI is missing while the flag is true, we
# fail loudly (non-zero) instead of silently skipping the offsite copy.
#
# Costs money when enabled (pay-per-GB storage + egress on the provider).
# =============================================================================
# IDLE — costs money when enabled. Set OFFSITE_BACKUP_ENABLED=true in .env.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    source "$PROJECT_DIR/.env"
    set +a
fi

# ── Idle short-circuit (the canonical pattern) ──────────────────────────────
enabled="$(printf '%s' "${OFFSITE_BACKUP_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')"
if [ "$enabled" != "true" ]; then
    echo "[$(date -Iseconds)] offsite backup idle — not configured"
    exit 0
fi

# ── Enabled: upload the most recent local backup ────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ict_ticketing}"
provider="${OFFSITE_BACKUP_PROVIDER:-b2}"
remote="${OFFSITE_BACKUP_REMOTE:-${provider}:ict-backups}"

LATEST="$(ls -t "$BACKUP_DIR"/daily/*.sql.zst 2>/dev/null | head -1 || true)"
if [ -z "$LATEST" ]; then
    echo "FAIL: no local backup found to upload ($BACKUP_DIR/daily/ is empty)."
    exit 1
fi

if ! command -v rclone >/dev/null 2>&1; then
    echo "FAIL: OFFSITE_BACKUP_ENABLED=true but 'rclone' is not installed."
    echo "      Install it (e.g. 'apt install rclone'), then configure a remote:"
    echo "        rclone config      # create a remote named '${provider}' (e.g. Backblaze B2)"
    exit 1
fi

echo "[$(date -Iseconds)] Uploading $LATEST → ${provider} remote '$remote' …"
rclone copy "$LATEST" "$remote" --log-level INFO
echo "[$(date -Iseconds)] Offsite upload complete."