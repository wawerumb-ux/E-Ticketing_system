"""Knowledge-base article routes."""

import json

from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt, jwt_required

from extensions import db
from helpers import _as_str, log_audit, role_required, serialize_article
from models import KnowledgeArticle

knowledge_bp = Blueprint('knowledge', __name__)


@knowledge_bp.route('/api/kb/articles', methods=['GET'])
@jwt_required()
def get_kb_articles():
    query = request.args.get('q', '').strip().lower()
    category = request.args.get('category')
    is_admin = get_jwt().get('role') == 'admin'

    articles_query = KnowledgeArticle.query
    if not is_admin:
        articles_query = articles_query.filter_by(is_published=True)
    if category and category != 'all':
        articles_query = articles_query.filter_by(category=category)

    articles = articles_query.order_by(KnowledgeArticle.title.asc()).all()

    if query:
        articles = [a for a in articles if query in a.title.lower() or query in a.content.lower()]

    return jsonify([serialize_article(a) for a in articles]), 200


@knowledge_bp.route('/api/kb/articles/<int:article_id>', methods=['GET'])
@jwt_required()
def get_kb_article(article_id):
    article = KnowledgeArticle.query.get_or_404(article_id)
    if get_jwt().get('role') != 'admin' and not article.is_published:
        return jsonify({'error': 'Article not found'}), 404
    return jsonify(serialize_article(article)), 200


@knowledge_bp.route('/api/kb/articles', methods=['POST'])
@role_required('admin')
def create_kb_article():
    data = request.json
    title = data.get('title', '').strip()
    category = data.get('category', '').strip()
    content = data.get('content', '').strip()
    if not title:
        return jsonify({'error': 'Article title is required'}), 400
    if not category:
        return jsonify({'error': 'Article category is required'}), 400
    if not content:
        return jsonify({'error': 'Article content is required'}), 400

    actor = get_jwt().get('username', 'admin')
    article = KnowledgeArticle(
        title=title,
        category=category,
        content=content,
        author_username=actor,
        is_published=bool(data.get('is_published', True)),
    )
    db.session.add(article)
    log_audit(actor, 'create', 'kb_article', None, f"Created KB article '{title}' (category: {category})")
    db.session.commit()
    return jsonify(serialize_article(article)), 201


@knowledge_bp.route('/api/kb/articles/<int:article_id>', methods=['PUT'])
@role_required('admin')
def update_kb_article(article_id):
    article = KnowledgeArticle.query.get_or_404(article_id)
    data = request.json
    actor = get_jwt().get('username', 'admin')

    changeable = ['title', 'category', 'content', 'is_published']
    updates = {f: data[f] for f in changeable if f in data}
    if 'title' in updates and not str(updates['title']).strip():
        return jsonify({'error': 'Article title is required'}), 400
    if 'category' in updates and not str(updates['category']).strip():
        return jsonify({'error': 'Article category is required'}), 400
    if 'content' in updates and not str(updates['content']).strip():
        return jsonify({'error': 'Article content is required'}), 400

    old_values = {f: getattr(article, f) for f in changeable}
    for f, v in updates.items():
        setattr(article, f, v.strip() if isinstance(v, str) else v)

    diff = {f: {'from': _as_str(old_values[f]), 'to': _as_str(getattr(article, f))}
            for f in updates if old_values[f] != getattr(article, f)}
    log_audit(actor, 'update', 'kb_article', article.id, json.dumps(diff) if diff else f"Updated KB article '{article.title}'")
    db.session.commit()
    return jsonify(serialize_article(article)), 200


@knowledge_bp.route('/api/kb/articles/<int:article_id>', methods=['DELETE'])
@role_required('admin')
def delete_kb_article(article_id):
    article = KnowledgeArticle.query.get_or_404(article_id)
    actor = get_jwt().get('username', 'admin')
    title = article.title
    db.session.delete(article)
    log_audit(actor, 'delete', 'kb_article', article_id, f"Deleted KB article '{title}'")
    db.session.commit()
    return jsonify({'message': 'Article deleted successfully'}), 200
