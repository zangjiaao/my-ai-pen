"""Asset model: one host per asset; vulnerability links via host+port.

Revision ID: 0003_asset_port_vuln_model
Revises: 0002_session_persistence_repair
Create Date: 2026-07-10
"""
from alembic import op


revision = "0003_asset_port_vuln_model"
down_revision = "0002_session_persistence_repair"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Vulnerability ↔ asset association key is IP/domain + port.
    op.execute(
        "ALTER TABLE vulnerabilities "
        "ADD COLUMN IF NOT EXISTS port VARCHAR(16)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_vuln_asset_port "
        "ON vulnerabilities (asset_id, port)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_vuln_asset_port")
    op.execute("ALTER TABLE vulnerabilities DROP COLUMN IF EXISTS port")
