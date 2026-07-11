"""Vulnerability rediscovery history for agent dedupe timeline.

Revision ID: 0004_vuln_discovery_history
Revises: 0003_asset_port_vuln_model
Create Date: 2026-07-11
"""
from alembic import op


revision = "0004_vuln_discovery_history"
down_revision = "0003_asset_port_vuln_model"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE vulnerabilities "
        "ADD COLUMN IF NOT EXISTS history jsonb DEFAULT '[]'::jsonb"
    )
    op.execute(
        "ALTER TABLE vulnerabilities "
        "ADD COLUMN IF NOT EXISTS first_seen_at timestamptz"
    )
    # Backfill first_seen_at from discovered_at for existing rows.
    op.execute(
        "UPDATE vulnerabilities "
        "SET first_seen_at = discovered_at "
        "WHERE first_seen_at IS NULL AND discovered_at IS NOT NULL"
    )
    # Findings are user-ledger rows; unbind when conversation is deleted.
    op.execute(
        "ALTER TABLE vulnerabilities "
        "ALTER COLUMN conversation_id DROP NOT NULL"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_vuln_user_asset_title "
        "ON vulnerabilities (user_id, asset_id, lower(title))"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_vuln_user_asset_title")
    op.execute("ALTER TABLE vulnerabilities DROP COLUMN IF EXISTS history")
    op.execute("ALTER TABLE vulnerabilities DROP COLUMN IF EXISTS first_seen_at")
