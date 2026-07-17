"""Add optional accent color for expert personas.

Revision ID: 0006_expert_color
Revises: 0005_experts
Create Date: 2026-07-17
"""
from alembic import op


revision = "0006_expert_color"
down_revision = "0005_experts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE experts
        ADD COLUMN IF NOT EXISTS color varchar(32) NULL
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE experts DROP COLUMN IF EXISTS color")
