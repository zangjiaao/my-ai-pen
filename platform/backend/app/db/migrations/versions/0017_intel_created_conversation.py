"""Intel created_conversation_id for Case-scoped New.

Revision ID: 0017_intel_created_conversation
Revises: 0016_intel_fold_forget
Create Date: 2026-08-17
"""
from alembic import op


revision = "0017_intel_created_conversation"
down_revision = "0016_intel_fold_forget"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE asset_intel
        ADD COLUMN IF NOT EXISTS created_conversation_id VARCHAR(64)
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE asset_intel DROP COLUMN IF EXISTS created_conversation_id")
