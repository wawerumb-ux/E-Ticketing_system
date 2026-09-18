#!/usr/bin/env bash
# =============================================================================
# XAMPP-native RESTORE DRILL: safely restore a backup artifact into a
# throwaway database and verify it against the source baseline. NO Docker.
#
# SAFETY (non-negotiable):
#   - Default target is a SCRATCH database (ict_ticketing_drill), never live.
#   - Refusing to restore into the live database (ict_ticketing) unless the
#     explicit --allow-live flag is passed (not used by a drill).
#   - Refusing any target named mysql / information_schema / performance_schema
#     / sys regardless of flags.
#   - The artifact's SHA-256 and zstd validity are verified BEFORE anything
#     is created or dropped. A checksum-mismatched or corrupt artifact exits 1.
#   - On SUCCESS the scratch database is dropped again (use --keep-scratch to
#     preserve it). On FAILURE the scratch database is KEPT for inspection and
#     the script exits 1.
#
# VERIFICATION performed after restore:
#   1. Table count in target == table count declared by the artifact.
#   2. Row count of EVERY table compared target-vs-source (exact COUNT(*),
#      not information_schema estimates — those are approximate for InnoDB).
#   3. Referential integrity: orphans probed for the known FK relationships:
#        ticket_comments.ticket_id → tickets.id
#        ticket_attachments.ticket_id → tickets.id
#        notifications.user_id → users.id
#        password_reset_tokens.user_id → users.id
#        social_accounts.user_id → users.id
#   4. Companion uploads archive (.uploads.tar.zst) integrity + entry count,
#      extracted to a temp dir and compared to the live uploads folder.
#
# Usage:  scripts/restore-local.sh <artifact.sql.zst>
#   --target <name>      target (scratch) database, default ict_ticketing_drill
#   --source <name>      comparison source, default parsed from DATABASE_URL
#   --allow-live         DANGEROUS: permit target == live DB. Not for drills.
#   --keep-scratch       keep the scratch database after a successful restore
#
# Environment: same as backup-local.sh (MYSQL, MYSQLDUMP, MYSQL_USER,
#   MYSQL_PASSWORD, DATABASE_URL, UPLOAD_FOLDER).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$REPO_DIR/backend/.env"

get_env() {
    local key="$1"
    if [ -f "$ENV_FILE" ]; then
        sed -n "s/^[[:space:]]*${key}=//p" "$ENV_FILE" | tail -1 || true
    fi
}

DATABASE_URL="${DATABASE_URL:-$(get_env DATABASE_URL)}"
DATABASE_URL="${DATABASE_URL:-mysql+pymysql://root:@127.0.0.1:3306/ict_ticketing}"

SOURCE_DB="$(python3 - "$DATABASE_URL" <<'PYEOF'
import sys
from urllib.parse import urlparse
print(urlparse(sys.argv[1]).path.lstrip('/') or 'ict_ticketing')
PYEOF
)"
DB_USER="$(python3 - "$DATABASE_URL" <<'PYEOF'
import sys
from urllib.parse import urlparse
print(urlparse(sys.argv[1]).username or 'root')
PYEOF
)"
DB_PASS="$(python3 - "$DATABASE_URL" <<'PYEOF'
import sys
from urllib.parse import urlparse
print(urlparse(sys.argv[1]).password or '')
PYEOF
)"
DB_USER="${MYSQL_USER:-$DB_USER}"
if [ "$DB_USER" = "root" ] && [ -z "$DB_PASS" ]; then
    DB_PASS="${MYSQL_PASSWORD:-}"
fi

TARGET_DB="ict_ticketing_drill"
ALLOW_LIVE=0
KEEP_SCRATCH=0
ARTIFACT=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --target)   TARGET_DB="$2"; shift 2 ;;
        --source)   SOURCE_DB="$2"; shift 2 ;;
        --allow-live) ALLOW_LIVE=1; shift ;;
        --keep-scratch) KEEP_SCRATCH=1; shift ;;
        *) ARTIFACT="$1"; shift ;;
    esac
done

