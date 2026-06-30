"""repair session persistence schema

Revision ID: 0002_session_persistence_repair
Revises: 0001_alpha_schema
Create Date: 2026-06-30
"""
from alembic import op


revision = "0002_session_persistence_repair"
down_revision = "0001_alpha_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')

    op.execute("ALTER TABLE assets ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id)")
    op.execute("ALTER TABLE assets ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id)")
    op.execute("ALTER TABLE assets ADD COLUMN IF NOT EXISTS node_id uuid REFERENCES nodes(id)")

    op.execute("ALTER TABLE vulnerabilities ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id)")
    op.execute("ALTER TABLE vulnerabilities ADD COLUMN IF NOT EXISTS node_id uuid REFERENCES nodes(id)")

    op.execute("""
    CREATE TABLE IF NOT EXISTS evidence (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        evidence_id varchar(100) NOT NULL UNIQUE,
        user_id uuid REFERENCES users(id),
        conversation_id uuid REFERENCES conversations(id),
        node_id uuid REFERENCES nodes(id),
        type varchar(50) NOT NULL,
        source_tool varchar(100),
        tool_run_id varchar(100),
        raw_ref varchar(500),
        summary varchar,
        hash varchar(128),
        properties jsonb DEFAULT '{}'::jsonb,
        created_at timestamptz DEFAULT now()
    )
    """)

    op.execute("CREATE INDEX IF NOT EXISTS idx_asset_user_address ON assets(user_id, address)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_asset_conversation ON assets(conversation_id, updated_at)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_vuln_user_severity ON vulnerabilities(user_id, severity, status)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_vuln_conversation ON vulnerabilities(conversation_id, discovered_at)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_evidence_conversation ON evidence(conversation_id, created_at)")

    op.execute("""
    UPDATE vulnerabilities v
    SET user_id = c.user_id, node_id = COALESCE(v.node_id, c.node_id)
    FROM conversations c
    WHERE v.conversation_id = c.id
      AND (v.user_id IS NULL OR v.node_id IS NULL)
    """)

    op.execute("""
    UPDATE assets a
    SET user_id = COALESCE(a.user_id, c.user_id),
        node_id = COALESCE(a.node_id, c.node_id)
    FROM conversations c
    WHERE a.conversation_id = c.id
      AND (a.user_id IS NULL OR a.node_id IS NULL)
    """)


def downgrade() -> None:
    # This migration is intentionally repair-only. Dropping these columns would
    # discard session recovery data in existing deployments.
    pass
