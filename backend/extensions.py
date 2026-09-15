"""Flask extensions and tiny shared helpers.

All extensions are created here WITHOUT a Flask app and bound later from
app.py via ``*.init_app(app)``.  Keeping them unbound is what lets models,
helpers and the route blueprints import them without a circular import with
app.py.
"""

import logging
from datetime import datetime, timezone

from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_sqlalchemy import SQLAlchemy
from flask_jwt_extended import JWTManager
from authlib.integrations.flask_client import OAuth

# Module-level logger used across the backend. Configured once from app.py via
# configure_logging(); every module that needs to log imports this name.
logger = logging.getLogger('ict_ticketing')

db = SQLAlchemy()
jwt = JWTManager()
limiter = Limiter(key_func=get_remote_address, default_limits=["200 per day"])
oauth = OAuth()


def utcnow():
    """Naive UTC timestamp safe for MySQL DATETIME columns.

    ``datetime.utcnow()`` is deprecated since Python 3.12; this returns the
    same value (naive UTC) but computed from an aware UTC now, so the API and
    the database keep the exact previous semantics.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)