"""User management routes (admin) and self-service profile routes."""

import json
import os
import re
from uuid import uuid4

from flask import Blueprint, current_app, jsonify, request, send_from_directory
from flask_jwt_extended import (
    create_access_token,
    create_refresh_token,
    decode_token,
    get_jwt,
    get_jwt_identity,
    jwt_required,
)
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

from extensions import db, logger, utcnow
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
        'display_name': u.display_name or None,
        'locked_until': u.locked_until.isoformat() if u.locked_until else None,
        'totp_enabled': u.totp_enabled,
        # null when the user has no photo, which is the signal for the client
        # to draw an emoji or a monogram instead. The stored filename is never
        # exposed.
        'avatar_url': f'/api/users/{u.id}/avatar' if u.avatar_filename else None,
        # Precedence is photo, then emoji, then the username monogram.
        'avatar_emoji': u.avatar_emoji or None,
    }


AVATAR_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.webp'}


def _avatar_dir():
    return os.path.join(current_app.config['UPLOAD_FOLDER'], 'avatars')


def _avatar_access_denied(user_id):
    """Admins may manage anyone's photo; everyone else only their own."""
    claims = get_jwt()
    if claims.get('role') == 'admin':
        return False
    try:
        return int(get_jwt_identity()) != int(user_id)
    except (TypeError, ValueError):
        return True


def _sniff_image_ext(head):
    """Canonical extension for a recognised image header, else None.

    The stored extension comes from these bytes rather than from the
    client-supplied filename, so the Content-Type we later serve always
    matches the actual file, and a caller that sends no filename at all
    (e.g. a FormData Blob, which arrives as "blob") still works.
    """
    if head.startswith(b'\x89PNG\r\n\x1a\n'):
        return '.png'
    if head.startswith(b'\xff\xd8\xff'):
        return '.jpg'
    if head.startswith((b'GIF87a', b'GIF89a')):
        return '.gif'
    if len(head) >= 12 and head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        return '.webp'
    return None


def _discard_avatar_file(stored):
    if not stored:
        return
    try:
        os.remove(os.path.join(_avatar_dir(), stored))
    except OSError:
        # A photo file we cannot delete is untidy but not dangerous, and the
        # database reference is already gone by the time this runs.
        logger.warning(f'Could not remove old avatar file {stored!r}')


# Code point ranges that hold pictographic emoji. This is a whitelist, not a
# blacklist: anything outside it (ASCII text, markup, control characters,
# right-to-left overrides) is refused, so the stored value can only ever be
# an emoji or a short emoji sequence such as a flag or a family.
_EMOJI_RANGES = (
    (0x00A9, 0x00A9), (0x00AE, 0x00AE),
    (0x203C, 0x3299), (0x1F000, 0x1FAFF),
    (0x1F1E6, 0x1F1FF),                      # regional indicators -> flags
    (0xFE0F, 0xFE0F),                        # variation selector-16
    (0x200D, 0x200D),                        # zero-width joiner -> ZWJ sequences
    (0x1F3FB, 0x1F3FF),                      # skin-tone modifiers
    (0x20E3, 0x20E3),                        # combining enclosing keycap
)


# Never emoji, and usable to disguise one: the zero-width and bidirectional
# formatting characters that make a stored string render differently from its
# stored value. U+200D is deliberately absent from this list, because it is
# the joiner inside sequences such as the technologist emoji.
_EMOJI_FORBIDDEN = frozenset(
    [0x200B, 0x200C, 0x200E, 0x200F, 0xFEFF]
    + list(range(0x202A, 0x202F))   # bidi embedding, override and pop
    + list(range(0x2066, 0x206A))   # bidi isolates
)

# An ASCII digit, hash or star counts as a pictograph only as the head of a
# keycap sequence, so the enclosing keycap mark has to be present too. A bare
# digit stays text and is refused.
_KEYCAP_HEADS = frozenset('0123456789#*')

# Eight code points is the most a real sequence needs (a four-person ZWJ family),
# and it fits the column with room to spare.
_EMOJI_MAX_CHARS = 8


def _normalise_emoji(value):
    """Return a safe emoji string, or None if the input is not one.

    Rejects rather than sanitises: a value not made up entirely of emoji code
    points is refused outright, so nothing downstream has to trust its
    contents.
    """
    text = str(value or '').strip()
    if not text or len(text) > _EMOJI_MAX_CHARS:
        return None
    keycap = '\u20e3' in text
    for ch in text:
        cp = ord(ch)
        if cp in _EMOJI_FORBIDDEN or 0xD800 <= cp <= 0xDFFF:
            return None
        if ch in _KEYCAP_HEADS:
            if not keycap:
                return None
            continue
        if cp < 0x80:
            return None
        if not any(lo <= cp <= hi for lo, hi in _EMOJI_RANGES):
            return None
    return text