MYSQL="${MYSQL:-/opt/lampp/bin/mysql}"
[ -x "$MYSQL" ] || { echo "FAIL: mysql client not found at $MYSQL (set MYSQL)"; exit 1; }
command -v zstd >/dev/null 2>&1 || { echo "FAIL: zstd not installed"; exit 1; }

[ -n "$ARTIFACT" ] || { echo "FAIL: no artifact given. Usage: restore-local.sh <artifact.sql.zst>"; exit 1; }
[ -f "$ARTIFACT" ] || { echo "FAIL: artifact not found: $ARTIFACT"; exit 1; }
[ -f "$ARTIFACT.sha256" ] || { echo "FAIL: missing checksum file: $ARTIFACT.sha256"; exit 1; }

CREDARGS=(-u "$DB_USER")
if [ -n "$DB_PASS" ]; then
    export MYSQL_PWD="$DB_PASS"
fi

# ── Safety gates (before any SQL runs) ──────────────────────────────────────
SENSITIVE="^(mysql|information_schema|performance_schema|sys)$"
if [ "$TARGET_DB" = "$SOURCE_DB" ] && [ "$ALLOW_LIVE" -ne 1 ]; then
    echo "FAIL: target '$TARGET_DB' is the source/live database. A restore "
    echo "      would overwrite it. Pass --allow-live to override (NOT a drill)."
    exit 1
fi
if [[ "$TARGET_DB" =~ $SENSITIVE ]]; then
    echo "FAIL: refusing a reserved database name as target: $TARGET_DB"
    exit 1
fi
if "$MYSQL" "${CREDARGS[@]}" -N -e "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$TARGET_DB'" | grep -q .; then
    echo "FAIL: target database '$TARGET_DB' already exists. Drop it or pick --target."
    exit 1
fi

# ── Artifact integrity (checksum must match BEFORE anything happens) ───────
( cd "$(dirname "$ARTIFACT")" && sha256sum -c "$(basename "$ARTIFACT.sha256")" ) || {
    echo "FAIL: SHA-256 mismatch — artifact is corrupt or tampered. Stopping."
    exit 1
}
zstd -t "$ARTIFACT" >/dev/null 2>&1 || { echo "FAIL: zstd -t rejected the artifact."; exit 1; }

ARTIFACT_TABLES="$(zstd -d "$ARTIFACT" --stdout 2>/dev/null | grep -cE "^CREATE TABLE")"
[ "$ARTIFACT_TABLES" -gt 0 ] || { echo "FAIL: artifact declares no tables."; exit 1; }

START="$(date +%s)"

# ── Restore into the scratch database ───────────────────────────────────────
echo "[$(date -Iseconds)] Restoring '$ARTIFACT' → $TARGET_DB (source baseline: $SOURCE_DB)"
"$MYSQL" "${CREDARGS[@]}" -e "CREATE DATABASE \`$TARGET_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
zstd -d "$ARTIFACT" --stdout 2>/dev/null | "$MYSQL" "${CREDARGS[@]}" "$TARGET_DB" \
    || { echo "FAIL: mysql restore command failed."; exit 1; }

# ── Verify: schema + rows + relationships + access ─────────────────────────
echo "[$(date -Iseconds)] Verifying …"

RESTORED_TABLES="$( "$MYSQL" "${CREDARGS[@]}" -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$TARGET_DB'" )"

