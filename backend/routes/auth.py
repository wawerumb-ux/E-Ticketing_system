"""Authentication routes: login, registration, 2FA, password reset, refresh
and social OAuth login."""

import hashlib
import os
import re
import secrets
from datetime import timedelta

from flask import Blueprint, jsonify, redirect, request, session
from flask_jwt_extended import (
    create_access_token,
    create_refresh_token,
    decode_token,
    get_jwt,
    get_jwt_identity,
    jwt_required,
)
from werkzeug.security import check_password_hash, generate_password_hash

from extensions import db, limiter, utcnow
from models import PasswordResetToken, SocialAccount, User
from helpers import log_audit, render_email_html, send_email, get_setting, verify_turnstile
from totp import generate_secret as totp_generate_secret, verify as totp_verify, otpauth_uri as totp_uri

auth_bp = Blueprint('auth', __name__)


def get_public_base_url():
    """Best guess of the publicly reachable base URL for OAuth redirects."""
    return os.getenv('OAUTH_REDIRECT_URI', 'http://localhost:5000').rstrip('/')


# ============ STANDARD LOGIN / REGISTER / REFRESH ============

@auth_bp.route('/api/auth/login', methods=['POST'])
@limiter.limit("5 per minute")
def login():
    data = request.json
    if not verify_turnstile((data or {}).get('turnstile_token') or '', request.remote_addr):
        return jsonify({'error': 'turnstile_failed',
                        'message': 'Verification failed. Please try again.'}), 403
    username = data.get('username')
    password = data.get('password')

    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400

    user = User.query.filter_by(username=username).first()

    if not user:
        log_audit(username, 'login_failed', 'auth', None, 'unknown username')
        db.session.commit()
        return jsonify({'error': 'Invalid username or password'}), 401

    if user.locked_until and user.locked_until > utcnow():
        remaining = int((user.locked_until - utcnow()).total_seconds() / 60) + 1
        log_audit(user.username, 'login_blocked', 'auth', user.username, 'account locked')
        db.session.commit()
        return jsonify({'error': f'Account temporarily locked due to repeated failed attempts. Try again in {remaining} minute(s).'}), 403

    if not check_password_hash(user.password_hash, password):
        user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
        if user.failed_login_attempts >= 5:
            user.locked_until = utcnow() + timedelta(minutes=15)
            user.failed_login_attempts = 0
        log_audit(user.username, 'login_failed', 'auth', user.username, 'wrong password')
        db.session.commit()
        return jsonify({'error': 'Invalid username or password'}), 401

    if not user.is_active:
        log_audit(user.username, 'login_blocked', 'auth', user.username, 'inactive account')
        db.session.commit()
        return jsonify({'error': 'This account has been deactivated. Contact an administrator.'}), 403

    user.failed_login_attempts = 0
    user.locked_until = None
    log_audit(user.username, 'login', 'auth', user.username)
    db.session.commit()

    if user.totp_enabled:
        pending = create_access_token(
            identity=str(user.id),
            additional_claims={'role': user.role, 'username': user.username, 'purpose': '2fa'},
            expires_delta=timedelta(minutes=5),
        )
        return jsonify({'needs_2fa': True, 'pending_token': pending,
                        'user': {'id': user.id, 'username': user.username, 'role': user.role}}), 200

    identity = str(user.id)
    additional_claims = {'role': user.role, 'username': user.username}

    access_token = create_access_token(identity=identity, additional_claims=additional_claims)
    refresh_token = create_refresh_token(identity=identity, additional_claims=additional_claims)

    return jsonify({
        'access_token': access_token,
        'refresh_token': refresh_token,
        'user': {'id': user.id, 'username': user.username, 'role': user.role}
    }), 200


