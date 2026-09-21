"""Admin-authored online-only showcase landing pages.

Public read + template loader here; the admin CRUD endpoints land in the same
blueprint (Phase 5). Boundary contract: the showcase folder is self-contained
and is never precached by the service worker; the offline landing is untouched.
Remote assets are allowed only inside frontend/showcase/, so templates carry the
remote URLs, not this module.
"""

import json
import os
import re

from flask import Blueprint, Response, jsonify, request
from flask_jwt_extended import get_jwt, verify_jwt_in_request

from extensions import db
from helpers import log_audit, role_required
from models import ShowcasePage

showcase_bp = Blueprint('showcase', __name__)

# Curated template allowlist — the only values accepted for the template
# column. Every load stays inside frontend/showcase/templates/<name>.html:
# no path traversal, no concatenation with user input.
SHOWCASE_TEMPLATES = ('aurora-glass', 'mono-terminal', 'glass-corporate', 'gradient-pulse', 'sketchbook', 'openserv-laptop')

# frontend/showcase/templates resolved from this file's location (mirrors the
# FRONTEND_DIR pattern in routes/main.py), immune to cwd.
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOWCASE_TEMPLATES_DIR = os.path.join(
    os.path.dirname(_BACKEND_DIR), 'frontend', 'showcase', 'templates')

# Templates embed this marker at the injection point; the loader replaces it
# with the config script tag. Falls back to before </head> if absent.
_CONFIG_MARKER = '<!--SHOWCASE_CONFIG-->'


def _load_template(template):
    """Read a curated template file, or None when the template is unknown or
    the file is missing. Never falls back to a remote URL (S2)."""
    if template not in SHOWCASE_TEMPLATES:
        return None
    path = os.path.join(SHOWCASE_TEMPLATES_DIR, template + '.html')
    if not os.path.isfile(path):
        return None
    with open(path, 'r', encoding='utf-8') as handle:
        return handle.read()


def _inject_config(html, config):
    """Inject the row's config as a JSON script tag the template JS reads."""
    tag = ('<script type="application/json" id="showcase-config">'
           + json.dumps(config) + '</script>')
    if _CONFIG_MARKER in html:
        return html.replace(_CONFIG_MARKER, tag)
    if '</head>' in html:
        return html.replace('</head>', tag + '</head>')
    return tag + html


def page_is_rendered_for_admin():
    """True when the request carries a valid admin JWT. Used to gate disabled
    showcases behind ?preview=1. Token presence is optional — a public request
    with no Authorization header simply yields no claims."""
    verify_jwt_in_request(optional=True)
    claims = get_jwt()
    return claims.get('role') == 'admin'


@showcase_bp.route('/showcase/<slug>', methods=['GET'])
def render_showcase(slug):
    """Public read: enabled showcases render for everyone. Disabled or unknown
    slugs are 404. ?preview=1 renders a disabled page only with an admin JWT
    (the admin app fetches with its Authorization header and injects the HTML
    into an iframe srcdoc). The login surface lines up with the offline landing
    by construction — templates call AuthAPI.login, not this route."""
    page = ShowcasePage.query.filter_by(slug=slug).first()
    if page is None:
        return jsonify({'error': 'Showcase not found'}), 404

    preview = request.args.get('preview') == '1'
    if not page.enabled and not (preview and page_is_rendered_for_admin()):
        return jsonify({'error': 'Showcase not found'}), 404

    template_html = _load_template(page.template)
    if template_html is None:
        return jsonify({'error': 'Template unavailable'}), 404

    config = {
        'slug': page.slug,
        'template': page.template,
        'title': page.title,
        'preview': bool(preview),
        'enabled': page.enabled,
        'theme': page.theme_json or {},
        'content': page.content_json or {},
        'hero_url': page.hero_url,
    }
    return Response(_inject_config(template_html, config), mimetype='text/html')


# ---------------------------------------------------------------------------
# Admin CRUD (all endpoints @role_required('admin'), each write audited).
# ---------------------------------------------------------------------------

_SLUG_RE = re.compile(r'^[a-z0-9-]+$')


def _serialize(page):
    return {
        'id': page.id,
        'slug': page.slug,
        'title': page.title,
        'template': page.template,
        'theme': page.theme_json or {},
        'hero_url': page.hero_url,
        'content': page.content_json or {},
        'enabled': bool(page.enabled),
        'created_by': page.created_by,
        'created_at': page.created_at.isoformat() if page.created_at else None,
        'updated_at': page.updated_at.isoformat() if page.updated_at else None,
    }


def _audit_actor():
    claims = get_jwt()
    return claims.get('username')


