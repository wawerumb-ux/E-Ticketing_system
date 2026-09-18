"""Public API v1 endpoints authenticated with API tokens."""

from flask import Blueprint, jsonify, request

from extensions import db
from helpers import (
    _next_ticket_number,
    api_token_required,
    apply_sla,
    emit_event,
    format_priority_reason,
    get_setting,
    log_audit,
    log_priority_derived,
    serialize_ticket,
)
from models import KnowledgeArticle, Ticket
from routes.tickets import _derive_ticket_priority
from sqlalchemy.exc import IntegrityError

v1_bp = Blueprint('v1', __name__)


@v1_bp.route('/api/v1/tickets', methods=['GET'])
@api_token_required
def v1_list_tickets():
    q = Ticket.query
    status = request.args.get('status')
    category = request.args.get('category')
    if status:
        q = q.filter_by(status=status)
    if category:
        q = q.filter_by(category=category)
    limit = min(int(request.args.get('limit', 100)), 500)
    tickets = q.order_by(Ticket.id.desc()).limit(limit).all()
    return jsonify({'count': len(tickets), 'tickets': [serialize_ticket(t) for t in tickets]}), 200


@v1_bp.route('/api/v1/tickets/<int:ticket_id>', methods=['GET'])
@api_token_required
def v1_get_ticket(ticket_id):
    ticket = Ticket.query.get_or_404(ticket_id)
    return jsonify(serialize_ticket(ticket)), 200


@v1_bp.route('/api/v1/stats', methods=['GET'])
@api_token_required
def v1_stats():
    from extensions import utcnow
    total = Ticket.query.count()
    return jsonify({
        'total_tickets': total,
        'open': Ticket.query.filter_by(status='open').count(),
        'in_progress': Ticket.query.filter_by(status='in_progress').count(),
        'resolved': Ticket.query.filter_by(status='resolved').count(),
        'closed': Ticket.query.filter_by(status='closed').count(),
        'sla_response_breached': sum(
            1 for t in Ticket.query.filter(Ticket.status.in_(['open', 'in_progress'])).all()
            if t.sla_response_due and utcnow() > t.sla_response_due),
    }), 200


@v1_bp.route('/api/v1/kb', methods=['GET'])
@api_token_required
def v1_kb():
    query = KnowledgeArticle.query
    category = request.args.get('category')
    if category:
        query = query.filter_by(category=category)
    articles = query.filter_by(is_published=True).order_by(KnowledgeArticle.id.asc()).all()
    return jsonify({'count': len(articles), 'articles': [{
        'id': a.id, 'title': a.title, 'category': a.category,
        'content': a.content, 'author': a.author_username,
        'created_at': a.created_at.isoformat(), 'updated_at': a.updated_at.isoformat() if a.updated_at else None}
        for a in articles]}), 200


@v1_bp.route('/api/v1/tickets', methods=['POST'])
@api_token_required
def v1_create_ticket():
    data = request.json or {}
    title = (data.get('title') or '').strip()
    desc = (data.get('description') or '').strip()
    category = (data.get('category') or get_setting('inbound_default_category', 'other') or 'other').strip()
    if not title:
        return jsonify({'error': 'Title is required'}), 400
    supplied = data.get('priority')
    if supplied is not None and supplied not in ('low', 'medium', 'high'):
        return jsonify({'error': 'Priority must be low, medium or high'}), 400
    derive_payload = dict(data)
    if supplied is not None and not data.get('priority_source'):
        derive_payload['priority_source'] = 'manual'
    priority, priority_source, explanation = _derive_ticket_priority(derive_payload, {
        'username': data.get('created_by', 'api'),
        'role': 'api',
        'department': None,
    })
    readable_explanation = None
    if priority_source == 'rule_engine' and isinstance(explanation, dict):
        readable_explanation = format_priority_reason(explanation)
    elif explanation:
        readable_explanation = str(explanation)
    ticket = Ticket(ticket_number=_next_ticket_number(),
                    title=title, description=desc or title, category=category,
                    priority=priority, priority_source=priority_source,
                    priority_explanation=readable_explanation,
                    created_by=data.get('created_by', 'api'))
    apply_sla(ticket)
    db.session.add(ticket)
    try:
        db.session.flush()
    except IntegrityError:
        db.session.rollback()
        return jsonify({'error': 'Ticket number collision, retry'}), 409
    log_audit('api', 'create', 'ticket', ticket.id, f"Created via API token ({request.api_token.name})")
    if priority_source == 'rule_engine' and explanation is not None:
        log_priority_derived('api', ticket.id, priority, priority_source, explanation)
    emit_event('ticket.created', {'id': ticket.id, 'ticket_number': ticket.ticket_number,
                                  'title': title, 'priority': priority, 'status': 'open'})
    db.session.commit()
    return jsonify(serialize_ticket(ticket)), 201
