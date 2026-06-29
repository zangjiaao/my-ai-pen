"""Conversation API."""
import json
import re
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.conversation import Conversation
from app.models.evidence import Evidence
from app.models.message import Message
from app.models.node import Node
from app.models.vulnerability import Vulnerability
from app.services.conversation_state import ConversationStatusError, transition_conversation

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

PHASES = ["precheck", "plan", "recon", "scan", "verify", "report"]
PHASE_LABELS = {
    "precheck": "目标与授权范围检查",
    "plan": "生成测试计划",
    "recon": "资产与服务探测",
    "scan": "漏洞扫描与候选发现",
    "verify": "复现验证与授权确认",
    "report": "同步结果与整理证据",
}


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
    user_id = uuid.UUID(current_user["user_id"])

    messages = (await db.execute(
        select(Message).where(Message.conversation_id == c.id).order_by(Message.created_at)
    )).scalars().all()
    assets = (await db.execute(
        select(Asset).where(Asset.user_id == user_id, Asset.conversation_id == c.id).order_by(Asset.updated_at.desc())
    )).scalars().all()
    vulns = (await db.execute(
        select(Vulnerability).where(Vulnerability.user_id == user_id, Vulnerability.conversation_id == c.id).order_by(Vulnerability.discovered_at.desc())
    )).scalars().all()
    evidence = (await db.execute(
        select(Evidence).where(Evidence.user_id == user_id, Evidence.conversation_id == c.id).order_by(Evidence.created_at.desc())
    )).scalars().all()

    decisions = {
        str(m.content.get("request_id"))
        for m in messages
        if m.msg_type == "decision" and isinstance(m.content, dict) and m.content.get("request_id")
    }
    pending = []
    seen_pending = set()
    for m in messages:
        if m.msg_type != "confirm_card" or not isinstance(m.content, dict):
            continue
        request_id = m.content.get("request_id")
        if not request_id or str(request_id) in decisions or str(request_id) in seen_pending:
            continue
        seen_pending.add(str(request_id))
        pending.append({**m.content, "message_id": str(m.id)})

    agent_state = _agent_state_from_messages(messages, evidence, c.status)
    todos = _todos_for_phase(agent_state.get("phase"), c.status)
    progress = _progress_for_phase(agent_state.get("phase"), c.status)

    return {
        "conversation": _out(c).model_dump(),
        "agent_state": agent_state,
        "progress": progress,
        "todos": todos,
        "findings": [_vuln_summary(v) for v in vulns],
        "assets": [_asset_summary(a) for a in assets],
        "pending_approvals": pending,
        "evidence": [_evidence_summary(e) for e in evidence],
        "counts": {
            "assets": len(assets),
            "findings": len(vulns),
            "pending": len(pending),
            "evidence": len(evidence),
        },
    }


