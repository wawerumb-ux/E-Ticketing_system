"""add is_internal to ticket_comments

Revision ID: b5e7f3a1c2d4
Revises: 7a2c9e0d4f8b
Create Date: 2026-09-12 17:40:00.000000

Internal Notes vs. Public Replies. One boolean on the existing table; existing
rows are public by default (server_default '0').

Manual ALTER TABLE for the live MySQL instance (E3 — db.create_all() does not
alter existing tables):

    ALTER TABLE ticket_comments
        ADD COLUMN is_internal BOOLEAN NOT NULL DEFAULT 0;

    -- if the default should apply to pre-existing rows:
    UPDATE ticket_comments SET is_internal = 0 WHERE is_internal IS NULL;

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'b5e7f3a1c2d4'
down_revision: Union[str, None] = '7a2c9e0d4f8b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('ticket_comments',
                  sa.Column('is_internal', sa.Boolean(), nullable=False,
                            server_default='0'))


def downgrade() -> None:
    op.drop_column('ticket_comments', 'is_internal')