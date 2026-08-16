"""Intel unused-fold + hard-forget audit fields.

Revision ID: 0016_intel_fold_forget
Revises: 0015_intel_access_count
Create Date: 2026-08-16
"""
from alembic import op


revision = "0016_intel_fold_forget"
down_revision = "0015_intel_access_count"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE asset_intel
        ADD COLUMN IF NOT EXISTS idle_case_count INTEGER NOT NULL DEFAULT 0
        """
    )
    op.execute(
        """
        ALTER TABLE asset_intel
        ADD COLUMN IF NOT EXISTS last_idle_conversation_id VARCHAR(64)
        """
    )
    op.execute(
        """
        ALTER TABLE asset_intel
        ADD COLUMN IF NOT EXISTS last_used_conversation_id VARCHAR(64)
        """
    )
    op.execute(
        """
        ALTER TABLE asset_intel
        ADD COLUMN IF NOT EXISTS forgotten_by VARCHAR(16)
        """
    )
    op.execute(
        """
        ALTER TABLE asset_intel
        ADD COLUMN IF NOT EXISTS forget_reason VARCHAR(400)
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE asset_intel DROP COLUMN IF EXISTS forget_reason")
    op.execute("ALTER TABLE asset_intel DROP COLUMN IF EXISTS forgotten_by")
    op.execute("ALTER TABLE asset_intel DROP COLUMN IF EXISTS last_used_conversation_id")
    op.execute("ALTER TABLE asset_intel DROP COLUMN IF EXISTS last_idle_conversation_id")
    op.execute("ALTER TABLE asset_intel DROP COLUMN IF EXISTS idle_case_count")
