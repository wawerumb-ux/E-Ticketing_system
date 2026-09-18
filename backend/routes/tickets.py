"""Ticket CRUD, comments and attachments."""

import os
import json
from datetime import timedelta
from uuid import uuid4

from flask import Blueprint, current_app, jsonify, request, send_from_directory
from flask_jwt_extended import get_jwt, jwt_required
from sqlalchemy.exc import IntegrityError
from werkzeug.utils import secure_filename

from extensions import db, utcnow
from models import Notification, Ticket, TicketAttachment, TicketComment, User
from helpers import (
    ALLOWED_EXTENSIONS,
    PRIORITY_ALLOWED,
    PRIORITY_DEFAULT_PRIORITY,
    _as_str,
    _attachment_access,
    _next_ticket_number,
    _remove_attachment_files,
    _run_periodic_tasks,
    apply_sla,
    build_priority_config,
    email_global_enabled,
    emit_event,
    evaluate_priority,
    format_priority_reason,
    get_setting,
    get_notification_prefs,
    log_audit,
    log_priority_derived,
    notify_users,
    render_email_html,
    role_required,
    send_email,
    serialize_attachment,
    serialize_ticket,
    settings_int,
)

tickets_bp = Blueprint('tickets', __name__)


@tickets_bp.route('/api/tickets', methods=['GET'])
@jwt_required()
def get_tickets():
    _run_periodic_tasks()
    claims = get_jwt()
    query = Ticket.query
    if claims.get('role') != 'admin':
        query = query.filter_by(created_by=claims.get('username'))
    tickets = query.all()
    return jsonify([serialize_ticket(t) for t in tickets]), 200


def _derive_ticket_priority(payload, claims):
    """Decide the initial priority for a new ticket.

    - ``priority_source='manual'``: an authenticated staff member supplied an
      explicit value — honor it (clamped to the allowed set).
    - ``priority_source='rule_engine'``: the portal derived it against a
      cached config while offline. It is accepted verbatim only when it
      re-verifies against the server's current config — claimed priority
      matches the current derivation AND claimed ``rules_version`` matches the
      current config version. Otherwise the server's derivation wins and the
      explanation records the divergence plus the client's original claim.
    - otherwise: derive server-side from creation-time evidence against the
      current rule config.

    Returns ``(priority, source, explanation_or_none)``.
    """
    source = payload.get('priority_source')
    supplied = payload.get('priority')

    if source == 'manual':
        priority = supplied if supplied in PRIORITY_ALLOWED else PRIORITY_DEFAULT_PRIORITY
        return priority, source, None

    evidence = {
        'title': payload.get('title'),
        'description': payload.get('description'),
        'category': payload.get('category'),
        'department': None,
        'role': claims.get('role'),
        'created_at': utcnow(),
    }
    user = User.query.filter_by(username=claims.get('username')).first()
    if user is not None:
        evidence['department'] = user.department

    config = build_priority_config()
    result = evaluate_priority(evidence, config)

    if source == 'rule_engine':
        claimed = supplied if supplied in PRIORITY_ALLOWED else PRIORITY_DEFAULT_PRIORITY
        claimed_explanation = payload.get('priority_explanation')
        claimed_version = (claimed_explanation.get('rules_version')
                           if isinstance(claimed_explanation, dict) else None)
        if claimed == result['priority'] and claimed_version == config.get('version'):
            return claimed, 'rule_engine', (
                claimed_explanation if isinstance(claimed_explanation, dict) else result)
        note = dict(result)
        note['client_claimed_priority'] = claimed
        note['client_rules_version'] = claimed_version
        note['reverified'] = True
        return result['priority'], 'rule_engine', note

    return result['priority'], 'rule_engine', result


