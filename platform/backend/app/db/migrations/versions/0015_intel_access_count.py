"""Intel access_count — harness stamp for get/view value signal.

Revision ID: 0015_intel_access_count
Revises: 0014_owner_intel
Create Date: 2026-08-15
"""
from alembic import op


revision = "0015_intel_access_count"
down_revision = "0014_owner_intel"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE asset_intel
        ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE asset_intel DROP COLUMN IF EXISTS access_count")
