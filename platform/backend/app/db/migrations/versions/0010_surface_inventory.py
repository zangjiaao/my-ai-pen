"""Durable surface inventory for Spec #410 NEW badge novelty.

Revision ID: 0010_surface_inventory
Revises: 0009_vuln_type_location_key
Create Date: 2026-08-10
"""
from alembic import op


revision = "0010_surface_inventory"
down_revision = "0009_vuln_type_location_key"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS surface_inventory (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id),
            asset_id UUID REFERENCES assets(id),
            origin_key VARCHAR(500) NOT NULL,
            path_key VARCHAR(1000) NOT NULL DEFAULT '',
            host VARCHAR(255),
            first_conversation_id UUID REFERENCES conversations(id),
            last_conversation_id UUID REFERENCES conversations(id),
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_surface_inventory_user_origin_path
        ON surface_inventory (user_id, origin_key, path_key)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_surface_inventory_user_id
        ON surface_inventory (user_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_surface_inventory_asset_id
        ON surface_inventory (asset_id)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_surface_inventory_asset_id")
    op.execute("DROP INDEX IF EXISTS ix_surface_inventory_user_id")
    op.execute("DROP INDEX IF EXISTS ux_surface_inventory_user_origin_path")
    op.execute("DROP TABLE IF EXISTS surface_inventory")