@tickets_bp.route('/api/tickets', methods=['POST'])
@jwt_required()
def create_ticket():
    data = request.json or {}
    claims = get_jwt()
    actor = claims.get('username', 'anonymous')

    if not data.get('title') or not data.get('description') or not data.get('category'):
        return jsonify({'error': 'Title, description and category are required'}), 400

    priority, priority_source, priority_explanation = _derive_ticket_priority(data, claims)
    readable_explanation = None
    if priority_source == 'rule_engine' and isinstance(priority_explanation, dict):
        readable_explanation = format_priority_reason(priority_explanation)
    elif data.get('priority_explanation'):
        readable_explanation = str(data['priority_explanation'])

    client_uuid = data.get('client_uuid')
    if client_uuid:
        existing = Ticket.query.filter_by(client_uuid=client_uuid).first()
        if existing:
            return jsonify({
                'message': 'Ticket already exists',
                'ticket': serialize_ticket(existing),
                'ticket_number': existing.ticket_number,
            }), 200

    max_retries = 5
    for attempt in range(max_retries):
        ticket_number = _next_ticket_number()

        new_ticket = Ticket(
            ticket_number=ticket_number,
            title=data['title'],
            description=data['description'],
            category=data['category'],
            priority=priority,
            priority_source=priority_source,
            priority_explanation=readable_explanation,
            created_by=actor,
            assigned_to=data.get('assigned_to'),
            client_uuid=client_uuid,
        )
        apply_sla(new_ticket)

        db.session.add(new_ticket)
        try:
            db.session.commit()

            log_audit(actor, 'create', 'ticket', new_ticket.id,
                      f"Created ticket {ticket_number} ({data.get('category')}, {priority} via {priority_source})")

            if priority_source == 'rule_engine' and priority_explanation is not None:
                log_priority_derived(actor, new_ticket.id, priority, priority_source,
                                     priority_explanation)
            elif priority_source == 'rule_engine' and isinstance(data.get('priority_explanation'), dict):
                log_priority_derived(actor, new_ticket.id, priority, priority_source,
                                     data['priority_explanation'])

            recipients = set()
            if new_ticket.assigned_to:
                recipients.add(new_ticket.assigned_to)
            for a in User.query.filter_by(role='admin').all():
                recipients.add(a.username)
            recipients.discard(new_ticket.created_by)
            notify_users(
                recipients,
                'ticket_update',
                f"New ticket {ticket_number}: {new_ticket.title}",
                str(new_ticket.id),
                f"New ticket: {ticket_number}",
                (f"A new ticket has been created:\n\n"
                 f"{new_ticket.title}\n\n{new_ticket.description}\n\n"
                 f"Category: {new_ticket.category}\nPriority: {new_ticket.priority}\n"
                 f"Status: {new_ticket.status}")
            )
            emit_event('ticket.created', {
                'id': new_ticket.id,
                'ticket_number': ticket_number,
                'title': new_ticket.title,
                'priority': new_ticket.priority,
                'status': new_ticket.status,
            })
            db.session.commit()
            return jsonify({
                'message': 'Ticket created successfully',
                'ticket_number': ticket_number,
                'priority': priority,
                'priority_source': priority_source,
                'priority_explanation': priority_explanation,
            }), 201
        except IntegrityError:
            db.session.rollback()
            if client_uuid:
                dup = Ticket.query.filter_by(client_uuid=client_uuid).first()
                if dup:
                    return jsonify({
                        'message': 'Ticket already exists',
                        'ticket': serialize_ticket(dup),
                        'ticket_number': dup.ticket_number,
                    }), 200
            continue

    return jsonify({'error': 'Could not generate a unique ticket number, please try again'}), 500


@tickets_bp.route('/api/tickets/<int:ticket_id>', methods=['GET'])
@jwt_required()
def get_ticket(ticket_id):
    claims = get_jwt()
    ticket = Ticket.query.get_or_404(ticket_id)
    if claims.get('role') != 'admin' and ticket.created_by != claims.get('username'):
        return jsonify({'error': 'You do not have access to this ticket'}), 403
    return jsonify(serialize_ticket(ticket)), 200


