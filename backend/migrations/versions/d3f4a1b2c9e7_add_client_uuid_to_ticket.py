"""add client_uuid to ticket

Revision ID: d3f4a1b2c9e7
Revises:
Create Date: 2026-09-10 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'd3f4a1b2c9e7'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Exactly one new column. NULL values are allowed and remain permissibly
    # duplicated, so legacy rows (which never had a UUID) are untouched.
    op.add_column('tickets', sa.Column('client_uuid', sa.String(length=36), nullable=True, unique=True))


def downgrade() -> None:
    op.drop_column('tickets', 'client_uuid')