@auth_bp.route('/api/auth/verify-2fa', methods=['POST'])
@limiter.limit("10 per minute")
def verify_2fa():
    data = request.json or {}
    pending = data.get('pending_token')
    code = (data.get('code') or '').strip()
    if not pending or not code:
        return jsonify({'error': 'pending_token and code are required'}), 400
    try:
        claims = decode_token(pending)
    except Exception:
        return jsonify({'error': 'Invalid or expired pending token. Sign in again.'}), 401
    if claims.get('purpose') != '2fa':
        return jsonify({'error': 'Invalid token purpose'}), 401

    user_id = claims.get('sub')
    user = User.query.get(int(user_id))
    if user is None or not user.is_active or not user.totp_enabled or not user.totp_secret:
        return jsonify({'error': 'Two-factor authentication is not configured for this account'}), 403

    if not totp_verify(user.totp_secret, code):
        log_audit(user.username, 'login_failed', 'auth', user.username, 'invalid 2FA code')
        db.session.commit()
        return jsonify({'error': 'Invalid verification code'}), 401

    log_audit(user.username, 'login_2fa', 'auth', user.username)
    db.session.commit()
    additional_claims = {'role': user.role, 'username': user.username}
    access_token = create_access_token(identity=str(user.id), additional_claims=additional_claims)
    refresh_token = create_refresh_token(identity=str(user.id), additional_claims=additional_claims)
    return jsonify({'access_token': access_token, 'refresh_token': refresh_token,
                    'user': {'id': user.id, 'username': user.username, 'role': user.role}}), 200


@auth_bp.route('/api/auth/register', methods=['POST'])
@limiter.limit("3 per minute")
def register():
    data = request.json or {}
    username = (data.get('username') or '').strip()
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''
    name = (data.get('name') or '').strip()

    if not username or not email or not password:
        return jsonify({'error': 'Username, email and password are required'}), 400

    if len(username) < 2:
        return jsonify({'error': 'Username must be at least 2 characters'}), 400

    if not re.match(r'^[A-Za-z0-9_.][A-Za-z0-9_.-]*$', username):
        return jsonify({'error': 'Username can only contain letters, numbers, dots, underscores and hyphens'}), 400

    if not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', email):
        return jsonify({'error': 'Invalid email address'}), 400

    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400

    if User.query.filter_by(username=username).first():
        return jsonify({'error': 'Username already exists'}), 400

    if User.query.filter_by(email=email).first():
        return jsonify({'error': 'Email already exists'}), 400

    new_user = User(
        username=username[:50],
        email=email,
        password_hash=generate_password_hash(password),
        role='staff',
        department=data.get('department')
    )
    db.session.add(new_user)
    db.session.commit()

    return jsonify({
        'message': 'Account created successfully. You can now sign in.',
        'user': {'id': new_user.id, 'username': new_user.username, 'email': new_user.email, 'role': new_user.role}
    }), 201


@auth_bp.route('/api/auth/refresh', methods=['POST'])
@jwt_required(refresh=True)
def refresh():
    identity = get_jwt_identity()
    try:
        uid = int(identity)
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid session'}), 401
    user = User.query.get(uid)
    # Re-read the user from the DB so a renamed (or deactivated) account always
    # gets a token that carries the CURRENT username/role, not stale claims.
    if user is None or not user.is_active:
        return jsonify({'error': 'Invalid session'}), 401
    new_access_token = create_access_token(
        identity=str(user.id),
        additional_claims={'role': user.role, 'username': user.username}
    )
    return jsonify({'access_token': new_access_token}), 200


# ============ TWO-FACTOR AUTHENTICATION ============

@auth_bp.route('/api/auth/2fa', methods=['GET'])
@jwt_required()
def get_2fa_status():
    user = User.query.filter_by(username=get_jwt().get('username')).first()
    if user is None:
        return jsonify({'error': 'User not found'}), 404
    return jsonify({'enabled': bool(user.totp_enabled)}), 200


@auth_bp.route('/api/auth/2fa/setup', methods=['POST'])
@jwt_required()
def setup_2fa():
    user = User.query.filter_by(username=get_jwt().get('username')).first()
    if user is None:
        return jsonify({'error': 'User not found'}), 404
    secret = totp_generate_secret()
    user.totp_secret = secret
    user.totp_enabled = False
    db.session.commit()
    return jsonify({
        'secret': secret,
        'otpauth_uri': totp_uri(secret, user.username),
        'enabled': False,
    }), 200