@tickets_bp.route('/api/tickets/<int:ticket_id>', methods=['PUT'])
@role_required('admin')
def update_ticket(ticket_id):
    ticket = Ticket.query.get_or_404(ticket_id)
    data = request.json
    claims = get_jwt()
    actor = claims.get('username', 'admin')

    changeable = ['title', 'description', 'category', 'priority', 'status', 'assigned_to', 'resolution']
    updates = {f: data[f] for f in changeable if f in data}

    old_values = {f: getattr(ticket, f, None) for f in changeable}
    old_status = ticket.status
    old_priority = ticket.priority
    old_assigned = ticket.assigned_to

    for f, v in updates.items():
        setattr(ticket, f, v)

    if ticket.priority != old_priority:
        prev_explanation = ticket.priority_explanation
        ticket.priority_source = 'manual'
        ticket.priority_explanation = (
            f"Priority manually set to {ticket.priority} by {actor} "
            f"(was {old_priority})."
            + (f" Prior derivation: {prev_explanation}" if prev_explanation else '')
        )
        apply_sla(ticket)

    if ticket.status != old_status:
        owner = User.query.filter_by(username=ticket.created_by).first()
        if owner:
            e_ok, i_ok = get_notification_prefs(owner)
            if i_ok:
                db.session.add(Notification(
                    user_id=owner.id,
                    type='ticket_update',
                    message=f"Your ticket {ticket.ticket_number} status changed to {ticket.status.replace('_', ' ').title()}.",
                    link=str(ticket.id)
                ))
            if owner.email and e_ok and email_global_enabled():
                send_email(
                    owner.email,
                    f"Ticket {ticket.ticket_number} status update",
                    f"Your ticket {ticket.ticket_number} status changed to {ticket.status.replace('_', ' ').title()}.",
                    html_body=render_email_html(
                        f"Ticket {ticket.ticket_number} status update",
                        f"<p>Your ticket <b>{ticket.ticket_number}</b> status changed to "
                        f"<b>{ticket.status.replace('_', ' ').title()}</b>.</p>",
                        get_setting('site_name', 'ICT E-Ticketing')))

    if ticket.assigned_to != old_assigned and ticket.assigned_to:
        assigned = User.query.filter_by(username=ticket.assigned_to).first()
        if assigned:
            e_ok, i_ok = get_notification_prefs(assigned)
            if i_ok:
                db.session.add(Notification(
                    user_id=assigned.id,
                    type='ticket_update',
                    message=f"Ticket {ticket.ticket_number} assigned to you.",
                    link=str(ticket.id)
                ))
            if assigned.email and e_ok and email_global_enabled():
                send_email(
                    assigned.email,
                    f"Ticket assigned to you: {ticket.ticket_number}",
                    f"You have been assigned ticket {ticket.ticket_number}: {ticket.title}",
                    html_body=render_email_html(
                        f"Ticket assigned to you: {ticket.ticket_number}",
                        f"<p>You have been assigned ticket <b>{ticket.ticket_number}</b>: {ticket.title}</p>",
                        get_setting('site_name', 'ICT E-Ticketing')))

    diff = {}
    for f, v in updates.items():
        if old_values[f] != v:
            diff[f] = {'from': _as_str(old_values[f]), 'to': _as_str(v)}
    log_audit(actor, 'update', 'ticket', ticket.id, json.dumps(diff) if diff else None)

    emit_event('ticket.updated', {
        'id': ticket.id,
        'ticket_number': ticket.ticket_number,
        'status': ticket.status,
        'priority': ticket.priority,
    })
    db.session.commit()

    return jsonify({'message': 'Ticket updated successfully'}), 200


