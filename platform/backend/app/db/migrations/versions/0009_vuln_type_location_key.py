"""Add vuln_type + location_key for Spec #275 finding identity.

Revision ID: 0009_vuln_type_location_key
Revises: 0008_expert_is_default
Create Date: 2026-08-02
"""
from alembic import op


revision = "0009_vuln_type_location_key"
down_revision = "0008_expert_is_default"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE vulnerabilities "
        "ADD COLUMN IF NOT EXISTS vuln_type varchar(40)"
    )
    op.execute(
        "ALTER TABLE vulnerabilities "
        "ADD COLUMN IF NOT EXISTS location_key varchar(500)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_vuln_user_asset_type_loc "
        "ON vulnerabilities (user_id, asset_id, vuln_type, location_key)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_vuln_user_asset_type_loc")
    op.execute("ALTER TABLE vulnerabilities DROP COLUMN IF EXISTS location_key")
    op.execute("ALTER TABLE vulnerabilities DROP COLUMN IF EXISTS vuln_type")
