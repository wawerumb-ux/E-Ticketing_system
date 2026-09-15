#!/usr/bin/env bash
# preflight.sh — verify the environment before booting the E-Ticketing server.
#
# Checks (mirrors AGENTS.md Section 9 + environment risks E1/E2):
#   1. Only one copy of the project exists (stale-copy risk)
#   2. backend/venv313 exists and Python is 3.13.x
#   3. MySQL is reachable on 127.0.0.1:3306 (XAMPP); offers to start it
#   4. No other instance of the app is already running
#   5. Git status (uncommitted work alert)
#
# Usage:  bash scripts/preflight.sh
# Exit:   0 = all clear, 1 = a blocking check failed (or user declined to start MySQL)
set -u

CWD="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
WARN=0
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { printf "${GREEN}ok${NC}   %s\n" "$1"; }
warn() { printf "${YELLOW}warn${NC} %s\n" "$1"; WARN=$((WARN+1)); }
fail() { printf "${RED}FAIL${NC} %s\n" "$1"; FAIL=$((FAIL+1)); }

echo "== E-Ticketing pre-flight ($CWD) =="

# 1. Single-copy check
echo
echo "-- 1. Project copies --"
COPIES="$(find /home/devsling -maxdepth 4 -type d -name 'E-Ticketing_system' 2>/dev/null)"
N_COPIES="$(printf '%s\n' "$COPIES" | grep -c .)"
if [ "$N_COPIES" -eq 1 ]; then
  ok "single copy: $COPIES"
else
  printf '%s\n' "$COPIES"
  warn "expected exactly 1 copy, found $N_COPIES — confirm which folder the live server runs from:"
  warn '  ps aux | grep -iE "gunicorn|python.*app.py"'
fi

# 2. venv + python version
echo
echo "-- 2. Virtualenv --"
VENV="$CWD/backend/venv313"
if [ ! -x "$VENV/bin/python" ]; then
  fail "backend/venv313/bin/python missing (venv renamed? recreate with python3.13 -m venv backend/venv313)"
elif [ "$(basename "$(cd "$(dirname "$VENV/bin/python")/.." && pwd)")" != "venv313" ]; then
  fail "venv directory name does not match expected backend/venv313"
else
  PYVER="$("$VENV/bin/python" --version 2>&1)"
  ok "venv313 present: $PYVER"
  case "$PYVER" in
    *3.13*) ok "python 3.13.x (matches E1)" ;;
    *) warn "python version drift (E1): expected 3.13.x, got $PYVER" ;;
  esac
  # confirm the venv actually works (imports sqlalchemy)
  if "$VENV/bin/python" -c 'import sqlalchemy; print(sqlalchemy.__version__)' >/dev/null 2>&1; then
    ok "sqlalchemy importable"
  else
    fail "sqlalchemy import failed in venv313"
  fi
fi

# 3. MySQL via XAMPP
echo
echo "-- 3. MySQL (XAMPP) --"
PORT_OPEN="$( (exec 3<>/dev/tcp/127.0.0.1/3306) 2>/dev/null && echo yes || echo no )"
if [ "$PORT_OPEN" = "yes" ]; then
  ok "127.0.0.1:3306 is listening (XAMPP mysqld)"
else
  warn "No MySQL on 127.0.0.1:3306 — this is usually XAMPP not started (E2)."
  if [ -x /opt/lampp/lampp ]; then
    read -r -p "  Start XAMPP MySQL now? [y/N] " ANS
    case "$ANS" in
      y|Y)
        sudo /opt/lampp/lampp startmysql 2>&1 || true
        sleep 2
        if (exec 3<>/dev/tcp/127.0.0.1/3306) 2>/dev/null; then
          ok "XAMPP MySQL started"
        else
          fail "XAMPP MySQL still not reachable after start"
        fi
        ;;
      *) fail "MySQL unavailable; start XAMPP mysql first (sudo /opt/lampp/lampp startmysql)" ;;
    esac
  else
    fail "MySQL unavailable and /opt/lampp/lampp not found"
  fi
fi

# 4. Already running?
echo
echo "-- 4. Existing app process --"
RUNNING="$(ps aux | grep -iE 'gunicorn.*app:app|python.*app\.py' | grep -v grep || true)"
if [ -n "$RUNNING" ]; then
  warn "an app instance appears to be running already:"
  printf '%s\n' "$RUNNING"
else
  ok "no app process currently running"
fi

# 5. Git status
echo
echo "-- 5. Git status --"
if [ -d "$CWD/.git" ]; then
  UNCOMMITTED="$(git -C "$CWD" status --porcelain | wc -l | tr -d ' ')"
  if [ "$UNCOMMITTED" -eq 0 ]; then
    ok "working tree clean"
  else
    warn "$UNCOMMITTED uncommitted change(s) — run git status"
  fi
  CUR_BRANCH="$(git -C "$CWD" branch --show-current 2>/dev/null)"
  [ -n "$CUR_BRANCH" ] && ok "branch: $CUR_BRANCH"
else
  warn "not a git repo (git init recommended)"
fi

echo
if [ "$FAIL" -gt 0 ]; then
  printf "${RED}Pre-flight FAILED: %s blocking issue(s)%s\n" "$FAIL" "${NC}"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  printf "${YELLOW}Pre-flight passed with %s warning(s)%s\n" "$WARN" "${NC}"
  exit 0
else
  printf "${GREEN}Pre-flight passed — all clear.%s\n" "${NC}"
  exit 0
fi