def _clear_avatar_artifacts(user, keep_photo):
    """Apply the photo/emoji exclusivity rule and return the photo file to
    delete, if any. Clearing a reference never happens before the new one is
    written, so a failed request cannot leave a user with no avatar at all."""
    old_photo = user.avatar_filename if not keep_photo else None
    if not keep_photo:
        user.avatar_filename = None
    return old_photo


@users_bp.route('/api/users/<int:user_id>/avatar', methods=['POST'])
@jwt_required()
def upload_avatar(user_id):
    if _avatar_access_denied(user_id):
        return jsonify({'error': 'Insufficient permissions'}), 403

    user = db.session.get(User, user_id)
    if user is None:
        return jsonify({'error': 'User not found'}), 404
    if user.is_active is False:
        return jsonify({'error': 'Cannot set a photo on a deactivated user'}), 400

    asset = request.files.get('file')
    if not asset or not asset.filename:
        return jsonify({'error': 'No file provided'}), 400

    # A supplied extension is still checked, so an obviously wrong upload is
    # rejected with a clear message, but it is not what decides the format.
    ext = os.path.splitext(secure_filename(asset.filename))[1].lower()
    if ext and ext not in AVATAR_EXTENSIONS:
        return jsonify({
            'error': f'Image type "{ext}" is not allowed. '
                     'Use PNG, JPEG, GIF or WebP.'
        }), 400

    head = asset.stream.read(16)
    asset.stream.seek(0)
    sniffed = _sniff_image_ext(head or b'')
    if not sniffed:
        return jsonify({'error': 'That file is not a PNG, JPEG, GIF or WebP image.'}), 400
    ext = sniffed

    directory = _avatar_dir()
    try:
        os.makedirs(directory, exist_ok=True)
    except OSError as exc:
        logger.error(f'Could not create avatar directory {directory!r}: {exc}')
        return jsonify({
            'error': 'The server could not prepare its photo storage. '
                     'This is usually a missing or read-only uploads volume.'
        }), 507

    stored = f'{user_id}-{uuid4().hex}{ext}'
    dest = os.path.join(directory, stored)
    try:
        asset.save(dest)
    except OSError as exc:
        logger.error(f'Avatar upload failed for user {user_id} -> {dest}: {exc}')
        return jsonify({
            'error': 'The photo could not be saved. The server may be out of '
                     'disk space, or the uploads directory is not writable.'
        }), 507

    previous = user.avatar_filename
    user.avatar_filename = stored
    # A photo and an emoji are alternative ways to fill the same disc, so
    # choosing a photo retires the emoji.
    user.avatar_emoji = None
    try:
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        # Roll the file back too, so a failed write leaves nothing orphaned.
        _discard_avatar_file(stored)
        logger.error(f'Could not store avatar reference for user {user_id}: {exc}')
        return jsonify({'error': 'The photo reference could not be saved.'}), 500

    if previous and previous != stored:
        _discard_avatar_file(previous)
    return jsonify(_public_user(user)), 200


@users_bp.route('/api/users/<int:user_id>/avatar/emoji', methods=['PUT'])
@jwt_required()
def set_avatar_emoji(user_id):
    """Choose an emoji for the user, for anyone who has no photo to upload."""
    if _avatar_access_denied(user_id):
        return jsonify({'error': 'Insufficient permissions'}), 403

    user = db.session.get(User, user_id)
    if user is None:
        return jsonify({'error': 'User not found'}), 404

    payload = request.get_json(silent=True) or {}
    emoji = _normalise_emoji(payload.get('emoji'))
    if not emoji:
        return jsonify({
            'error': 'That is not a single emoji. Pick one character, such as '
                     'a face, an animal or a symbol.'
        }), 400

    # Choosing an emoji retires any photo, and its file is removed once the new
    # reference has been committed.
    old_photo = _clear_avatar_artifacts(user, keep_photo=False)
    user.avatar_emoji = emoji
    try:
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        logger.error(f'Could not store avatar emoji for user {user_id}: {exc}')
        return jsonify({'error': 'The emoji could not be saved.'}), 500

    _discard_avatar_file(old_photo)
    return jsonify(_public_user(user)), 200


