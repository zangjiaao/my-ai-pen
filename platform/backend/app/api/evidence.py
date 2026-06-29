"""Evidence API."""
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.conversation import Conversation
from app.models.evidence import Evidence

router = APIRouter(prefix="/api/evidence", tags=["evidence"])


class EvidenceOut(BaseModel):
    id: str
    evidence_id: str
    conversation_id: str | None
    node_id: str | None
    type: str
    source_tool: str | None
    tool_run_id: str | None
    raw_ref: str | None
    summary: str | None
    hash: str | None
    properties: dict
    created_at: str | None


@router.get("", response_model=list[EvidenceOut])
async def list_evidence(
    conversation_id: str | None = Query(None),
    limit: int = Query(100, le=500),
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    q = select(Evidence).where(Evidence.user_id == user_id)
    if conversation_id:
        conv = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conversation_id), Conversation.user_id == user_id))
        if not conv.scalar_one_or_none():
            raise HTTPException(404, "Conversation not found")
        q = q.where(Evidence.conversation_id == uuid.UUID(conversation_id))
    q = q.order_by(Evidence.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(q)
    return [_out(e) for e in result.scalars().all()]


@router.get("/{evidence_id}", response_model=EvidenceOut)
async def get_evidence(evidence_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Evidence).where(
        Evidence.evidence_id == evidence_id,
        Evidence.user_id == uuid.UUID(current_user["user_id"]),
    ))
    evidence = result.scalar_one_or_none()
    if not evidence:
        raise HTTPException(404, "Evidence not found")
    return _out(evidence)


def _out(e: Evidence) -> EvidenceOut:
    return EvidenceOut(
        id=str(e.id),
        evidence_id=e.evidence_id,
        conversation_id=str(e.conversation_id) if e.conversation_id else None,
        node_id=str(e.node_id) if e.node_id else None,
        type=e.type,
        source_tool=e.source_tool,
        tool_run_id=e.tool_run_id,
        raw_ref=e.raw_ref,
        summary=e.summary,
        hash=e.hash,
        properties=e.properties or {},
        created_at=e.created_at.isoformat() if e.created_at else None,
    )