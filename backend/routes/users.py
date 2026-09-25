"""User management routes (admin) and self-service profile routes."""

import json
import re

from flask import Blueprint, jsonify, request
from flask_jwt_extended import (
    create_access_token,
    create_refresh_token,
    get_jwt,
    get_jwt_identity,
    jwt_required,
)
from werkzeug.security import check_password_hash, generate_password_hash

from extensions import db, utcnow
from helpers import (
    _as_str,
    category_role,
    get_notification_registry,
    log_audit,
    notification_category_prefs,
    role_required,
    set_notification_category,
)
from models import (
    ApiToken,
    KnowledgeArticle,
    Notification,
    NotificationPreference,
    PasswordResetToken,
    Role,
    SocialAccount,
    Ticket,
    TicketAttachment,
    TicketComment,
    User,
    Webhook,
)

users_bp = Blueprint('users', __name__)

def _validate_new_username(new_username):
    """Normalise and validate a candidate username; returns (clean, error)."""
    clean = (new_username or '').strip()[:50]
    if not clean:
        return '', 'Username is required'
    if len(clean) < 2:
        return '', 'Username must be at least 2 characters'
    if not re.match(r'^[A-Za-z0-9_.][A-Za-z0-9_.-]*$', clean):
        return '', 'Username can only contain letters, numbers, dots, underscores and hyphens'
    return clean, None


def _rename_user(user, new_username):
    """Rewrite every string reference to the old username, then rename."""
    old_username = user.username
    if old_username == new_username:
        return False
    Ticket.query.filter_by(created_by=old_username).update(
        {'created_by': new_username}, synchronize_session=False)
    Ticket.query.filter_by(assigned_to=old_username).update(
        {'assigned_to': new_username}, synchronize_session=False)
    TicketComment.query.filter_by(author_username=old_username).update(
        {'author_username': new_username}, synchronize_session=False)
    KnowledgeArticle.query.filter_by(author_username=old_username).update(
        {'author_username': new_username}, synchronize_session=False)
    TicketAttachment.query.filter_by(uploaded_by=old_username).update(
        {'uploaded_by': new_username}, synchronize_session=False)
    ApiToken.query.filter_by(created_by=old_username).update(
        {'created_by': new_username}, synchronize_session=False)
    Webhook.query.filter_by(created_by=old_username).update(
        {'created_by': new_username}, synchronize_session=False)
    user.username = new_username
    return True


def _issue_tokens(user):
    """Fresh access + refresh tokens carrying the user's CURRENT identity."""
    additional_claims = {'role': user.role, 'username': user.username}
    identity = str(user.id)
    return (
        create_access_token(identity=identity, additional_claims=additional_claims),
        create_refresh_token(identity=identity, additional_claims=additional_claims),
    )


def _valid_role(role):
    """True if `role` names an active registry role. An empty registry (legacy
    DB before seeding) permits any role, so user creation never hard-fails
    before bootstrap has run."""
    if not role:
        return False
    if Role.query.count() == 0:
        return True
    return Role.query.filter_by(name=role, is_active=True).first() is not None


def _public_user(u):
    return {
        'id': u.id,
        'username': u.username,
        'email': u.email,
        'role': u.role,
        'department': u.department,
        'is_active': u.is_active,
        'phone': u.phone,
        'locked_until': u.locked_until.isoformat() if u.locked_until else None,
        'totp_enabled': u.totp_enabled,
    }


@users_bp.route('/api/users', methods=['GET'])
@role_required('admin')
def get_users():
    try:
        query = User.query

        q = (request.args.get('q') or '').strip()
        role = (request.args.get('role') or '').strip().lower()
        status = (request.args.get('status') or '').strip().lower()
        department = (request.args.get('department') or '').strip()

        if q:
            like = f'%{q}%'
            query = query.filter(
                db.or_(
                    User.username.ilike(like),
                    User.email.ilike(like),
                    User.department.ilike(like),
                )
            )

        if role:
            query = query.filter(User.role == role)

        if status == 'active':
            query = query.filter(User.is_active.is_(True))
        elif status == 'inactive':
            query = query.filter(User.is_active.is_(False))

        if department:
            query = query.filter(User.department == department)

        users = query.all()
        return jsonify([_public_user(u) for u in users]), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@users_bp.route('/api/users', methods=['POST'])