@tickets_bp.route('/api/tickets/<int:ticket_id>', methods=['DELETE'])
@role_required('admin')
def delete_ticket(ticket_id):
    ticket = Ticket.query.get_or_404(ticket_id)
    actor = get_jwt().get('username', 'admin')

    ticket_number = ticket.ticket_number
    _remove_attachment_files(ticket)
    db.session.delete(ticket)
    log_audit(actor, 'delete', 'ticket', ticket_id, f"Deleted ticket {ticket_number}")
    db.session.commit()

    return jsonify({'message': 'Ticket deleted successfully'}), 200


# ============ TICKET COMMENTS ============

@tickets_bp.route('/api/tickets/<int:ticket_id>/comments', methods=['GET'])
@jwt_required()
def get_ticket_comments(ticket_id):
    ticket = Ticket.query.get_or_404(ticket_id)
    claims = get_jwt()
    if claims.get('role') != 'admin' and ticket.created_by != claims.get('username'):
        return jsonify({'error': 'You do not have access to this ticket'}), 403
    is_admin = claims.get('role') == 'admin'
    query = TicketComment.query.filter_by(ticket_id=ticket_id)
    if not is_admin:
        query = query.filter_by(is_internal=False)
    comments = query.order_by(TicketComment.created_at.asc()).all()
    return jsonify([{
        'id': c.id,
        'author_username': c.author_username,
        'author_role': c.author_role,
        'message': c.message,
        'is_internal': c.is_internal,
        'created_at': c.created_at.isoformat()
    } for c in comments]), 200


@tickets_bp.route('/api/tickets/<int:ticket_id>/comments', methods=['POST'])
@jwt_required()
def create_ticket_comment(ticket_id):
    ticket = Ticket.query.get_or_404(ticket_id)
    claims = get_jwt()
    if claims.get('role') != 'admin' and ticket.created_by != claims.get('username'):
        return jsonify({'error': 'You do not have access to this ticket'}), 403
    data = request.json or {}
    message = (data.get('message') or '').strip()
    if not message:
        return jsonify({'error': 'Comment message is required'}), 400
    is_internal = bool(data.get('is_internal', False))
    if is_internal and claims.get('role') != 'admin':
        return jsonify({'error': 'Only admins can post internal notes'}), 403
    claim_username = claims.get('username', 'unknown')
    client_uuid = data.get('client_uuid')
    if client_uuid:
        existing = TicketComment.query.filter_by(client_uuid=client_uuid).first()
        if existing:
            return jsonify({
                'message': 'Comment already exists',
                'comment_id': existing.id,
                'is_internal': existing.is_internal,
                'client_uuid': existing.client_uuid,
            }), 200
    comment = TicketComment(
        ticket_id=ticket_id,
        author_username=claim_username,
        author_role=claims.get('role', 'staff'),
        message=message,
        is_internal=is_internal,
        client_uuid=client_uuid,
    )
    db.session.add(comment)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        if client_uuid:
            dup = TicketComment.query.filter_by(client_uuid=client_uuid).first()
            if dup:
                return jsonify({
                    'message': 'Comment already exists',
                    'comment_id': dup.id,
                    'is_internal': dup.is_internal,
                    'client_uuid': dup.client_uuid,
                }), 200
        return jsonify({'error': 'Could not save comment, please try again'}), 500

    log_audit(claim_username, 'comment', 'ticket', ticket_id, message[:200])

    # Internal notes are for staff eyes only — never notify the requester and
    # never email them. Public replies keep the technician-reply trigger.
    if not is_internal:
        recipients = set()
        recipients.add(ticket.created_by)
        if ticket.assigned_to:
            recipients.add(ticket.assigned_to)
        recipients.discard(claim_username)
        notify_users(
            recipients,
            'technician_reply',
            f"New reply on {ticket.ticket_number} from {claim_username}: {message[:80]}",
            str(ticket_id),
            f"New reply on ticket {ticket.ticket_number}",
            f"{claim_username} replied to ticket {ticket.ticket_number}:\n\n{message}"
        )
        emit_event('comment.created', {
            'ticket_id': ticket_id,
            'ticket_number': ticket.ticket_number,
            'author': claim_username,
            'preview': message[:120],
        })
    db.session.commit()

    return jsonify({
        'message': 'Comment added successfully',
        'comment_id': comment.id,
        'is_internal': comment.is_internal,
        'client_uuid': comment.client_uuid,
    }), 201


