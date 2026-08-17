"""Enforce a single default expert.

Revision ID: 0018_single_default_expert
Revises: 0017_intel_created_conversation
Create Date: 2026-08-17
"""
from alembic import op
import sqlalchemy as sa


revision = "0018_single_default_expert"
down_revision = "0017_intel_created_conversation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    default_count = op.get_bind().execute(
        sa.text("SELECT COUNT(*) FROM experts WHERE is_default IS TRUE")
    ).scalar_one()
    if default_count > 1:
        raise RuntimeError(
            "Cannot enforce a single default expert: multiple experts currently "
            "have is_default=true; clear the duplicates and rerun the migration"
        )

    op.create_index(
        "uq_experts_single_default",
        "experts",
        ["is_default"],
        unique=True,
        postgresql_where=sa.text("is_default IS TRUE"),
    )


def downgrade() -> None:
    op.drop_index("uq_experts_single_default", table_name="experts")