@role_required('admin')
def create_user():
    try:
        data = request.json

        existing_user = User.query.filter_by(username=data['username']).first()
        if existing_user:
            return jsonify({'error': 'Username already exists'}), 400

        if not re.match(r'^[A-Za-z0-9_.][A-Za-z0-9_.-]*$', (data['username'] or '').strip()):
            return jsonify({'error': 'Username can only contain letters, numbers, dots, underscores and hyphens'}), 400

        existing_email = User.query.filter_by(email=data['email']).first()
        if existing_email:
            return jsonify({'error': 'Email already exists'}), 400

        role = (data.get('role') or 'staff').strip().lower()
        if not _valid_role(role):
            return jsonify({'error': f"Unknown or inactive role '{role}'"}), 400

        new_user = User(
            username=data['username'],
            email=data['email'],
            password_hash=generate_password_hash(data['password']),
            role=role,
            department=data.get('department')
        )

        db.session.add(new_user)
        actor = get_jwt().get('username', 'admin')
        log_audit(actor, 'create', 'user', new_user.username,
                  f"Created user {data['username']} role={role}")
        db.session.commit()

        return jsonify({
            'message': 'User created successfully',
            'user': _public_user(new_user)
        }), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


@users_bp.route('/api/users/<int:user_id>', methods=['DELETE'])
@role_required('admin')
def delete_user(user_id):
    try:
        user = User.query.get_or_404(user_id)
        user.is_active = False
        actor = get_jwt().get('username', 'admin')
        log_audit(actor, 'deactivate', 'user', user.username, f"Deactivated user {user.username}")
        db.session.commit()
        return jsonify({'message': 'User deactivated successfully'}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


@users_bp.route('/api/users/<int:user_id>/reactivate', methods=['PUT'])
@role_required('admin')
def reactivate_user(user_id):
    try:
        user = User.query.get_or_404(user_id)
        user.is_active = True
        actor = get_jwt().get('username', 'admin')
        log_audit(actor, 'activate', 'user', user.username, f"Reactivated user {user.username}")
        db.session.commit()
        return jsonify({'message': 'User reactivated successfully'}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


@users_bp.route('/api/users/<int:user_id>/permanent', methods=['DELETE'])
@role_required('admin')
def purge_user(user_id):
    """Permanently delete a user (admin-only).

    Written exception to the soft-delete rule in AGENTS.md 1.3, approved by
    the developer: this is a deliberate, irreversible action. FK children
    (social accounts, notifications, preferences, reset tokens) are removed;
    history referencing the username as a string (tickets, comments, audit
    log) is preserved. Self-delete is refused.
    """
    try:
        user = User.query.get_or_404(user_id)
        actor = get_jwt().get('username', 'admin')
        if user.username == actor:
            return jsonify({'error': 'You cannot delete your own account.'}), 403

        username = user.username
        Notification.query.filter_by(user_id=user.id).delete(synchronize_session=False)
        NotificationPreference.query.filter_by(user_id=user.id).delete(synchronize_session=False)
        PasswordResetToken.query.filter_by(user_id=user.id).delete(synchronize_session=False)
        SocialAccount.query.filter_by(user_id=user.id).delete(synchronize_session=False)

        log_audit(actor, 'purge', 'user', username, f"Permanently deleted user {username}")
        db.session.delete(user)
        db.session.commit()
        return jsonify({'message': 'User permanently deleted'}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


@users_bp.route('/api/users/me', methods=['GET'])
@jwt_required()
def get_my_profile():
    user_id = int(get_jwt_identity())
    user = User.query.get_or_404(user_id)
    return jsonify(_public_user(user)), 200


@users_bp.route('/api/users/me/password', methods=['PUT'])
@jwt_required()
def change_my_password():
    user_id = int(get_jwt_identity())
    user = User.query.get_or_404(user_id)
    data = request.json

    current_password = data.get('current_password')
    new_password = data.get('new_password')

    if not current_password or not new_password:
        return jsonify({'error': 'Current and new password are required'}), 400

    if not check_password_hash(user.password_hash, current_password):
        return jsonify({'error': 'Current password is incorrect'}), 401

    if len(new_password) < 8:
        return jsonify({'error': 'New password must be at least 8 characters'}), 400

    user.password_hash = generate_password_hash(new_password)
    log_audit(user.username, 'change_password', 'user', user.username, "Password changed")
    db.session.commit()

    return jsonify({'message': 'Password updated successfully'}), 200


@users_bp.route('/api/users/me/username', methods=['PUT'])
@jwt_required()
def change_my_username():
    """Self-service rename. Requires the current password (mirrors the
    password-change gate) and reissues tokens with the new identity so the new
    username is recognised at login immediately."""
    data = request.json or {}
    claims = get_jwt()
    user = User.query.filter_by(username=claims.get('username')).first()
    if user is None:
        return jsonify({'error': 'User not found'}), 404

    current_pw = data.get('password') or ''
    if not check_password_hash(user.password_hash, current_pw):
        log_audit(user.username, 'rename_failed', 'user', user.username, 'wrong password')
        return jsonify({'error': 'Current password is incorrect'}), 401

    new_username, err = _validate_new_username(data.get('username'))
    if err:
        return jsonify({'error': err}), 400
    if new_username == user.username:
        return jsonify({'error': 'New username is the same as the current username'}), 400

    existing = User.query.filter(User.username == new_username, User.id != user.id).first()
    if existing:
        return jsonify({'error': 'Username already exists'}), 400

    old_username = user.username
    _rename_user(user, new_username)
    log_audit(new_username, 'rename', 'user', old_username,
              f"Username changed from '{old_username}' to '{new_username}'")
    db.session.commit()

    access_token, refresh_token = _issue_tokens(user)
    return jsonify({
        'message': 'Username updated successfully',
        'access_token': access_token,
        'refresh_token': refresh_token,
        'user': _public_user(user)
    }), 200


@users_bp.route('/api/users/me/notification-preferences', methods=['GET'])
@jwt_required()
def get_my_notification_preferences():
    user_id = int(get_jwt_identity())
    user = User.query.get_or_404(user_id)
    prefs = notification_category_prefs(user)
    permitted = _permitted_categories(user)
    registry = get_notification_registry()
    db.session.commit()
    return jsonify({
        'categories': {cid: prefs[cid] for cid in permitted},
        'registry': {cid: registry[cid] for cid in permitted},
    }), 200


@users_bp.route('/api/users/me/notification-preferences', methods=['PUT'])
@jwt_required()
def update_my_notification_preferences():
    user_id = int(get_jwt_identity())
    user = User.query.get_or_404(user_id)
    data = request.json or {}
    category = data.get('category')
    enabled = data.get('enabled')

    if category not in get_notification_registry():
        return jsonify({'error': 'Unknown notification category'}), 400
    if not isinstance(enabled, bool):
        return jsonify({'error': 'enabled must be a boolean'}), 400
    if category not in _permitted_categories(user):
        return jsonify({'error': 'category_not_permitted', 'category': category}), 403

    set_notification_category(user, category, enabled)
    log_audit(user.username, 'update', 'notification_preference', category,
              f"category={category} enabled={enabled}")
    db.session.commit()

    prefs = notification_category_prefs(user)
    permitted = _permitted_categories(user)
    return jsonify({'categories': {cid: prefs[cid] for cid in permitted}}), 200


def _permitted_categories(user):
    role = (user.role or 'staff').lower()
    registry = get_notification_registry()
    return [cid for cid, meta in registry.items()
            if category_role(cid) == 'shared' or role == 'admin']


@users_bp.route('/api/users/<int:user_id>', methods=['PUT'])
@role_required('admin')
def update_user(user_id):
    user = User.query.get_or_404(user_id)
    data = request.json

    old_email, old_role, old_dept = user.email, user.role, user.department

    new_email = data.get('email')
    if new_email and new_email != user.email:
        existing_email = User.query.filter_by(email=new_email).first()
        if existing_email:
            return jsonify({'error': 'Email already in use'}), 400
        user.email = new_email

    if 'role' in data:
        role = (data['role'] or '').strip().lower()
        if not _valid_role(role):
            return jsonify({'error': f"Unknown or inactive role '{data['role']}'"}), 400
        user.role = role
    if 'department' in data:
        user.department = data['department']

    claims = get_jwt()
    actor = claims.get('username', 'admin') or 'admin'
    renamed_self = False
    diff = {}

    if 'username' in data:
        new_username, err = _validate_new_username(data['username'])
        if err:
            return jsonify({'error': err}), 400
        if new_username != user.username:
            existing = User.query.filter(
                User.username == new_username, User.id != user.id).first()
            if existing:
                return jsonify({'error': 'Username already exists'}), 400
            old_username = user.username
            _rename_user(user, new_username)
            diff['username'] = {'from': _as_str(old_username), 'to': _as_str(user.username)}
            if actor == old_username:
                renamed_self = True
                actor = new_username

    if old_email != user.email:
        diff['email'] = {'from': _as_str(old_email), 'to': _as_str(user.email)}
    if old_role != user.role:
        diff['role'] = {'from': _as_str(old_role), 'to': _as_str(user.role)}
    if old_dept != user.department:
        diff['department'] = {'from': _as_str(old_dept), 'to': _as_str(user.department)}
    log_audit(actor, 'update', 'user', user.username, json.dumps(diff) if diff else None)

    db.session.commit()

    payload = {'message': 'User updated successfully', 'user': _public_user(user)}
    if renamed_self:
        access_token, refresh_token = _issue_tokens(user)
        payload['access_token'] = access_token
        payload['refresh_token'] = refresh_token
    return jsonify(payload), 200


@users_bp.route('/api/users/<int:user_id>/link-phone', methods=['POST'])
@role_required('admin')
def link_user_phone(user_id):
    user = User.query.get_or_404(user_id)
    data = request.get_json(silent=True) or {}
    phone = (str(data.get('phone') or '')).strip()[:20] or None

    if phone is not None:
        dup = User.query.filter(User.phone == phone, User.id != user.id).first()
        if dup:
            return jsonify({'error': f'Phone already linked to @{dup.username}'}), 409

    old_phone = user.phone
    user.phone = phone
    actor = get_jwt().get('username', 'admin')
    log_audit(actor, 'update', 'user', user.username,
              json.dumps({'phone': {'from': _as_str(old_phone), 'to': _as_str(phone)}}) if old_phone != phone else None)
    db.session.commit()

    return jsonify({
        'message': 'Phone linked to account' if phone else 'Phone unlinked from account',
        'phone': user.phone,
    }), 200


@users_bp.route('/api/users/<int:user_id>/reset-2fa', methods=['POST'])
@role_required('admin')
def admin_reset_2fa(user_id):
    user = User.query.get_or_404(user_id)
    user.totp_secret = None
    user.totp_enabled = False
    log_audit(get_jwt().get('username', 'admin'), '2fa_reset', 'user', user.username)
    db.session.commit()
    return jsonify({'message': f"Two-factor authentication cleared for {user.username}"}), 200
