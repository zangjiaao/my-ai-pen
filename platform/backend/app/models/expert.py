"""Product expert instances: user-facing persona bound to a Node + pack.

Distinct from catalog packs (``experts/``) and node offers (runtime install).
Conversation @mention routes via this table → node_id + pack engagement.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Expert(Base):
    """Routable expert instance (many experts may share one Node)."""

    __tablename__ = "experts"
    __table_args__ = (
        UniqueConstraint("name", name="uq_experts_name"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Owner; optional for single-tenant admin UX (null = shared).
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    # @mention key — Unicode-capable token matching WS mention regex (CJK allowed).
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # Optional UI display label (may differ from @mention name).
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Canonical pack id (pentest | ctf | consult | …).
    pack_id: Mapped[str] = mapped_column(String(64), nullable=False)
    # Worker Node that executes this expert's tasks.
    node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