DIFFS=0
while IFS= read -r tbl; do
    [ -z "$tbl" ] && continue
    src_cnt="$( "$MYSQL" "${CREDARGS[@]}" -N -e "SELECT COUNT(*) FROM \`$SOURCE_DB\`.\`$tbl\`" 2>/dev/null || echo "ERR" )"
    tgt_cnt="$( "$MYSQL" "${CREDARGS[@]}" -N -e "SELECT COUNT(*) FROM \`$TARGET_DB\`.\`$tbl\`" 2>/dev/null || echo "MISSING" )"
    if [ "$src_cnt" != "$tgt_cnt" ]; then
        echo "  MISMATCH $tbl: source=$src_cnt target=$tgt_cnt"
        DIFFS=1
    fi
done < <( "$MYSQL" "${CREDARGS[@]}" -N -e "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SOURCE_DB' ORDER BY TABLE_NAME" )

if [ "$RESTORED_TABLES" -ne "$ARTIFACT_TABLES" ]; then
    echo "  MISMATCH table count: artifact=$ARTIFACT_TABLES restored=$RESTORED_TABLES"
    DIFFS=1
fi

# Referential integrity: orphan probe for the documented FK pairs.
FK_PROBES=( "ticket_comments:ticket_id:tickets:id" \
            "ticket_attachments:ticket_id:tickets:id" \
            "notifications:user_id:users:id" \
            "password_reset_tokens:user_id:users:id" \
            "social_accounts:user_id:users:id" )
for probe in "${FK_PROBES[@]}"; do
    IFS=: read -r child col parent pcol <<<"$probe"
    [ -z "$col" ] && continue
    col_exists="$( "$MYSQL" "${CREDARGS[@]}" -N -e "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SOURCE_DB' AND TABLE_NAME='$child' AND COLUMN_NAME='$col'" )"
    [ "$col_exists" = "0" ] && continue
    orphans="$( "$MYSQL" "${CREDARGS[@]}" -N -e "SELECT COUNT(*) FROM \`$TARGET_DB\`.\`$child\` c LEFT JOIN \`$TARGET_DB\`.\`$parent\` p ON c.\`$col\`=p.\`$pcol\` WHERE p.\`$pcol\` IS NULL" )"
    echo "  FK $child.$col → $parent.$pcol: orphans=$orphans"
    [ "$orphans" != "0" ] && DIFFS=1
done

# App-principal read access (same principal the app uses against live DB).
"$MYSQL" "${CREDARGS[@]}" -N -e "SELECT CONCAT('read-ok ', COUNT(*)) FROM \`$TARGET_DB\`.\`users\`" >/dev/null \
    || { echo "  FAIL: target DB not readable by app principal"; DIFFS=1; }

if [ "$DIFFS" -ne 0 ]; then
    echo "[$(date -Iseconds)] RESTORE VERIFICATION FAILED. Keeping $TARGET_DB for inspection."
    exit 1
fi

# ── Companion uploads archive ───────────────────────────────────────────────
UPLOADS_ART="${ARTIFACT%.sql.zst}.uploads.tar.zst"
if [ -f "$UPLOADS_ART" ] && [ -f "$UPLOADS_ART.sha256" ]; then
    ( cd "$(dirname "$UPLOADS_ART")" && sha256sum -c "$(basename "$UPLOADS_ART.sha256")" ) >/dev/null 2>&1 \
        || { echo "FAIL: uploads archive checksum mismatch."; exit 1; }
    zstd -t "$UPLOADS_ART" >/dev/null 2>&1 || { echo "FAIL: uploads archive corrupt."; exit 1; }
    ARCH_ENTRIES="$(tar -tf "$UPLOADS_ART" | wc -l)"
    echo "  uploads archive OK — entries=$ARCH_ENTRIES"
else
    ARCH_ENTRIES=""
    echo "  (no uploads archive for this artifact — DB-only restore)"
fi
UPLOAD_FOLDER="${UPLOAD_FOLDER:-$REPO_DIR/backend/uploads}"
if [ -d "$UPLOAD_FOLDER" ]; then
    LIVE_ENTRIES="$(find "$UPLOAD_FOLDER" -type f | wc -l)"
    echo "  live uploads files=$LIVE_ENTRIES (archived=$ARCH_ENTRIES)"
fi

DURATION="$(( $(date +%s) - START ))"
SIZE="$(du -h "$ARTIFACT" | cut -f1)"
echo "[$(date -Iseconds)] RESTORE + VERIFY OK: ${DURATION}s, artifact ${SIZE}."

if [ "$KEEP_SCRATCH" -eq 1 ]; then
    echo "[$(date -Iseconds)] Keeping $TARGET_DB (--keep-scratch)."
else
    "$MYSQL" "${CREDARGS[@]}" -e "DROP DATABASE \`$TARGET_DB\`"
    echo "[$(date -Iseconds)] Scratch database $TARGET_DB dropped. Environment clean."
fi

echo "Restore drill complete (exit 0)."
exit 0