@auth_bp.route('/api/auth/2fa/setup/verify', methods=['POST'])
@jwt_required()
def verify_2fa_setup():
    user = User.query.filter_by(username=get_jwt().get('username')).first()
    if user is None:
        return jsonify({'error': 'User not found'}), 404
    if not user.totp_secret:
        return jsonify({'error': 'Run setup first'}), 400
    code = (request.json or {}).get('code', '')
    if not totp_verify(user.totp_secret, code):
        return jsonify({'error': 'Invalid verification code'}), 401
    user.totp_enabled = True
    log_audit(user.username, '2fa_enabled', 'user', user.username)
    db.session.commit()
    return jsonify({'enabled': True}), 200


@auth_bp.route('/api/auth/2fa/disable', methods=['POST'])
@jwt_required()
def disable_2fa():
    user = User.query.filter_by(username=get_jwt().get('username')).first()
    if user is None:
        return jsonify({'error': 'User not found'}), 404
    if not user.totp_enabled:
        return jsonify({'enabled': False}), 200
    code = (request.json or {}).get('code', '')
    if not totp_verify(user.totp_secret, code):
        return jsonify({'error': 'Invalid verification code'}), 401
    user.totp_secret = None
    user.totp_enabled = False
    log_audit(user.username, '2fa_disabled', 'user', user.username)
    db.session.commit()
    return jsonify({'enabled': False}), 200


# ============ PASSWORD RESET ============

@auth_bp.route('/api/auth/forgot-password', methods=['POST'])
@limiter.limit("3 per hour")
def forgot_password():
    data = request.json or {}
    email = (data.get('email') or '').strip().lower()
    if not email:
        return jsonify({'error': 'Email is required'}), 400

    user = User.query.filter_by(email=email).first()

    # Identical answer whether or not the account exists — no user enumeration.
    if user and user.is_active:
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        reset = PasswordResetToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=utcnow() + timedelta(hours=1)
        )
        db.session.add(reset)
        log_audit('system', 'password_reset_requested', 'user', user.username)
        db.session.commit()

        base = os.getenv('PUBLIC_URL', 'http://localhost:5000').rstrip('/')
        link = f"{base}/reset-password?token={token}"
        send_email(
            user.email,
            "Password reset requested",
            (f"Hello {user.username},\n\n"
             f"We received a request to reset your password. Open the link below to choose a new one "
             f"(valid for 1 hour):\n\n{link}\n\n"
             f"If you didn't request this, you can safely ignore this email.")
        )
    else:
        log_audit(email, 'password_reset_requested', 'auth', None, 'no matching account')
        db.session.commit()

    return jsonify({
        'message': 'If an account exists with that email, a password reset link has been sent.'
    }), 200


@auth_bp.route('/api/auth/reset-password', methods=['POST'])
@limiter.limit("5 per hour")
def reset_password():
    data = request.json or {}
    if not verify_turnstile((data.get('turnstile_token') or ''), request.remote_addr):
        return jsonify({'error': 'turnstile_failed',
                        'message': 'Verification failed. Please try again.'}), 403
    token = (data.get('token') or '').strip()
    new_password = data.get('password') or ''

    if not token:
        return jsonify({'error': 'Reset token is required'}), 400
    if len(new_password) < 8:
        return jsonify({'error': 'New password must be at least 8 characters'}), 400

    token_hash = hashlib.sha256(token.encode()).hexdigest()
    reset = PasswordResetToken.query.filter_by(token_hash=token_hash).first()

    if not reset or reset.used:
        return jsonify({'error': 'This reset link is invalid or has already been used.'}), 400
    if reset.expires_at < utcnow():
        return jsonify({'error': 'This reset link has expired. Please request a new one.'}), 400

    user = User.query.get(reset.user_id)
    if not user or not user.is_active:
        return jsonify({'error': 'This account is no longer active.'}), 403

    user.password_hash = generate_password_hash(new_password)
    user.failed_login_attempts = 0
    user.locked_until = None
    reset.used = True
    log_audit('system', 'password_reset', 'user', user.username)
    db.session.commit()

    send_email(
        user.email,
        "Password reset successful",
        f"Hello {user.username},\n\nYour password has been reset. You can now sign in with your new password."
    )

    return jsonify({'message': 'Your password has been reset. You can now sign in.'}), 200


# ============ SOCIAL (OAUTH) LOGIN ============

