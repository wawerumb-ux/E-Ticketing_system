#!/bin/bash
set -e

echo "=== ICT Ticketing System — Database Initialization ==="

python << 'PYEOF'
from app import app, bootstrap_database, _print_startup_banner

with app.app_context():
    bootstrap_database()
    print("✓ Database initialization complete")

_print_startup_banner(8000)
PYEOF

echo "=== Starting Gunicorn ==="
exec gunicorn \
    --bind 0.0.0.0:8000 \
    --workers "${GUNICORN_WORKERS:-4}" \
    --timeout 120 \
    --access-logfile - \
    --error-logfile - \
    app:app
