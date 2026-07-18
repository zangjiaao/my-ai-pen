"""Persisted delivery reports for a conversation (Case/Session).

Multiple reports per conversation are allowed — agent-generated or
ledger-synthesized revisions.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ConversationReport(Base):
    __tablename__ = "conversation_reports"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Full delivery markdown body (agent-authored or ledger-synthesized).
    markdown: Mapped[str] = mapped_column(Text, nullable=False)
    # agent | ledger | import
    source: Mapped[str] = mapped_column(String(32), default="agent", nullable=False)
    # Optional creator labels (expert name / node id / seat).
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    finding_ids: Mapped[list] = mapped_column(JSONB, default=list)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
