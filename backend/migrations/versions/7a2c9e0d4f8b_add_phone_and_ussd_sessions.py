"""add phone to users and create ussd_sessions

Revision ID: 7a2c9e0d4f8b
Revises: d3f4a1b2c9e7
Create Date: 2026-09-10 13:00:00.000000

Single revision (chosen over two) because `users.phone` and `ussd_sessions`
are one USSD feature released together; splitting them would force a half
migrated database if a deployment aborts between revisions.

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '7a2c9e0d4f8b'
down_revision: Union[str, None] = 'd3f4a1b2c9e7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Admins link a phone to an existing account; USSD tickets can exist
    # before (or without) any user being linked, so the column is nullable.
    op.add_column('users', sa.Column('phone', sa.String(length=20), nullable=True, unique=True))

    op.create_table(
        'ussd_sessions',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('session_id', sa.String(length=64), nullable=False),
        sa.Column('phone', sa.String(length=20), nullable=False),
        sa.Column('state', sa.String(length=32), nullable=False),
        sa.Column('payload_json', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('session_id', name='uq_ussd_sessions_session_id'),
    )
    op.create_index(op.f('ix_ussd_sessions_session_id'), 'ussd_sessions', ['session_id'])


def downgrade() -> None:
    op.drop_index(op.f('ix_ussd_sessions_session_id'), table_name='ussd_sessions')
    op.drop_table('ussd_sessions')
    op.drop_column('users', 'phone')