def _resolve_social_user(provider, provider_user_id, email, name):
    email = (email or '').strip().lower() or None
    name = (name or '').strip()

    link = SocialAccount.query.filter_by(provider=provider, provider_user_id=str(provider_user_id)).first()
    if link:
        return link.user

    if email:
        existing = User.query.filter_by(email=email).first()
        if existing:
            db.session.add(SocialAccount(user_id=existing.id, provider=provider, provider_user_id=str(provider_user_id)))
            db.session.commit()
            return existing

    if name:
        existing = User.query.filter_by(username=name.lower().replace(' ', '_')).first()
        if existing:
            db.session.add(SocialAccount(user_id=existing.id, provider=provider, provider_user_id=str(provider_user_id)))
            db.session.commit()
            return existing

    base_username = re.sub(r'[^a-z0-9_.-]', '_', (name or email or provider).lower().replace(' ', '_'))
    base_username = re.sub(r'_+', '_', base_username).strip('._-')
    if not base_username:
        base_username = f'{provider}_user'
    username = base_username
    attempt = 1
    while User.query.filter_by(username=username).first():
        username = f'{base_username}_{attempt}'
        attempt += 1

    new_user = User(
        username=username[:50],
        email=email or f'{provider}_{provider_user_id}@social.local',
        password_hash=generate_password_hash(secrets.token_urlsafe(24)),
        role='staff'
    )
    db.session.add(new_user)
    db.session.flush()
    db.session.add(SocialAccount(user_id=new_user.id, provider=provider, provider_user_id=str(provider_user_id)))
    db.session.commit()
    return new_user


def _finish_social_login(user):
    identity = str(user.id)
    claims = {'role': user.role, 'username': user.username}
    access_token = create_access_token(identity=identity, additional_claims=claims)
    refresh_token = create_refresh_token(identity=identity, additional_claims=claims)
    target = session.pop('oauth_redirect', None) or ('/admin' if user.role == 'admin' else '/user')
    if not target.startswith('/'):
        target = '/user'
    return redirect(f'/login#access_token={access_token}&refresh_token={refresh_token}&redirect={target}')


@auth_bp.route('/api/auth/<provider>/login', methods=['GET'])
def social_login(provider):
    if provider not in ('google', 'facebook', 'instagram'):
        return jsonify({'error': 'Unsupported provider'}), 400
    if not oauth.create_client(provider).client_id:
        return jsonify({'error': f'{provider} OAuth is not configured. Set the credentials in .env'}), 501
    session['oauth_redirect'] = request.args.get('redirect', '/user')
    base = get_public_base_url()
    return oauth.create_client(provider).authorize_redirect(redirect_uri=f'{base}/api/auth/{provider}/callback')


@auth_bp.route('/api/auth/<provider>/callback', methods=['GET'])
def social_callback(provider):
    if provider not in ('google', 'facebook', 'instagram'):
        return redirect('/login?social_error=unsupported_provider')

    from extensions import logger
    try:
        client = oauth.create_client(provider)
        token = client.authorize_access_token()

        if provider == 'google':
            resp = client.get('https://www.googleapis.com/oauth2/v3/userinfo')
            info = resp.json()
            provider_id = info.get('sub')
            email = info.get('email')
            name = info.get('name')
        elif provider == 'facebook':
            resp = client.get('https://graph.facebook.com/v19.0/me?fields=id,name,email')
            info = resp.json()
            provider_id = info.get('id')
            email = info.get('email')
            name = info.get('name')
        else:  # instagram (via Facebook Login, Instagram product)
            provider_id = token.get('user_id') or (token.get('instagram_user_id') if isinstance(token, dict) else None)
            resp = client.get('https://graph.facebook.com/v19.0/me?fields=id,name,email')
            info = resp.json()
            provider_id = provider_id or info.get('id')
            email = info.get('email')
            name = info.get('name')

        if not provider_id:
            return redirect('/login?social_error=no_profile')

        user = _resolve_social_user(provider, provider_id, email, name)
        if not user.is_active:
            return redirect('/login?social_error=deactivated')

        return _finish_social_login(user)

    except Exception as exc:
        logger.warning(f'OAuth callback failed ({provider}): {exc}')
        return redirect('/login?social_error=callback_failed')
