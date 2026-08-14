"""Owner ledger Group × Host assembly — Spec #454a.

Revision ID: 0012_owner_ledger
Revises: 0011_surf_inv_set_null
Create Date: 2026-08-13

Not the retired #322 asset_inventory / cluster migration.
"""
from alembic import op


revision = "0012_owner_ledger"
down_revision = "0011_surf_inv_set_null"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS asset_groups (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_groups_user_lower_name
        ON asset_groups (user_id, lower(name))
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_asset_groups_user_id
        ON asset_groups (user_id)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS asset_assemblies (
            id UUID PRIMARY KEY,
            group_id UUID NOT NULL REFERENCES asset_groups(id) ON DELETE CASCADE,
            asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            ports TEXT[] NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_assemblies_group_asset
        ON asset_assemblies (group_id, asset_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_asset_assemblies_asset_id
        ON asset_assemblies (asset_id)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_asset_assemblies_asset_id")
    op.execute("DROP INDEX IF EXISTS ux_asset_assemblies_group_asset")
    op.execute("DROP TABLE IF EXISTS asset_assemblies")
    op.execute("DROP INDEX IF EXISTS ix_asset_groups_user_id")
    op.execute("DROP INDEX IF EXISTS ux_asset_groups_user_lower_name")
    op.execute("DROP TABLE IF EXISTS asset_groups")