def _parse_body():
    """Validate the admin payload. Returns (fields_dict, error)."""
    data = request.get_json(silent=True) or {}
    fields = {
        'title': data.get('title'),
        'template': data.get('template'),
        'theme': data.get('theme'),
        'content': data.get('content'),
        'hero_url': data.get('hero_url'),
    }
    if not fields['title'] or not str(fields['title']).strip():
        return None, 'Title is required'
    fields['title'] = str(fields['title']).strip()
    if fields['template'] not in SHOWCASE_TEMPLATES:
        return None, 'Unknown template'
    if fields['theme'] is not None and not isinstance(fields['theme'], dict):
        return None, 'theme must be a JSON object'
    if fields['content'] is not None and not isinstance(fields['content'], dict):
        return None, 'content must be a JSON object'
    if fields['hero_url'] is not None and not isinstance(fields['hero_url'], str):
        return None, 'hero_url must be a string'
    return fields, None


@showcase_bp.route('/api/showcase', methods=['GET'])
@role_required('admin')
def list_showcases():
    pages = ShowcasePage.query.order_by(ShowcasePage.updated_at.desc()).all()
    return jsonify([_serialize(p) for p in pages]), 200


@showcase_bp.route('/api/showcase', methods=['POST'])
@role_required('admin')
def create_showcase():
    data = request.get_json(silent=True) or {}
    slug = str(data.get('slug') or '').strip()
    if not _SLUG_RE.match(slug):
        return jsonify({'error': 'Slug must be lowercase letters, numbers or dashes'}), 400
    if ShowcasePage.query.filter_by(slug=slug).first():
        return jsonify({'error': f'Slug "{slug}" is already in use'}), 400
    fields, err = _parse_body()
    if err:
        return jsonify({'error': err}), 400

    page = ShowcasePage(
        slug=slug,
        title=fields['title'],
        template=fields['template'],
        theme_json=fields['theme'],
        content_json=fields['content'],
        hero_url=fields['hero_url'],
        enabled=False,
        created_by=_audit_actor(),
    )
    db.session.add(page)
    db.session.commit()
    log_audit(_audit_actor(), 'showcase_created', 'showcase_page', page.id,
              f"Created showcase '{slug}'")
    db.session.commit()
    return jsonify(_serialize(page)), 201


@showcase_bp.route('/api/showcase/<int:showcase_id>', methods=['PUT'])
@role_required('admin')
def update_showcase(showcase_id):
    page = ShowcasePage.query.get_or_404(showcase_id)
    data = request.get_json(silent=True) or {}
    if 'slug' in data and str(data.get('slug') or '') != page.slug:
        return jsonify({'error': 'Slug is immutable once the showcase exists'}), 400
    fields, err = _parse_body()
    if err:
        return jsonify({'error': err}), 400

    page.title = fields['title']
    page.template = fields['template']
    page.theme_json = fields['theme']
    page.content_json = fields['content']
    page.hero_url = fields['hero_url']
    db.session.commit()
    log_audit(_audit_actor(), 'showcase_updated', 'showcase_page', page.id,
              f"Updated showcase '{page.slug}'")
    db.session.commit()
    return jsonify(_serialize(page)), 200


@showcase_bp.route('/api/showcase/<int:showcase_id>', methods=['DELETE'])
@role_required('admin')
def delete_showcase(showcase_id):
    page = ShowcasePage.query.get_or_404(showcase_id)
    slug = page.slug
    db.session.delete(page)
    db.session.commit()
    log_audit(_audit_actor(), 'showcase_deleted', 'showcase_page', None,
              f"Deleted showcase '{slug}'")
    db.session.commit()
    return jsonify({'message': 'Showcase deleted'}), 200


@showcase_bp.route('/api/showcase/<int:showcase_id>/enable', methods=['PUT'])
@role_required('admin')
def enable_showcase(showcase_id):
    page = ShowcasePage.query.get_or_404(showcase_id)
    page.enabled = True
    db.session.commit()
    log_audit(_audit_actor(), 'showcase_enabled', 'showcase_page', page.id,
              f"Enabled showcase '{page.slug}'")
    db.session.commit()
    return jsonify(_serialize(page)), 200


@showcase_bp.route('/api/showcase/<int:showcase_id>/disable', methods=['PUT'])
@role_required('admin')
def disable_showcase(showcase_id):
    page = ShowcasePage.query.get_or_404(showcase_id)
    page.enabled = False
    db.session.commit()
    log_audit(_audit_actor(), 'showcase_disabled', 'showcase_page', page.id,
              f"Disabled showcase '{page.slug}'")
    db.session.commit()
    return jsonify(_serialize(page)), 200