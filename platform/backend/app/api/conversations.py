"""Conversation API."""
import json
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.audit import AuditLog
from app.models.asset import Asset
from app.models.conversation import Conversation
from app.models.evidence import Evidence
from app.models.message import Message
from app.models.node import Node
from app.models.vulnerability import Vulnerability
from app.services.conversation_state import ConversationStatusError, transition_conversation
from app.services.conversation_snapshot import build_conversation_snapshot, conversation_summary, get_message_page

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

class ConversationOut(BaseModel):
    id: str
    title: str
    node_id: str | None
    status: str
    created_at: str | None
    last_active_at: str | None
    model_config = {"from_attributes": True}


@router.post("", response_model=ConversationOut)
async def create_conversation(current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    conv = Conversation(id=uuid.uuid4(), user_id=uuid.UUID(current_user["user_id"]))
    db.add(conv)
    await db.flush()
    await _audit(db, uuid.UUID(current_user["user_id"]), "conversation.create", "conversation", conv.id, conv.id, {"title": conv.title})
    await db.commit()
    await db.refresh(conv)
    return _out(conv)


@router.get("", response_model=list[ConversationOut])
async def list_conversations(status: str | None = Query(None), limit: int = 50, offset: int = 0,
                              current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    q = select(Conversation).where(Conversation.user_id == uuid.UUID(current_user["user_id"]))
    if status:
        q = q.where(Conversation.status == status)
    q = q.order_by(Conversation.last_active_at.desc()).offset(offset).limit(limit)
    result = await db.execute(q)
    return [_out(c) for c in result.scalars().all()]


@router.get("/{conv_id}", response_model=ConversationOut)
async def get_conversation(conv_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
    return _out(c)


@router.get("/{conv_id}/state")
async def get_conversation_state(conv_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
    return await build_conversation_snapshot(db, c, uuid.UUID(current_user["user_id"]))


@router.delete("/{conv_id}")
async def delete_conversation(conv_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
    user_id = uuid.UUID(current_user["user_id"])
    conversation_id = c.id
    node_id = c.node_id
    status = c.status
    title = c.title
    if node_id and status == "running":
        r = await db.execute(select(Node).where(Node.id == node_id))
        n = r.scalar_one_or_none()
        if n:
            n.current_sessions = max(0, (n.current_sessions or 0) - 1)
    await db.execute(delete(Message).where(Message.conversation_id == conversation_id))
    await db.execute(delete(Evidence).where(Evidence.conversation_id == conversation_id))
    await db.execute(delete(Vulnerability).where(Vulnerability.conversation_id == conversation_id))
    await db.execute(delete(Asset).where(Asset.conversation_id == conversation_id))
    await _audit(db, user_id, "conversation.delete", "conversation", conversation_id, conversation_id, {
        "title": title,
        "status": status,
        "node_id": str(node_id) if node_id else None,
    })
    await db.delete(c)
    await db.commit()
    return {"ok": True}


@router.patch("/{conv_id}")
async def update_conversation(conv_id: str, body: dict, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
    user_id = uuid.UUID(current_user["user_id"])
    before = {"title": c.title, "status": c.status}
    if "title" in body:
        title = str(body["title"]).strip()
        if not title:
            raise HTTPException(400, "title cannot be empty")
        c.title = title[:255]
    if "status" in body:
        try:
            transition_conversation(c, str(body["status"]))
        except ConversationStatusError as e:
            raise HTTPException(400, str(e)) from e
    await _audit(db, user_id, "conversation.update", "conversation", c.id, c.id, {
        "fields": sorted(body.keys()),
        "before": before,
        "after": {"title": c.title, "status": c.status},
    })
    await db.commit()
    await db.refresh(c)
    return _out(c).model_dump()


@router.get("/{conv_id}/messages")
async def get_messages(conv_id: str, limit: int = Query(200, ge=1, le=1000), offset: int = Query(0, ge=0),
                       order: str = Query("desc", pattern="^(asc|desc)$"),
                       current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
    return await get_message_page(db, c.id, limit=limit, offset=offset, order=order)


@router.post("/{conv_id}/steer")
async def steer_conversation(conv_id: str, body: dict, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
    if not c.node_id:
        raise HTTPException(409, "Conversation is not bound to a node")

    msg_type = str(body.get("type") or "user_steer")
    if msg_type not in ("user_steer", "user_interrupt"):
        raise HTTPException(400, "type must be user_steer or user_interrupt")

    payload = {
        "type": msg_type,
        "conversation_id": conv_id,
        "text": body.get("text") or body.get("instruction") or "",
        "action": body.get("action"),
        "payload": body.get("payload") or {},
    }

    from app.ws import router as ws_router

    await ws_router._save_message(payload, "user")
    sent = await ws_router._send_to_bound_node(conv_id, json.dumps(payload, ensure_ascii=False))
    await _audit(db, uuid.UUID(current_user["user_id"]), "conversation.steer", "conversation", c.id, c.id, {
        "type": msg_type,
        "sent": sent,
        "node_id": str(c.node_id) if c.node_id else None,
    }, status="success" if sent else "failed")
    await db.commit()
    if not sent:
        raise HTTPException(409, "Bound node is not online")
    return {"ok": True, "sent": True, "queued": False}


async def _audit(db: AsyncSession, user_id: uuid.UUID, action: str, resource_type: str, resource_id: uuid.UUID, conversation_id: uuid.UUID | None, detail: dict, status: str = "success") -> None:
    db.add(AuditLog(
        actor_type="user",
        actor_id=user_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        conversation_id=conversation_id,
        detail=detail,
        status=status,
    ))


async def _get_conv(conv_id: str, current_user: dict, db: AsyncSession) -> Conversation:
    result = await db.execute(select(Conversation).where(
        Conversation.id == uuid.UUID(conv_id), Conversation.user_id == uuid.UUID(current_user["user_id"])))
    c = result.scalar_one_or_none()
    if not c:
        raise HTTPException(404, "Conversation not found")
    return c


def _out(c: Conversation) -> ConversationOut:
    return ConversationOut(**conversation_summary(c))
