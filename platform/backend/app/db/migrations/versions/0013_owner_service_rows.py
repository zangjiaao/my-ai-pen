"""Owner ledger Service rows + 攻击面 paths — Spec #454b / #454c.

Revision ID: 0013_owner_service_rows
Revises: 0012_owner_ledger
Create Date: 2026-08-13
"""
from alembic import op


revision = "0013_owner_service_rows"
down_revision = "0012_owner_ledger"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS asset_services (
            id UUID PRIMARY KEY,
            asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            port VARCHAR(16) NOT NULL,
            name VARCHAR(255) NOT NULL DEFAULT '',
            protocol VARCHAR(32),
            product VARCHAR(255),
            version VARCHAR(128),
            url VARCHAR(1000),
            note TEXT,
            tags TEXT[] NOT NULL DEFAULT '{}',
            source VARCHAR(32) NOT NULL DEFAULT 'user',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_services_asset_port
        ON asset_services (asset_id, port)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_asset_services_asset_id
        ON asset_services (asset_id)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS asset_service_paths (
            id UUID PRIMARY KEY,
            service_id UUID NOT NULL REFERENCES asset_services(id) ON DELETE CASCADE,
            path VARCHAR(1000) NOT NULL,
            source VARCHAR(32) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_service_paths_service_path
        ON asset_service_paths (service_id, path)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_asset_service_paths_service_id
        ON asset_service_paths (service_id)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_asset_service_paths_service_id")
    op.execute("DROP INDEX IF EXISTS ux_asset_service_paths_service_path")
    op.execute("DROP TABLE IF EXISTS asset_service_paths")
    op.execute("DROP INDEX IF EXISTS ix_asset_services_asset_id")
    op.execute("DROP INDEX IF EXISTS ux_asset_services_asset_port")
    op.execute("DROP TABLE IF EXISTS asset_services")
