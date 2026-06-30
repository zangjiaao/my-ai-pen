import uuid
from datetime import datetime

from sqlalchemy import String, Float, Integer, DateTime, func
from sqlalchemy.dialects.postgresql import UUID, JSONB, INET
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


PLATFORM_AGENT_NODE_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")
PLATFORM_AGENT_NODE_NAME = "平台Agent"


class Node(Base):
    __tablename__ = "nodes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    type: Mapped[str] = mapped_column(String(50), default="pentest")
    status: Mapped[str] = mapped_column(String(20), default="offline")
    token_hash: Mapped[str | None] = mapped_column(String(255))
    ip: Mapped[str | None] = mapped_column(INET)
    cpu_usage: Mapped[float | None] = mapped_column(Float)
    memory_usage: Mapped[float | None] = mapped_column(Float)
    current_sessions: Mapped[int] = mapped_column(Integer, default=0)
    last_heartbeat: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    registered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
