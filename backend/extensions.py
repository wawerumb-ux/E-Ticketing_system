"""Flask extensions and tiny shared helpers.

All extensions are created here WITHOUT a Flask app and bound later from
app.py via ``*.init_app(app)``.  Keeping them unbound is what lets models,
helpers and the route blueprints import them without a circular import with
app.py.
"""

import logging
import os
from datetime import datetime, timezone

from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_sqlalchemy import SQLAlchemy
from flask_jwt_extended import JWTManager
from authlib.integrations.flask_client import OAuth
from cryptography.fernet import Fernet

# Module-level logger used across the backend. Configured once from app.py via
# configure_logging(); every module that needs to log imports this name.
logger = logging.getLogger('ict_ticketing')

db = SQLAlchemy()
jwt = JWTManager()
limiter = Limiter(key_func=get_remote_address, default_limits=["200 per day"])
oauth = OAuth()


# ============================================================================
# TOTP SECRET ENCRYPTION
# ============================================================================

def _get_totp_encryption_key():
    """Derive a consistent encryption key from the JWT secret.
    
    Uses the JWT_SECRET_KEY environment variable to create a Fernet key.
    If not set, generates a key from a fallback secret.
    """
    import base64
    import hashlib
    
    secret = os.getenv('JWT_SECRET_KEY', os.getenv('SECRET_KEY', 'fallback-secret-key'))
    # Derive a 32-byte key from the secret using SHA-256
    derived = hashlib.sha256(secret.encode()).digest()
    # Fernet requires a 32-byte URL-safe base64-encoded key
    return base64.urlsafe_b64encode(derived)


def encrypt_totp_secret(secret):
    """Encrypt a TOTP secret for storage in the database.
    
    Returns the encrypted string, or None if encryption fails.
    """
    if not secret:
        return None
    try:
        f = Fernet(_get_totp_encryption_key())
        return f.encrypt(secret.encode()).decode()
    except Exception as exc:
        logger.error(f'Failed to encrypt TOTP secret: {exc}')
        return None


def decrypt_totp_secret(encrypted_secret):
    """Decrypt a TOTP secret from the database.
    
    Returns the decrypted string, or the original if it appears to be plaintext.
    Handles legacy unencrypted secrets transparently.
    """
    if not encrypted_secret:
        return None
    
    # Try to decrypt first
    try:
        f = Fernet(_get_totp_encryption_key())
        return f.decrypt(encrypted_secret.encode()).decode()
    except Exception:
        # Decryption failed - might be a legacy plaintext secret
        # Return as-is for backward compatibility
        return encrypted_secret


# ============================================================================

def utcnow():
    """Naive UTC timestamp safe for MySQL DATETIME columns.

    ``datetime.utcnow()`` is deprecated since Python 3.12; this returns the
    same value (naive UTC) but computed from an aware UTC now, so the API and
    the database keep the exact previous semantics.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)