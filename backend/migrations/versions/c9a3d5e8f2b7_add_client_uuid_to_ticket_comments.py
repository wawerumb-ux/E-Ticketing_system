"""add client_uuid to ticket_comments

Revision ID: c9a3d5e8f2b7
Revises: b5e7f3a1c2d4
Create Date: 2026-09-16 10:00:00.000000

Idempotent offline comment replay (C1). One nullable unique column mirroring
tickets.client_uuid so a queued comment can be replayed safely: the server
returns the existing comment instead of creating a duplicate.

Manual ALTER TABLE for the live MySQL instance (E3 — db.create_all() does not
alter existing tables):

    ALTER TABLE ticket_comments
        ADD COLUMN client_uuid VARCHAR(36) UNIQUE;

Legacy rows are left NULL (duplicate NULLs are permitted in MySQL).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'c9a3d5e8f2b7'
down_revision: Union[str, None] = 'b5e7f3a1c2d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('ticket_comments',
                  sa.Column('client_uuid', sa.String(length=36), nullable=True, unique=True))


def downgrade() -> None:
    op.drop_column('ticket_comments', 'client_uuid')