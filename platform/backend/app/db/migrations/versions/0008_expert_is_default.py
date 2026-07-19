"""Add is_default flag for default conversation partner expert.

Revision ID: 0008_expert_is_default
Revises: 0007_conversation_reports
Create Date: 2026-07-20
"""
from alembic import op


revision = "0008_expert_is_default"
down_revision = "0007_conversation_reports"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE experts
        ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE experts DROP COLUMN IF EXISTS is_default")
