"""Route blueprints. Imported from app.py after the app is created and the
extensions are bound, then registered with app.register_blueprint()."""

from .auth import auth_bp
from .tickets import tickets_bp
from .users import users_bp
from .notifications import notifications_bp
from .knowledge import knowledge_bp
from .admin import admin_bp
from .v1 import v1_bp
from .main import main_bp
from .showcase import showcase_bp

ALL_BLUEPRINTS = (
    auth_bp,
    tickets_bp,
    users_bp,
    notifications_bp,
    knowledge_bp,
    admin_bp,
    v1_bp,
    main_bp,
    showcase_bp,
)


def register_blueprints(app):
    for bp in ALL_BLUEPRINTS:
        app.register_blueprint(bp)