@users_bp.route('/api/users/<int:user_id>/avatar/emoji', methods=['DELETE'])
@jwt_required()
def clear_avatar_emoji(user_id):
    """Drop the emoji, leaving the user on their monogram."""
    if _avatar_access_denied(user_id):
        return jsonify({'error': 'Insufficient permissions'}), 403

    user = db.session.get(User, user_id)
    if user is None:
        return jsonify({'error': 'User not found'}), 404
    if user.avatar_emoji is None:
        return jsonify(_public_user(user)), 200

    user.avatar_emoji = None
    try:
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        logger.error(f'Could not clear avatar emoji for user {user_id}: {exc}')
        return jsonify({'error': 'The emoji could not be cleared.'}), 500

    return jsonify(_public_user(user)), 200


@users_bp.route('/api/users/<int:user_id>/avatar', methods=['DELETE'])
@jwt_required()
def delete_avatar(user_id):
    if _avatar_access_denied(user_id):
        return jsonify({'error': 'Insufficient permissions'}), 403

    user = db.session.get(User, user_id)
    if user is None:
        return jsonify({'error': 'User not found'}), 404
    if not user.avatar_filename:
        return jsonify(_public_user(user)), 200

    previous = user.avatar_filename
    user.avatar_filename = None
    try:
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        logger.error(f'Could not clear avatar reference for user {user_id}: {exc}')
        return jsonify({'error': 'The photo reference could not be cleared.'}), 500

    _discard_avatar_file(previous)
    return jsonify(_public_user(user)), 200


@users_bp.route('/api/users/<int:user_id>/avatar')
def get_avatar(user_id):
    # An <img> tag cannot send an Authorization header, the same limitation
    # the SSE stream has, so the token may also arrive in the query string.
    # Without this the endpoint would be publicly enumerable: ids are
    # sequential, so every staff photo would be readable while signed out.
    token = None
    auth_header = request.headers.get('Authorization')
    if auth_header and auth_header.startswith('Bearer '):
        token = auth_header[7:]
    if not token:
        token = request.args.get('token')
    if not token:
        return jsonify({'error': 'Token required'}), 401
    try:
        decode_token(token)
    except Exception:
        return jsonify({'error': 'Invalid token'}), 401

    user = db.session.get(User, user_id)
    if user is None or not user.avatar_filename:
        return jsonify({'error': 'No photo'}), 404
    if user.is_active is False:
        return jsonify({'error': 'No photo'}), 404

    return send_from_directory(
        _avatar_dir(), user.avatar_filename, max_age=86400)


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


@users_bp.route('/api/users/me', methods=['PUT'])
@jwt_required()
def update_my_profile():
    """Self-service edit of the caller's own contact details.

    Deliberately narrow. role, department and username are NOT writable here:
    role and department are assigned by an administrator, and a rename already
    has its own password-gated route. Those keys are ignored rather than
    rejected, so the ownership and role checks live on the server and not in
    the UI (S7) - a client that sends them anyway changes nothing.
    """
    user_id = int(get_jwt_identity())
    user = User.query.get_or_404(user_id)
    data = request.json or {}
    diff = {}

    if 'display_name' in data:
        value = (data.get('display_name') or '').strip()
        if len(value) > 100:
            return jsonify({'error': 'Display name must be 100 characters or fewer'}), 400
        if value != (user.display_name or ''):
            diff['display_name'] = {'from': _as_str(user.display_name),
                                    'to': _as_str(value)}
        user.display_name = value or None

    if 'phone' in data:
        value = (data.get('phone') or '').strip()
        if value and not re.match(r'^[0-9+()\- ]{6,20}$', value):
            return jsonify({'error': 'Phone must be 6-20 characters: digits, spaces, +, - or ( )'}), 400
        if value != (user.phone or ''):
            # users.phone is UNIQUE, so an empty value is stored as NULL and
            # never collides; a real value must not already be taken.
            if value and User.query.filter(User.phone == value, User.id != user.id).first():
                return jsonify({'error': 'Phone already in use'}), 400
            diff['phone'] = {'from': _as_str(user.phone), 'to': _as_str(value)}
        user.phone = value or None

    if 'email' in data:
        value = (data.get('email') or '').strip()
        if not value:
            return jsonify({'error': 'Email is required'}), 400
        if not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', value):
            return jsonify({'error': 'Enter a valid email address'}), 400
        if len(value) > 100:
            return jsonify({'error': 'Email must be 100 characters or fewer'}), 400
        if value.lower() != (user.email or '').lower():
            if User.query.filter(User.email == value, User.id != user.id).first():
                return jsonify({'error': 'Email already in use'}), 400
            diff['email'] = {'from': _as_str(user.email), 'to': _as_str(value)}
        user.email = value

    if not diff:
        return jsonify({'message': 'No changes to save', 'user': _public_user(user)}), 200

    log_audit(user.username, 'update_self', 'user', user.username, json.dumps(diff))
    db.session.commit()
    return jsonify({'message': 'Profile updated successfully',
                    'user': _public_user(user)}), 200


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
