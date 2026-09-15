#!/usr/bin/env bash
# =============================================================================
# Restore drill: spin up a throwaway MySQL container, restore the most recent
# backup, and verify row counts.  Exits non-zero if the sanity check fails.
#
# Prerequisites on the host:
#   - docker available
#   - zstd installed
#   - .env in the project root with BACKUP_DIR
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    source "$PROJECT_DIR/.env"
    set +a
fi

BACKUP_DIR="${BACKUP_DIR:-/var/backups/ict_ticketing}"
DRILL_PASSWORD="drill_test_$(date +%s)"

# ── Find the most recent backup ──────────────────────────────────────────────
LATEST="$(ls -t "$BACKUP_DIR"/daily/*.sql.zst 2>/dev/null | head -1 || true)"

if [ -z "$LATEST" ]; then
    echo "FAIL: No backups found in $BACKUP_DIR/daily/"
    exit 1
fi

echo "Most recent backup: $LATEST"

# ── Start throwaway MySQL container ──────────────────────────────────────────
echo "Starting throwaway MySQL container …"
CONTAINER="$(docker run -d \
    -e MYSQL_ROOT_PASSWORD="$DRILL_PASSWORD" \
    -e MYSQL_DATABASE=ict_ticketing \
    mysql:8.0)"

echo "Container ID: $CONTAINER"

cleanup() {
    echo "Cleaning up container $CONTAINER …"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── Wait for MySQL to accept connections ──────────────────────────────────────
echo "Waiting for MySQL to be ready …"
RETRIES=30
until docker exec "$CONTAINER" mysqladmin ping -h localhost --silent 2>/dev/null; do
    RETRIES=$((RETRIES - 1))
    if [ "$RETRIES" -le 0 ]; then
        echo "FAIL: MySQL did not become ready in time."
        exit 1
    fi
    sleep 2
done
echo "MySQL is ready."

# ── Restore the backup ───────────────────────────────────────────────────────
echo "Restoring backup …"
zstd -d "$LATEST" --stdout \
    | docker exec -i "$CONTAINER" mysql -u root -p"$DRILL_PASSWORD" ict_ticketing

# ── Sanity check ─────────────────────────────────────────────────────────────
COUNT="$(docker exec "$CONTAINER" \
    mysql -u root -p"$DRILL_PASSWORD" ict_ticketing \
    -N -e "SELECT COUNT(*) FROM users;" 2>/dev/null)"

echo "Restored user count: $COUNT"

if [ "$COUNT" -eq 0 ]; then
    echo "FAIL: Sanity check failed — 0 users in restored database."
    echo "This indicates the backup is empty or the restore failed."
    exit 1
fi

echo "PASS: Restore drill completed successfully. $COUNT user(s) found."
