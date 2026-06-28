"""会话 API"""
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.conversation import Conversation
from app.models.message import Message
from app.models.node import Node

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


class ConversationOut(BaseModel):
    id: str; title: str; node_id: str | None; status: str
    created_at: str | None; last_active_at: str | None
    model_config = {"from_attributes": True}


@router.post("", response_model=ConversationOut)
async def create_conversation(current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    conv = Conversation(id=uuid.uuid4(), user_id=uuid.UUID(current_user["user_id"]))
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return _out(conv)


@router.get("", response_model=list[ConversationOut])
async def list_conversations(status: str | None = Query(None), limit: int = 50, offset: int = 0,
                              current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    q = select(Conversation).where(Conversation.user_id == uuid.UUID(current_user["user_id"]))
    if status: q = q.where(Conversation.status == status)
    q = q.order_by(Conversation.last_active_at.desc()).offset(offset).limit(limit)
    result = await db.execute(q)
    return [_out(c) for c in result.scalars().all()]


@router.get("/{conv_id}", response_model=ConversationOut)
async def get_conversation(conv_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
    return _out(c)


@router.patch("/{conv_id}")
async def update_conversation(conv_id: str, body: dict, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
    if "title" in body: c.title = body["title"]
    if "status" in body and body["status"] in ("paused", "resumed"): c.status = body["status"]
    await db.commit()
    return {"ok": True}


@router.post("/{conv_id}/steer")
async def steer_conversation(conv_id: str, body: dict, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _get_conv(conv_id, current_user, db)
    return {"ok": True, "queued": True}


async def _get_conv(conv_id: str, current_user: dict, db: AsyncSession) -> Conversation:
    result = await db.execute(select(Conversation).where(
        Conversation.id == uuid.UUID(conv_id), Conversation.user_id == uuid.UUID(current_user["user_id"])))
    c = result.scalar_one_or_none()
    if not c: raise HTTPException(404, "Conversation not found")
    return c


def _out(c: Conversation) -> ConversationOut:
    return ConversationOut(id=str(c.id), title=c.title, node_id=str(c.node_id) if c.node_id else None,
                           status=c.status, created_at=c.created_at.isoformat() if c.created_at else None,
                           last_active_at=c.last_active_at.isoformat() if c.last_active_at else None)
