#!/usr/bin/env python3
"""CI quality gate for E-Ticketing System (no new dependencies, stdlib only).

Runs the *actual* validation commands already proven green in this repo:
  - backend unittest suite (isolated, in-memory SQLite)
  - frontend validator (scripts/validate-frontend.js)
  - python compile (syntax) of the backend source paths
  - schema drift check (scripts/check-schema-drift.py) against live MySQL

This gate is deliberately NOT a style gate — it BLOCKS a change that breaks
any of the real checks above.

Exit codes:
  0  gate passed (all real checks green) — change may proceed to release
  1  gate FAILED (a real check went red) — change is BLOCKED from release
  2  usage error (bad flags)
Anything non-zero BLOCKS the change (this is the enforcement contract:
a change that fails CI must not reach release).

Usage:
  python3 scripts/ci-quality-gate.py            # run all checks
  python3 scripts/ci-quality-gate.py --fast     # skip the slow DB-backed suite
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND = REPO_ROOT / "backend"
VENV_PY = BACKEND / "venv313" / "bin" / "python"

CHECKS = []

def check(name, cmd, cwd=REPO_ROOT, env=None):
    """Register a real command as a gate step."""
    CHECKS.append((name, cmd, cwd, env))

# --- the real, already-proven commands (do not invent) ---
check(
    "backend unit tests",
    [str(VENV_PY), "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
    cwd=BACKEND,
)
check(
    "frontend validator",
    ["node", "scripts/validate-frontend.js"],
    cwd=REPO_ROOT,
)
check(
    "python compile (syntax) all backend",
    [str(VENV_PY), "-m", "compileall", "-q", "app.py", "extensions.py", "models.py", "helpers.py", "schema.py", "routes"],
    cwd=BACKEND,
)
# Schema drift vs the live MySQL (E3 manual-migration rule). Requires the
# XAMPP MySQL to be up (E2). Exit 1 = drift found (block: needs manual
# ALTER recorded in Alembic); exit 2 = cannot connect (block: no evidence).
check(
    "schema drift (models vs live DB)",
    [str(VENV_PY), "scripts/check-schema-drift.py"],
    cwd=REPO_ROOT,
)

def run_gate(fast=False):
    """Run each real command; as soon as one fails, the gate fails."""
    fast_skip = {"backend unit tests", "schema drift (models vs live DB)"} if fast else set()
    failed = []
    for name, cmd, cwd, env in CHECKS:
        if name in fast_skip:
            print(f"[gate] SKIP (--fast): {name}")
            continue
        try:
            r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
        except FileNotFoundError as e:
            failed.append((name, f"command not found: {e}"))
            continue
        if r.returncode == 0:
            print(f"[gate] PASS: {name}")
            if name == "backend unit tests":
                m = re.search(r"Ran (\d+) tests", r.stdout + r.stderr)
                if m:
                    print(f"         suite: {m.group(1)} tests, OK")
        else:
            print(f"[gate] FAIL: {name} (exit {r.returncode})")
            tail = (r.stdout + r.stderr).strip().splitlines()[-6:]
            for line in tail:
                print(f"         {line}")
            failed.append((name, r.returncode))
    if failed:
        print("\n[gate] BLOCKED: release is not permitted while checks fail:")
        for name, code in failed:
            print(f"         - {name}: {code}")
        return 1
    print("\n[gate] ALL PASS — change may proceed to release.")
    return 0

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="E-Ticketing CI quality gate (stdlib only)")
    ap.add_argument("--fast", action="store_true", help="skip the slow DB-backed suite")
    args = ap.parse_args()
    sys.exit(run_gate(fast=args.fast))
