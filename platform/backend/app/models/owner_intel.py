"""Owner-ledger Intel (线索 / 情报) — Spec owner-intel.md."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AssetIntel(Base):
    """Notebook row hung on a Host (asset_id) or Service (asset_id + port)."""

    __tablename__ = "asset_intel"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    asset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    port: Mapped[str | None] = mapped_column(String(16), nullable=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    summary: Mapped[str] = mapped_column(String(400), nullable=False)
    body: Mapped[str] = mapped_column(String, nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="agent")
    created_task_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    forget_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    access_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    idle_case_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_idle_conversation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_used_conversation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_conversation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    forgotten_by: Mapped[str | None] = mapped_column(String(16), nullable=True)
    forget_reason: Mapped[str | None] = mapped_column(String(400), nullable=True)
    sensitivity: Mapped[str] = mapped_column(String(16), nullable=False, default="plain")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
