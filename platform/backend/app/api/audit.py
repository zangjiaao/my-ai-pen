"""审计日志 API"""
import uuid
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.audit import AuditLog

router = APIRouter(prefix="/api/audit", tags=["audit"])


class AuditOut(BaseModel):
    id: str; timestamp: str; actor_type: str; actor_name: str | None
    action: str; resource_type: str | None; status: str
    model_config = {"from_attributes": True}


@router.get("", response_model=list[AuditOut])
async def list_audit_logs(limit: int = Query(50, le=200), offset: int = 0,
                           current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    q = select(AuditLog).order_by(AuditLog.timestamp.desc()).offset(offset).limit(limit)
    result = await db.execute(q)
    return [AuditOut(id=str(r.id), timestamp=r.timestamp.isoformat(), actor_type=r.actor_type,
                      actor_name=r.actor_name, action=r.action, resource_type=r.resource_type, status=r.status)
            for r in result.scalars().all()]
