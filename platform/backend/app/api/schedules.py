"""Scheduled engagement tasks API (Phase D)."""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.audit import AuditLog
from app.models.conversation import Conversation
from app.models.message import Message
from app.services.schedule_tasks import get_schedule_store, materialize_schedule_fire

router = APIRouter(prefix="/api/schedules", tags=["schedules"])


def _store():
    path = os.environ.get("NODE4_SCHEDULE_STORE")
    return get_schedule_store(Path(path) if path else None)


class ScheduleCreate(BaseModel):
    target: str = Field(..., min_length=1)
    scope: str | None = None
    engagement: str = "pentest"
    instruction: str = Field(..., min_length=1)
    interval: str = "1h"
    node_id: str | None = None
    goal_mode: bool = True
    goal_objective: str | None = None
    fire_immediately: bool = False


class ScheduleOut(BaseModel):
    id: str
    target: str
    scope: str
    engagement: str
    instruction: str
    interval_seconds: int
    node_id: str | None = None
    goal_mode: bool = True
    goal_objective: str | None = None
    enabled: bool = True
    next_fire_at: str | None = None
    last_fire_at: str | None = None
    last_task_id: str | None = None
    created_at: str


@router.get("", response_model=list[ScheduleOut])
async def list_schedules(current_user: dict = Depends(get_current_user)):
    store = _store()
    return [ScheduleOut(**s.to_dict()) for s in store.list_for_user(current_user["user_id"])]


@router.post("", response_model=ScheduleOut)
async def create_schedule(body: ScheduleCreate, current_user: dict = Depends(get_current_user)):
    store = _store()
    try:
        st = store.create(
            user_id=current_user["user_id"],
            target=body.target.strip(),
            scope=(body.scope or body.target).strip(),
            engagement=(body.engagement or "pentest").strip() or "pentest",
            instruction=body.instruction.strip(),
            interval=body.interval,
            node_id=body.node_id,
            goal_mode=body.goal_mode,
            goal_objective=body.goal_objective,
            fire_immediately=body.fire_immediately,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return ScheduleOut(**st.to_dict())


@router.delete("/{schedule_id}")
async def delete_schedule(schedule_id: str, current_user: dict = Depends(get_current_user)):
    store = _store()
    ok = store.delete(schedule_id, user_id=current_user["user_id"])
    if not ok:
        raise HTTPException(404, "Schedule not found")
    return {"ok": True}


@router.post("/tick")
async def tick_schedules(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Fire **this user's** due schedules only; materialize conversation + audit + optional node send.

    Returns task_assign envelopes and durable conversation/task ids.
    """
    store = _store()
    uid = current_user["user_id"]
    # Only advance schedules owned by the caller — never touch other users.
    envelopes = store.tick(user_id=uid)
    results: list[dict] = []
    for env in envelopes:
        record = materialize_schedule_fire(env, user_id=uid)
        conv_id = uuid.UUID(record["conversation_id"])
        user_uuid = uuid.UUID(uid)
        node_uuid = None
        if record.get("node_id"):
            try:
                node_uuid = uuid.UUID(str(record["node_id"]))
            except ValueError:
                node_uuid = None

        conv = Conversation(
            id=conv_id,
            user_id=user_uuid,
            title=str(record["conversation_title"])[:255],
            node_id=node_uuid,
            status="created",
            context=record["conversation_context"],
        )
        db.add(conv)

        assign = record["task_assign"]
        db.add(
            Message(
                id=uuid.uuid4(),
                conversation_id=conv_id,
                role="system",
                msg_type="task_assign",
                content=assign,
            )
        )

        audit = record["audit"]
        resource_id = None
        if audit.get("resource_id"):
            try:
                resource_id = uuid.UUID(str(audit["resource_id"]))
            except ValueError:
                resource_id = conv_id
        db.add(
            AuditLog(
                actor_type="user",
                actor_id=user_uuid,
                action=str(audit["action"]),
                resource_type=str(audit.get("resource_type") or "schedule"),
                resource_id=resource_id,
                conversation_id=conv_id,
                detail=audit.get("detail") or {},
                status=str(audit.get("status") or "success"),
            )
        )

        sent = False
        if node_uuid:
            try:
                from app.ws import router as ws_router

                sent = await ws_router._send_direct_node_message(
                    str(conv_id),
                    str(node_uuid),
                    assign,
                    "pentest.web",
                )
            except Exception:
                sent = False

        results.append(
            {
                "schedule_id": env.get("schedule_id"),
                "task_id": assign.get("task_id"),
                "conversation_id": str(conv_id),
                "engagement": assign.get("engagement"),
                "target": assign.get("target"),
                "task_assign": assign,
                "node_sent": sent,
            }
        )

    await db.commit()
    return {"ok": True, "fired": results, "count": len(results)}
