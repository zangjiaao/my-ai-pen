"""Surface inventory conversation FKs: ON DELETE SET NULL.

Revision ID: 0011_surf_inv_set_null
Revises: 0010_surface_inventory
Create Date: 2026-08-11
"""
from alembic import op


revision = "0011_surf_inv_set_null"
down_revision = "0010_surface_inventory"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE surface_inventory
          DROP CONSTRAINT IF EXISTS surface_inventory_first_conversation_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE surface_inventory
          DROP CONSTRAINT IF EXISTS surface_inventory_last_conversation_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE surface_inventory
          ADD CONSTRAINT surface_inventory_first_conversation_id_fkey
          FOREIGN KEY (first_conversation_id) REFERENCES conversations(id)
          ON DELETE SET NULL
        """
    )
    op.execute(
        """
        ALTER TABLE surface_inventory
          ADD CONSTRAINT surface_inventory_last_conversation_id_fkey
          FOREIGN KEY (last_conversation_id) REFERENCES conversations(id)
          ON DELETE SET NULL
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE surface_inventory
          DROP CONSTRAINT IF EXISTS surface_inventory_first_conversation_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE surface_inventory
          DROP CONSTRAINT IF EXISTS surface_inventory_last_conversation_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE surface_inventory
          ADD CONSTRAINT surface_inventory_first_conversation_id_fkey
          FOREIGN KEY (first_conversation_id) REFERENCES conversations(id)
        """
    )
    op.execute(
        """
        ALTER TABLE surface_inventory
          ADD CONSTRAINT surface_inventory_last_conversation_id_fkey
          FOREIGN KEY (last_conversation_id) REFERENCES conversations(id)
        """
    )
