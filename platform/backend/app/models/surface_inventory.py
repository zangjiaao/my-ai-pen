"""Durable surface identity inventory — Spec #410 (novelty baseline for NEW).

Not Case Surface ledger (that remains conversation.context surface_ledger).
Aligns with Asset inventory Spec #322: optional asset_id when Host is known.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SurfaceInventory(Base):
    """User-scoped precipitated surface identity (origin_key + path_key)."""

    __tablename__ = "surface_inventory"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "origin_key",
            "path_key",
            name="ux_surface_inventory_user_origin_path",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    # Optional Host join when Asset exists for origin host (#322).
    asset_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id"), nullable=True, index=True
    )
    origin_key: Mapped[str] = mapped_column(String(500), nullable=False)
    path_key: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Nullable provenance only — inventory rows outlive Cases (delete_conversation unbinds).
    first_conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="SET NULL"),
        nullable=True,
    )
    last_conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="SET NULL"),
        nullable=True,
    )
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
