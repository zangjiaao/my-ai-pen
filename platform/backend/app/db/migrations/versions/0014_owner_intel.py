"""Owner ledger Intel (线索 / 情报) — Spec owner-intel.md / map #459.

Revision ID: 0014_owner_intel
Revises: 0013_owner_service_rows
Create Date: 2026-08-15
"""
from alembic import op


revision = "0014_owner_intel"
down_revision = "0013_owner_service_rows"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS asset_intel (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            port VARCHAR(16),
            kind VARCHAR(32) NOT NULL,
            summary VARCHAR(400) NOT NULL,
            body TEXT NOT NULL,
            source VARCHAR(16) NOT NULL DEFAULT 'agent',
            created_task_id VARCHAR(128),
            forget_count INTEGER NOT NULL DEFAULT 0,
            sensitivity VARCHAR(16) NOT NULL DEFAULT 'plain',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_asset_intel_user_id
        ON asset_intel (user_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_asset_intel_asset_id
        ON asset_intel (asset_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_asset_intel_asset_port
        ON asset_intel (asset_id, port)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_asset_intel_forget_count
        ON asset_intel (forget_count)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_asset_intel_forget_count")
    op.execute("DROP INDEX IF EXISTS ix_asset_intel_asset_port")
    op.execute("DROP INDEX IF EXISTS ix_asset_intel_asset_id")
    op.execute("DROP INDEX IF EXISTS ix_asset_intel_user_id")
    op.execute("DROP TABLE IF EXISTS asset_intel")
