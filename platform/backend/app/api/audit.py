"""Audit log API."""
import uuid
from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.audit import AuditLog
from app.models.conversation import Conversation

router = APIRouter(prefix="/api/audit", tags=["audit"])


class AuditOut(BaseModel):
    id: str
    timestamp: str
    actor_type: str
    actor_id: str
    actor_name: str | None = None
    action: str
    resource_type: str | None = None
    resource_id: str | None = None
    conversation_id: str | None = None
    status: str
    detail: dict = Field(default_factory=dict)
    model_config = {"from_attributes": True}


@router.get("", response_model=list[AuditOut])
async def list_audit_logs(
    limit: int = Query(50, le=200),
    offset: int = 0,
    conversation_id: str | None = Query(None),
    action: str | None = Query(None),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    q = select(AuditLog)
    if current_user.get("role") != "admin":
        owned_conversations = select(Conversation.id).where(Conversation.user_id == user_id)
        q = q.where(or_(AuditLog.actor_id == user_id, AuditLog.conversation_id.in_(owned_conversations)))
    if conversation_id:
        q = q.where(AuditLog.conversation_id == uuid.UUID(conversation_id))
    if action:
        q = q.where(AuditLog.action == action)
    q = q.order_by(AuditLog.timestamp.desc()).offset(offset).limit(limit)
    result = await db.execute(q)
    return [_out(row) for row in result.scalars().all()]


def _out(row: AuditLog) -> AuditOut:
    return AuditOut(
        id=str(row.id),
        timestamp=row.timestamp.isoformat(),
        actor_type=row.actor_type,
        actor_id=str(row.actor_id),
        actor_name=row.actor_name,
        action=row.action,
        resource_type=row.resource_type,
        resource_id=str(row.resource_id) if row.resource_id else None,
        conversation_id=str(row.conversation_id) if row.conversation_id else None,
        status=row.status,
        detail=row.detail or {},
    )
