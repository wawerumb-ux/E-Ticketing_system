#!/usr/bin/env bash
# ==============================================================================
# Deploy smoke test — proves a deployed instance is actually usable.
#
#   Usage:  bash scripts/smoke-test.sh https://your-app.up.railway.app
#           bash scripts/smoke-test.sh http://localhost:8000
#
# Each check names the failure it is designed to catch. The point is not "is it
# up" — it is "did every layer we changed on 2026-09-26 actually work": the
# Railway variable resolution, the schema bootstrap, the JWT secrets, CORS.
#
# Exits 0 only if every check passes.
# ==============================================================================
set -uo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
    echo "usage: bash scripts/smoke-test.sh <base-url>" >&2
    exit 2
fi
BASE="${BASE%/}"

USER="${SMOKE_USER:-admin}"
PASS="${SMOKE_PASS:-admin123}"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; fail=$((fail+1)); }

echo
echo "Smoke test: $BASE"
echo "=========================================================="

# --- 1. health: does the app boot AND can it reach MySQL? -------------------
# backend/routes/main.py:33 runs a real `SELECT 1`. A 503 here means the
# container started but the database URI did not resolve or auth was rejected —
# the exact failure an empty MYSQL_PASSWORD produces.
echo
echo "[1/6] health + database reachability"
body="$(curl -sS -m 20 -w '\n%{http_code}' "$BASE/api/health" 2>/dev/null)"
code="$(printf '%s' "$body" | tail -n1)"
json="$(printf '%s' "$body" | sed '$d')"
if [ "$code" = "200" ] && printf '%s' "$json" | grep -q '"database":true'; then
    ok "healthy, database reachable"
else
    bad "health returned $code" "$json"
    echo
    echo "  A 503 'database-unreachable' means the DB URI did not resolve."
    echo "  Check that MYSQL_PASSWORD / MYSQL_USER / MYSQL_HOST are set on the"
    echo "  service, then read the boot log for the resolved host."
fi

# --- 2. CORS: is the deployed origin allowed? --------------------------------
# backend/app.py get_allowed_origins() falls back to localhost when
# ALLOWED_ORIGINS is unset, which blocks the browser before any request.
echo
echo "[2/6] CORS preflight from the deployed origin"
hdr="$(curl -sS -m 20 -D - -o /dev/null -X OPTIONS \
    -H "Origin: $BASE" \
    -H 'Access-Control-Request-Method: GET' \
    "$BASE/api/health" 2>/dev/null)"
if printf '%s' "$hdr" | grep -qi 'access-control-allow-origin'; then
    ok "CORS allows $BASE"
else
    bad "no Access-Control-Allow-Origin header" \
        "set ALLOWED_ORIGINS=$BASE on the service (no trailing slash)"
fi

# --- 3. login: were the secrets strong enough to sign a token? ---------------
# Fails 401 on wrong credentials, 403 if Turnstile is enforced. Login is rate
# limited to 5/min (backend/routes/auth.py:37), so do not loop this.
echo
echo "[3/6] login as $USER"
login="$(curl -sS -m 20 -w '\n%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
    "$BASE/api/auth/login" 2>/dev/null)"
lcode="$(printf '%s' "$login" | tail -n1)"
ljson="$(printf '%s' "$login" | sed '$d')"
TOKEN="$(printf '%s' "$ljson" | jq -r '.access_token // empty' 2>/dev/null)"
if [ "$lcode" = "200" ] && [ -n "$TOKEN" ]; then
    ok "authenticated, received a signed access token"
else
    bad "login returned $lcode" "$ljson"
    if [ "$lcode" = "403" ]; then
        echo "        403 = Turnstile is enforcing. Set CF_TURNSTILE_ENABLED=false."
    fi
    TOKEN=""
fi

# --- 4. authenticated read: is server-side scoping live? ---------------------
echo
echo "[4/6] authenticated GET /api/tickets"
if [ -n "$TOKEN" ]; then
    t="$(curl -sS -m 20 -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" \
        "$BASE/api/tickets" 2>/dev/null)"
    tcode="$(printf '%s' "$t" | tail -n1)"
    if [ "$tcode" = "200" ]; then
        n="$(printf '%s' "$t" | sed '$d' | jq -r 'if type=="array" then length else (.tickets|length) end' 2>/dev/null)"
        ok "listed tickets (${n:-?}) with a valid token"
    else
        bad "GET /api/tickets returned $tcode" "$(printf '%s' "$t" | sed '$d' | head -c 200)"
    fi
else
    bad "skipped — no token from step 3"
fi

# --- 5. write: can we create a ticket end to end? ---------------------------
echo
echo "[5/6] create a ticket"
if [ -n "$TOKEN" ]; then
    c="$(curl -sS -m 25 -w '\n%{http_code}' -X POST \
        -H "Authorization: Bearer $TOKEN" \
        -H 'Content-Type: application/json' \
        -d '{"title":"Smoke test ticket","description":"Created by scripts/smoke-test.sh. Safe to delete.","category":"other"}' \
        "$BASE/api/tickets" 2>/dev/null)"
    ccode="$(printf '%s' "$c" | tail -n1)"
    if [ "$ccode" = "200" ] || [ "$ccode" = "201" ]; then
        tid="$(printf '%s' "$c" | sed '$d' | jq -r '.ticket_number // .id // "?"' 2>/dev/null)"
        ok "created ticket ${tid}"
    else
        bad "POST /api/tickets returned $ccode" "$(printf '%s' "$c" | sed '$d' | head -c 200)"
        if [ "$ccode" = "400" ]; then
            echo "        400 = title/description/category missing; category must be a real value."
        fi
    fi
else
    bad "skipped — no token from step 3"
fi

# --- 6. frontend: is the UI actually served? ---------------------------------
# The root Dockerfile copies frontend/ to /frontend and main.py resolves
# ../frontend from /app. If this 404s the API works but nobody can use it.
echo
echo "[6/6] frontend is served"
fcode="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null)"
if [ "$fcode" = "200" ]; then
    ok "GET / returned 200"
else
    bad "GET / returned $fcode" "API works but the UI is not reachable"
fi

# --- summary -----------------------------------------------------------------
echo
echo "=========================================================="
printf 'passed %s   failed %s\n' "$pass" "$fail"
if [ "$fail" -eq 0 ]; then
    echo "RESULT: deploy is usable. Log in and delete the smoke-test ticket."
    exit 0
fi
echo "RESULT: not usable yet. Fix the failures above, then redeploy."
exit 1
