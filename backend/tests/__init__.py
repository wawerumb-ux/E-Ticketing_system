"""Test package. The suite imports app.py directly (this is exactly the
from-app import surface that docker-entrypoint and alembic also depend on)."""

import warnings

# Flask-SQLAlchemy 3.x still emits these from query.get() throughout the app.
warnings.filterwarnings('ignore', message='The Query.get\\(\\).*')
warnings.filterwarnings('ignore', message='.*Using the in-memory storage for tracking rate limits')