# ============ TICKET ATTACHMENTS ============

@tickets_bp.route('/api/tickets/<int:ticket_id>/attachments', methods=['GET'])
@jwt_required()
def list_attachments(ticket_id):
    ticket = Ticket.query.get_or_404(ticket_id)
    claims = get_jwt()
    err, status = _attachment_access(claims, ticket)
    if err:
        return err, status
    atts = TicketAttachment.query.filter_by(ticket_id=ticket.id).order_by(TicketAttachment.created_at.asc()).all()
    return jsonify([serialize_attachment(a) for a in atts]), 200


@tickets_bp.route('/api/tickets/<int:ticket_id>/attachments', methods=['POST'])
@jwt_required()
def upload_attachment(ticket_id):
    ticket = Ticket.query.get_or_404(ticket_id)
    claims = get_jwt()
    err, status = _attachment_access(claims, ticket)
    if err:
        return err, status
    asset = request.files.get('file')
    if not asset or not asset.filename:
        return jsonify({'error': 'No file provided'}), 400

    original = secure_filename(asset.filename)
    if not original:
        original = f"attachment-{uuid4().hex[:8]}"
    ext = os.path.splitext(original)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({'error': f'File type "{ext or "(none)"}" is not allowed'}), 400

    stored = f"{uuid4().hex}{ext}"
    upload_dir = current_app.config['UPLOAD_FOLDER']
    os.makedirs(upload_dir, exist_ok=True)
    asset.save(os.path.join(upload_dir, stored))

    size = 0
    try:
        size = os.path.getsize(os.path.join(upload_dir, stored))
    except OSError:
        pass

    att = TicketAttachment(
        ticket_id=ticket.id,
        original_filename=original,
        stored_filename=stored,
        file_size=size,
        mime_type=asset.mimetype,
        uploaded_by=claims.get('username')
    )
    db.session.add(att)
    log_audit(claims.get('username'), 'upload_attachment', 'attachment', None,
              f"Uploaded {original} to ticket {ticket.ticket_number}")
    emit_event('attachment.created', {
        'ticket_id': ticket.id,
        'file': original,
        'uploaded_by': claims.get('username'),
    })
    db.session.commit()
    return jsonify({'message': 'File uploaded', 'attachment': serialize_attachment(att)}), 201


@tickets_bp.route('/api/attachments/<int:attachment_id>/download', methods=['GET'])
@jwt_required()
def download_attachment(attachment_id):
    att = TicketAttachment.query.get_or_404(attachment_id)
    claims = get_jwt()
    err, status = _attachment_access(claims, att.ticket)
    if err:
        return err, status
    path = os.path.join(current_app.config['UPLOAD_FOLDER'], att.stored_filename)
    if not os.path.exists(path):
        return jsonify({'error': 'File is missing on disk'}), 404
    return send_from_directory(
        current_app.config['UPLOAD_FOLDER'], att.stored_filename,
        as_attachment=True, download_name=att.original_filename
    )


@tickets_bp.route('/api/attachments/<int:attachment_id>', methods=['DELETE'])
@jwt_required()
def delete_attachment(attachment_id):
    att = TicketAttachment.query.get_or_404(attachment_id)
    claims = get_jwt()
    err, status = _attachment_access(claims, att.ticket)
    if err:
        return err, status
    try:
        os.remove(os.path.join(current_app.config['UPLOAD_FOLDER'], att.stored_filename))
    except OSError:
        pass
    db.session.delete(att)
    log_audit(claims.get('username'), 'delete_attachment', 'attachment', att.id,
              f"Deleted {att.original_filename} from ticket {att.ticket.ticket_number}")
    db.session.commit()
    return jsonify({'message': 'Attachment deleted'}), 200
