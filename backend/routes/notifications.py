"""In-app notifications, preferences and broadcasts."""

import html

from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required

from extensions import db
from helpers import (
    CATEGORY_BY_TYPE,
    email_global_enabled,
    emit_event,
    get_notification_prefs,
    get_setting,
    log_audit,
    render_email_html,
    role_required,
    send_email,
)
from models import Notification, NotificationPreference, User

notifications_bp = Blueprint('notifications', __name__)


@notifications_bp.route('/api/notifications', methods=['GET'])
@jwt_required()
def get_notifications():
    user_id = int(get_jwt_identity())
    notifications = Notification.query.filter_by(user_id=user_id).order_by(Notification.created_at.desc()).all()
    unread_count = Notification.query.filter_by(user_id=user_id, is_read=False).count()
    return jsonify({
        'notifications': [{
            'id': n.id,
            'type': n.type,
            'category': CATEGORY_BY_TYPE.get(n.type),
            'message': n.message,
            'link': n.link,
            'is_read': n.is_read,
            'created_at': n.created_at.isoformat()
        } for n in notifications],
        'unread_count': unread_count
    }), 200


@notifications_bp.route('/api/notifications/<int:notification_id>/read', methods=['PUT'])
@jwt_required()
def mark_notification_read(notification_id):
    user_id = int(get_jwt_identity())
    notification = Notification.query.filter_by(id=notification_id, user_id=user_id).first_or_404()
    notification.is_read = True
    db.session.commit()
    return jsonify({'message': 'Notification marked as read'}), 200


@notifications_bp.route('/api/notifications/read-all', methods=['PUT'])
@jwt_required()
def mark_all_notifications_read():
    user_id = int(get_jwt_identity())
    Notification.query.filter_by(user_id=user_id, is_read=False).update({'is_read': True})
    db.session.commit()
    return jsonify({'message': 'All notifications marked as read'}), 200


@notifications_bp.route('/api/notifications', methods=['POST'])
@jwt_required()
def create_notification():
    # Internal/testing endpoint — not exposed in the UI yet.
    data = request.json
    target_user_id = data.get('user_id')
    if not target_user_id:
        return jsonify({'error': 'user_id is required'}), 400
    notification = Notification(
        user_id=target_user_id,
        type=data.get('type', 'ticket_update'),
        message=data['message'],
        link=data.get('link')
    )
    db.session.add(notification)
    db.session.commit()
    return jsonify({'message': 'Notification created', 'id': notification.id}), 201


@notifications_bp.route('/api/notifications/broadcast', methods=['POST'])
@role_required('admin')
def broadcast_notification():
    data = request.json
    title = data.get('title', '').strip()
    message = data.get('message', '').strip()
    role = data.get('role', 'all')
    if not message:
        return jsonify({'error': 'Broadcast message is required'}), 400

    actor = get_jwt().get('username', 'admin')
    users = User.query.filter_by(is_active=True).all()
    if role != 'all':
        users = [u for u in users if u.role == role]

    full_message = f"{title}: {message}" if title else message
    site = get_setting('site_name', 'ICT E-Ticketing')
    for user in users:
        e_ok, i_ok = get_notification_prefs(user)
        if i_ok or e_ok:
            db.session.add(Notification(user_id=user.id, type='announcement',
                                        message=full_message, link=None))
        if user.email and e_ok and email_global_enabled():
            send_email(user.email, title or 'Announcement', message,
                       html_body=render_email_html(html.escape(title or 'Announcement'),
                                                   '<p>' + html.escape(message).replace('\n', '<br>') + '</p>', site))
    emit_event('announcement', {'title': title, 'message': message[:200], 'role': role, 'count': len(users)})
    log_audit(actor, 'broadcast', 'notification', None,
              f"Broadcast ({role}) sent to {len(users)} users: {full_message[:200]}")
    db.session.commit()
    return jsonify({'message': f'Broadcast sent to {len(users)} users', 'count': len(users)}), 201


@notifications_bp.route('/api/notifications/preferences', methods=['GET'])
@jwt_required()
def get_my_preferences():
    user = User.query.filter_by(username=get_jwt().get('username')).first()
    if user is None:
        return jsonify({'error': 'User not found'}), 404
    e_ok, i_ok = get_notification_prefs(user)
    return jsonify({'email_enabled': e_ok, 'in_app_enabled': i_ok}), 200


@notifications_bp.route('/api/notifications/preferences', methods=['PUT'])
@jwt_required()
def update_my_preferences():
    user = User.query.filter_by(username=get_jwt().get('username')).first()
    if user is None:
        return jsonify({'error': 'User not found'}), 404
    data = request.json or {}
    pref = user.notification_pref
    if pref is None:
        pref = NotificationPreference(user_id=user.id)
        db.session.add(pref)
    if 'email_enabled' in data:
        pref.email_enabled = bool(data.get('email_enabled'))
    if 'in_app_enabled' in data:
        pref.in_app_enabled = bool(data.get('in_app_enabled'))
    db.session.commit()
    return jsonify({'email_enabled': pref.email_enabled is not False,
                    'in_app_enabled': pref.in_app_enabled is not False}), 200