@router.delete("/{conv_id}")
async def delete_conversation(conv_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
    if c.node_id and c.status == "running":
        r = await db.execute(select(Node).where(Node.id == c.node_id))
        n = r.scalar_one_or_none()
        if n:
            n.current_sessions = max(0, (n.current_sessions or 0) - 1)
    await db.delete(c)
    await db.commit()
    return {"ok": True}


@router.patch("/{conv_id}")
async def update_conversation(conv_id: str, body: dict, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
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
    await db.commit()
    await db.refresh(c)
    return _out(c).model_dump()


@router.get("/{conv_id}/messages")
async def get_messages(conv_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _get_conv(conv_id, current_user, db)
    result = await db.execute(
        select(Message).where(Message.conversation_id == uuid.UUID(conv_id)).order_by(Message.created_at).limit(200)
    )
    return [
        {
            "id": str(m.id),
            "conversation_id": str(m.conversation_id),
            "role": m.role,
            "msg_type": m.msg_type,
            "content": m.content,
            "created_at": m.created_at.isoformat() if m.created_at else None,
        }
        for m in result.scalars().all()
    ]


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
    if not sent:
        raise HTTPException(409, "Bound node is not online")
    return {"ok": True, "sent": True, "queued": False}


async def _get_conv(conv_id: str, current_user: dict, db: AsyncSession) -> Conversation:
    result = await db.execute(select(Conversation).where(
        Conversation.id == uuid.UUID(conv_id), Conversation.user_id == uuid.UUID(current_user["user_id"])))
    c = result.scalar_one_or_none()
    if not c:
        raise HTTPException(404, "Conversation not found")
    return c


def _out(c: Conversation) -> ConversationOut:
    return ConversationOut(id=str(c.id), title=c.title, node_id=str(c.node_id) if c.node_id else None,
                           status=c.status, created_at=c.created_at.isoformat() if c.created_at else None,
                           last_active_at=c.last_active_at.isoformat() if c.last_active_at else None)


def _agent_state_from_messages(messages: list[Message], evidence: list[Evidence], status: str) -> dict:
    phase = None
    iteration = None
    active_tool = None
    intake_result = None
    intake_status = None
    for m in reversed(messages):
        if m.msg_type == "status" and isinstance(m.content, dict):
            phase = m.content.get("phase") or _parse_phase(str(m.content.get("text", "")))
            iteration = m.content.get("iteration")
            active_tool = m.content.get("active_tool")
            intake_result = m.content.get("intake_result")
            intake_status = m.content.get("status")
            break
    if not active_tool:
        for m in reversed(messages):
            if m.msg_type == "tool_call" and isinstance(m.content, dict) and m.content.get("tool_name"):
                active_tool = m.content.get("tool_name")
                break
    if not active_tool and evidence:
        active_tool = evidence[0].source_tool or evidence[0].type
    if not phase:
        phase = "report" if status == "completed" else "precheck" if status == "running" else None
    return {"phase": phase, "iteration": iteration, "activeTool": active_tool, "intakeResult": intake_result, "intakeStatus": intake_status}


def _parse_phase(text: str) -> str | None:
    match = re.search(r"Phase:\s*([^\s(]+)", text)
    return match.group(1) if match else None


def _progress_for_phase(phase: str | None, status: str) -> dict:
    total = len(PHASES)
    if status == "completed":
        current = total
    elif phase in PHASES:
        current = PHASES.index(phase) + 1
    elif status == "running":
        current = 1
    else:
        current = 0
    return {"current": current, "total": total, "percent": round((current / total) * 100) if total else 0}


def _todos_for_phase(phase: str | None, status: str) -> list[dict]:
    current_index = PHASES.index(phase) if phase in PHASES else (-1 if status != "running" else 0)
    todos = []
    for index, key in enumerate(PHASES):
        if status == "completed" or index < current_index:
            item_status = "done"
        elif index == current_index:
            item_status = "running"
        else:
            item_status = "pending"
        todos.append({"id": key, "title": PHASE_LABELS[key], "status": item_status})
    return todos


def _asset_summary(a: Asset) -> dict:
    return {"id": str(a.id), "name": a.name, "address": a.address, "type": a.type, "properties": a.properties or {}}


def _vuln_summary(v: Vulnerability) -> dict:
    return {
        "id": str(v.id),
        "title": v.title,
        "severity": v.severity,
        "location": v.poc or "",
        "confidence": v.confidence,
        "status": v.status,
        "asset_id": str(v.asset_id) if v.asset_id else None,
        "evidence_ids": v.evidence_ids or [],
    }


def _evidence_summary(e: Evidence) -> dict:
    return {
        "id": str(e.id),
        "evidence_id": e.evidence_id,
        "conversation_id": str(e.conversation_id) if e.conversation_id else None,
        "node_id": str(e.node_id) if e.node_id else None,
        "type": e.type,
        "source_tool": e.source_tool,
        "tool_run_id": e.tool_run_id,
        "raw_ref": e.raw_ref,
        "summary": e.summary,
        "hash": e.hash,
        "properties": e.properties or {},
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }