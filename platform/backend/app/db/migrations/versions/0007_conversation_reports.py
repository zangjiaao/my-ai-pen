"""Persisted multi-report revisions per conversation.

Revision ID: 0007_conversation_reports
Revises: 0006_expert_color
Create Date: 2026-07-18
"""
from alembic import op


revision = "0007_conversation_reports"
down_revision = "0006_expert_color"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS conversation_reports (
            id uuid PRIMARY KEY,
            conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            user_id uuid NOT NULL REFERENCES users(id),
            title varchar(500) NOT NULL,
            summary text NULL,
            markdown text NOT NULL,
            source varchar(32) NOT NULL DEFAULT 'agent',
            created_by varchar(255) NULL,
            finding_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
            meta jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_conversation_reports_conversation_id
        ON conversation_reports (conversation_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_conversation_reports_user_id
        ON conversation_reports (user_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_conversation_reports_created_at
        ON conversation_reports (created_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS conversation_reports")
