#!/usr/bin/env python
"""
check-schema-drift.py — schema drift checker (E3 / W1)

Compares the live MySQL schema against the SQLAlchemy models and prints
the exact migration statements required to close the gap:

  - missing tables        -> CREATE TABLE ...
  - missing columns       -> ALTER TABLE <t> ADD COLUMN ...
  - nullability / type    -> ALTER TABLE <t> MODIFY COLUMN ...
  - new unique constraints-> ALTER TABLE <t> ADD UNIQUE ...

It NEVER modifies anything. It is a read-only report. The ALTER TABLE
statements are intended as input to the manual-migration workflow
(AGENTS.md E3): review, run against MySQL, then record in Alembic.

Usage:
    backend/venv313/bin/python scripts/check-schema-drift.py [--include-tables T1,T2]

Exit codes:
    0 = no drift / all clear
    1 = drift found (statements printed)
    2 = could not connect / import error
"""
import argparse
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

# Ensure backend/.env is loaded even when cwd != backend (same env the
# live server reads: SECRET_KEY, DATABASE_URL, etc).
from dotenv import load_dotenv  # noqa: E402

load_dotenv(BACKEND / ".env")

# Import app so load_dotenv() + model registration happen exactly as the
# live server does; the DB URI then matches production.
try:
    import app as app_module  # noqa: F401
    from app import app, db
    from models import db as models_db
except Exception as exc:  # pragma: no cover - import/connect failure
    print(f"FATAL: could not import app (is MySQL up, is .env valid?): {exc}")
    sys.exit(2)

from sqlalchemy import inspect  # noqa: E402
from sqlalchemy.engine.reflection import Inspector  # noqa: E402


def compile_type(col):
    """DDL type for a model column as MySQL would render it."""
    try:
        return str(col.type.compile(dialect=db.engine.dialect))
    except Exception:
        return str(col.type)


def types_equivalent(model_col, live_type):
    """True if the model column type and the reflected live type are the same.

    MySQL stores BOOLEAN as TINYINT(1); BOOLEAN vs TINYINT is therefore NOT
    drift. Type names are compared case-insensitively because reflection
    returns dialect-native names.
    """
    want = compile_type(model_col).lower()
    live = str(live_type).lower()
    if want in ("boolean", "bool") and "tinyint" in live:
        return True
    if live in ("boolean", "bool") and "tinyint" in want:
        return True
    return want in live or live in want


def is_unique(col, table_name, inspector):
    """True if the column is covered by a unique index or the PK."""
    try:
        for ix in inspector.get_indexes(table_name):
            if ix.get("unique") and col.name in ix["column_names"]:
                return True
        pk = inspector.get_pk_constraint(table_name)
        return col.primary_key or (col.name in (pk.get("constrained_columns") or []))
    except Exception:
        return col.unique or col.primary_key


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--include-tables", default="",
                        help="comma-separated table names to restrict the check to")
    args = parser.parse_args()

    include = {t.strip() for t in args.include_tables.split(",") if t.strip()}

    uri = app.config["SQLALCHEMY_DATABASE_URI"]
    dialect = uri.split(":", 1)[0]
    print(f"Using database: {uri}")
    if dialect not in ("mysql", "postgresql"):
        print("WARN: only MySQL/Postgres dialect comparison is meaningful; "
              "continuing with whatever reflection reports.")
    inspector = None
    try:
        with app.app_context():
            db.engine.connect()
            inspector = inspect(db.engine)
    except Exception as exc:
        print(f"FATAL: cannot connect to database: {exc}")
        sys.exit(2)

    live_tables = set(inspector.get_table_names())
    model_tables = {t.name for t in models_db.metadata.sorted_tables}

    if include:
        live_tables &= include
        model_tables &= include

    statements = []

    # ---- 1. missing tables ------------------------------------------------
    missing_tables = sorted(model_tables - live_tables)
    for tname in missing_tables:
        table = models_db.metadata.tables[tname]
        stmts = []
        for col in table.columns:
            extra = ""
            if col.primary_key:
                extra = " PRIMARY KEY"
            elif col.unique:
                extra = " UNIQUE"
            stmts.append(
                f"    {col.name} {compile_type(col)}"
                f"{' NOT NULL' if not col.nullable else ''}{extra}"
            )
        statements.append(
            f"-- TABLE MISSING (new installs get this via db.create_all / Alembic):\n"
            f"CREATE TABLE `{tname}` (\n" + ",\n".join(stmts) + "\n);"
        )

    # ---- 2. per-table column drift -----------------------------------------
    present = sorted(live_tables & model_tables)
    for tname in present:
        model_cols = {c.name: c for c in models_db.metadata.tables[tname].columns}
        live_cols = {c["name"]: c for c in inspector.get_columns(tname)}

        for name in sorted(model_cols.keys() - live_cols.keys()):
            col = model_cols[name]
            extra = ""
            if col.unique:
                extra = " UNIQUE"
            elif is_unique(col, tname, inspector):
                pass
            statements.append(
                f"ALTER TABLE `{tname}` ADD COLUMN `{name}` "
                f"{compile_type(col)}{' NOT NULL' if not col.nullable else ''}{extra};"
            )

        for name in sorted(live_cols.keys() & model_cols.keys()):
            col = model_cols[name]
            live = live_cols[name]
            if not types_equivalent(col, live["type"]):
                statements.append(
                    f"-- TYPE DIFF on `{tname}.{name}`: model says {compile_type(col)}, "
                    f"live DB says {str(live['type'])}"
                )
            if col.nullable is False and bool(live.get("nullable")) is True:
                statements.append(
                    f"ALTER TABLE `{tname}` MODIFY COLUMN `{name}` "
                    f"{compile_type(col)} NOT NULL;"
                )

    # ---- report ------------------------------------------------------------
    if not statements:
        print("No schema drift detected — models match the live database.")
        return 0

    print(f"\n{len(statements)} drift item(s) found. Statements are READ-ONLY output:")
    print("-" * 60)
    for s in statements:
        print(s)
    print("-" * 60)
    print("Review each statement, apply manually (E3 manual-migration rule), ")
    print("then record it as an Alembic revision:")
    print("    cd backend && venv313/bin/alembic revision --autogenerate -m '<change>'")
    return 1


if __name__ == "__main__":
    sys.exit(main())