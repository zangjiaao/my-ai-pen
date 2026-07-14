"""Product expert instances for @mention routing.

Revision ID: 0005_experts
Revises: 0004_vuln_discovery_history
Create Date: 2026-07-14
"""
from alembic import op


revision = "0005_experts"
down_revision = "0004_vuln_discovery_history"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS experts (
            id uuid PRIMARY KEY,
            user_id uuid NULL,
            name varchar(128) NOT NULL,
            display_name varchar(255) NULL,
            pack_id varchar(64) NOT NULL,
            node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
            description text NULL,
            enabled boolean NOT NULL DEFAULT true,
            created_at timestamptz DEFAULT now(),
            updated_at timestamptz DEFAULT now(),
            CONSTRAINT uq_experts_name UNIQUE (name)
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_experts_user_id ON experts (user_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_experts_node_id ON experts (node_id)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS experts")
