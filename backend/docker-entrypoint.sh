#!/bin/bash
set -e

echo "=== ICT Ticketing System — Database Initialization ==="

python << 'PYEOF'
from app import app, bootstrap_database, _print_startup_banner
from helpers import verify_upload_storage

with app.app_context():
    bootstrap_database()
    print("✓ Database initialization complete")

# Attachments are the only state a redeploy destroys unless a volume is
# mounted at UPLOAD_FOLDER, and a volume mounted with the wrong ownership
# fails at upload time rather than at boot. Report it here instead.
storage_ok, storage_message = verify_upload_storage(app.config['UPLOAD_FOLDER'])
print(("✓ " if storage_ok else "✗ WARNING: ") + storage_message)

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
