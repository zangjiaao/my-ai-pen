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
from app.models.surface_inventory import SurfaceInventory
from app.models.vulnerability import Vulnerability
from app.services.conversation_state import (
    ConversationStatusError,
    reconcile_conversation_status_from_checkpoint,
    transition_conversation,
)
from app.services.conversation_snapshot import build_conversation_snapshot, conversation_summary, get_message_page

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

class ConversationOut(BaseModel):
    id: str
    title: str
    node_id: str | None
    status: str
    # True when any expert runtime is mid work-burst on this session.
    working: bool = False
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
    rows = list(result.scalars().all())
    # Heal rows stuck at created/running when checkpoint already terminal (sidebar status).
    healed = False
    for conv in rows:
        if reconcile_conversation_status_from_checkpoint(conv):
            healed = True
    if healed:
        await db.commit()
    return [_out(c) for c in rows]


@router.get("/{conv_id}", response_model=ConversationOut)
async def get_conversation(conv_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
    return _out(c)


@router.get("/{conv_id}/state")
async def get_conversation_state(conv_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
    return await build_conversation_snapshot(db, c, uuid.UUID(current_user["user_id"]))


@router.get("/{conv_id}/dashboard")
async def get_conversation_dashboard(
    conv_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Engagement dashboard DTO (Phase C): status + findings from real snapshot/DB."""
    from app.services.engagement_dashboard import (
        activity_from_snapshot_messages,
        build_engagement_dashboard,
    )

    c = await _get_conv(conv_id, current_user, db)
    user_id = uuid.UUID(current_user["user_id"])
    snapshot = await build_conversation_snapshot(db, c, user_id)

    findings = list(snapshot.get("findings") or [])
    if not findings:
        vulns = await db.execute(
            select(Vulnerability).where(
                Vulnerability.conversation_id == c.id,
                Vulnerability.user_id == user_id,
            )
        )
        findings = [
            {
                "id": str(v.id),
                "title": v.title,
                "severity": v.severity,
                "status": v.status,
                "evidence_ids": list(v.evidence_ids or []),
            }
            for v in vulns.scalars().all()
        ]

    timeline = activity_from_snapshot_messages(
        snapshot.get("messages") if isinstance(snapshot.get("messages"), list) else []
    )

    ctx = c.context if isinstance(c.context, dict) else {}
    task = ctx.get("task") if isinstance(ctx.get("task"), dict) else {}
    closeout = ctx.get("engagement_closeout") if isinstance(ctx.get("engagement_closeout"), dict) else {}
    conv_dict = {
        "id": str(c.id),
        "title": c.title,
        "status": c.status,
        "task": task,
        "engagement": task.get("engagement") or task.get("role"),
        "target": task.get("target"),
        "engagement_closeout": closeout or snapshot.get("engagement_closeout") or {},
    }
    return build_engagement_dashboard(
        conversation=conv_dict,
        agent_state=snapshot.get("agent_state") if isinstance(snapshot.get("agent_state"), dict) else {},
        findings=findings,
        timeline_events=timeline,
        engagement=str(task.get("engagement") or task.get("role") or "") or None,
        target=str(task.get("target") or "") or None,
        progress=snapshot.get("progress") if isinstance(snapshot.get("progress"), dict) else {},
    )


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
    # Spec #354 Case close: best-effort Node release (park + sticky pen-sandbox rm).
    # Do **not** wait for case_session_release_ack — Node may take seconds on docker
    # rm / busy-wait idle (was up to 6s + idle wait), which freezes the delete UI.
    # Platform Case row is the operator SoT; sandbox cleanup is fire-and-forget.
    release_result = await _notify_node_case_session_release(node_id, str(conversation_id))
    await db.execute(delete(Message).where(Message.conversation_id == conversation_id))
    await db.execute(delete(Evidence).where(Evidence.conversation_id == conversation_id))
    # Vulnerability + asset + surface inventory are user-owned and long-lived: do not
    # cascade-delete. Schema SoT: surface_inventory first/last_conversation_id use
    # ON DELETE SET NULL (migration 0011). App-level unbind is belt-and-suspenders for
    # DBs that have not applied 0011 yet — keep until all envs are migrated.
    await db.execute(
        Vulnerability.__table__.update()
        .where(Vulnerability.conversation_id == conversation_id)
        .values(conversation_id=None)
    )
    await db.execute(
        Asset.__table__.update()
        .where(Asset.conversation_id == conversation_id)
        .values(conversation_id=None)
    )
    await db.execute(
        SurfaceInventory.__table__.update()
        .where(SurfaceInventory.first_conversation_id == conversation_id)
        .values(first_conversation_id=None)
    )
    await db.execute(
        SurfaceInventory.__table__.update()
        .where(SurfaceInventory.last_conversation_id == conversation_id)
        .values(last_conversation_id=None)
    )
    await _audit(db, user_id, "conversation.delete", "conversation", conversation_id, conversation_id, {
        "title": title,
        "status": status,
        "node_id": str(node_id) if node_id else None,
        "case_session_release": release_result,
    })
    await db.delete(c)
    await db.commit()
    return {"ok": True, "case_session_release": release_result}


class SessionActionBody(BaseModel):
    expert_id: str | None = None


@router.post("/{conv_id}/sessions/reset")
async def reset_participant_session(
    conv_id: str,
    body: SessionActionBody | None = None,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Spec #354 L9: Session Reset — clear model memory, keep incomplete Todo.

    L10a: Node mints a new pi Agent.sessionId on Reset; project it onto the
    participant so collab copy chrome updates without waiting for the next run.
    """
    from sqlalchemy.orm.attributes import flag_modified

    from app.services.case_participants import upsert_participant

    c = await _get_conv(conv_id, current_user, db)
    expert_id = str((body.expert_id if body else None) or _active_expert_id(c) or "").strip()
    result = await _notify_node_session_op(
        c.node_id,
        "session_reset",
        conversation_id=str(c.id),
        expert_id=expert_id or None,
    )
    agent_session_id = None
    if isinstance(result.get("ack"), dict):
        agent_session_id = str(result["ack"].get("agent_session_id") or "").strip() or None
    if expert_id and agent_session_id:
        ctx = dict(c.context) if isinstance(c.context, dict) else {}
        ctx = upsert_participant(
            ctx,
            expert_id=expert_id,
            pi_agent_session_id=agent_session_id,
            touch=True,
        )
        c.context = ctx
        flag_modified(c, "context")
    await _audit(
        db,
        uuid.UUID(current_user["user_id"]),
        "session.reset",
        "conversation",
        c.id,
        c.id,
        {
            "expert_id": expert_id or None,
            "node": result,
            "agent_session_id": agent_session_id,
        },
    )
    await db.commit()
    return {
        "ok": True,
        "expert_id": expert_id or None,
        "agent_session_id": agent_session_id,
        "node": result,
    }


@router.post("/{conv_id}/sessions/delete")
async def delete_participant_session(
    conv_id: str,
    body: SessionActionBody | None = None,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Spec #354 L10: Session Delete — dispose identity; hold incomplete map for handoff.

    Also settles mid-run package chrome: workers/working/status light/interrupt button
    so Navbar and composer leave the running/interrupt state.
    """
    from sqlalchemy.orm.attributes import flag_modified

    from app.services.case_participants import (
        remove_participant,
        settle_context_after_session_delete,
    )
    from app.services.session_handoff import put_pending_handoff

    c = await _get_conv(conv_id, current_user, db)
    expert_id = str((body.expert_id if body else None) or _active_expert_id(c) or "").strip()
    node_id = str(c.node_id) if c.node_id else None
    result = await _notify_node_session_op(
        c.node_id,
        "session_dispose",
        conversation_id=str(c.id),
        expert_id=expert_id or None,
    )
    # Prefer Node open_todos from lifecycle ack (SoT for live TodoStore).
    open_todos: list = []
    if isinstance(result.get("ack"), dict):
        raw = result["ack"].get("open_todos")
        if isinstance(raw, list) and raw:
            open_todos = raw
    ctx = dict(c.context) if isinstance(c.context, dict) else {}
    if not open_todos:
        open_todos = _open_todos_from_context(ctx, expert_id=expert_id or None)

    if expert_id:
        ctx = put_pending_handoff(ctx, expert_id=expert_id, open_todos=open_todos, source="session_delete")
        sessions = dict(ctx.get("sessions") or {}) if isinstance(ctx.get("sessions"), dict) else {}
        if expert_id in sessions:
            sessions.pop(expert_id, None)
            if sessions:
                ctx["sessions"] = sessions
            else:
                ctx.pop("sessions", None)
        ctx = remove_participant(ctx, expert_id=expert_id)
        # Drop sticky Case speaker when this Session was the sticky one so re-entry
        # is an explicit re-select (not silent resurrect of disposed identity).
        task = dict(ctx.get("task") or {}) if isinstance(ctx.get("task"), dict) else {}
        if str(task.get("expert_id") or "").strip() == expert_id:
            task.pop("expert_id", None)
            task.pop("expert_name", None)
            if task:
                ctx["task"] = task
            else:
                ctx.pop("task", None)

    # Close package busy chrome (workers / interrupt / checkpoint ghost Main).
    ctx = settle_context_after_session_delete(ctx, expert_id=expert_id or None)
    # Ensure empty participants dict remains (no checkpoint fallback).
    if not isinstance(ctx.get("participants"), dict):
        ctx["participants"] = {}
    c.context = ctx
    try:
        if str(c.status or "").strip().lower() == "running":
            transition_conversation(c, "incomplete")
    except ConversationStatusError:
        pass
    flag_modified(c, "context")
    await _audit(
        db,
        uuid.UUID(current_user["user_id"]),
        "session.delete",
        "conversation",
        c.id,
        c.id,
        {"expert_id": expert_id or None, "node": result, "held": bool(open_todos)},
    )
    await db.commit()

    # Broadcast so FE Navbar light + interrupt/send update without waiting for poll.
    try:
        from app.ws import router as ws_router

        workers = (c.context or {}).get("workers") if isinstance(c.context, dict) else {}
        payload = {
            "type": "conversation_working",
            "conversation_id": str(c.id),
            "working": bool(workers),
            "status": str(c.status or "incomplete"),
            "workers": [
                {"node_id": nid, **(meta if isinstance(meta, dict) else {})}
                for nid, meta in (workers or {}).items()
            ],
            "interrupting": False,
            "reason": "session_delete",
        }
        await ws_router._broadcast_conversation_working(payload)
    except Exception as e:
        print(f"[api] session delete working broadcast error: {e}")

    return {
        "ok": True,
        "expert_id": expert_id or None,
        "pending_handoff": bool(open_todos),
        "node": result,
    }


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
    # Case-shaped fields (v1: conversation = case)
    case_keys = ("engagement_template", "allow_postex", "stations", "accounts", "handoff")
    if any(k in body for k in case_keys):
        from app.services.case_engagement import merge_case_into_context

        c.context = merge_case_into_context(
            c.context if isinstance(c.context, dict) else {},
            engagement_template=body.get("engagement_template"),
            allow_postex=body.get("allow_postex") if "allow_postex" in body else None,
            stations=body.get("stations") if "stations" in body else None,
            handoff=body.get("handoff") if "handoff" in body else None,
            accounts=body.get("accounts") if "accounts" in body else None,
        )
    await _audit(db, user_id, "conversation.update", "conversation", c.id, c.id, {
        "fields": sorted(body.keys()),
        "before": before,
        "after": {"title": c.title, "status": c.status},
    })
    await db.commit()
    await db.refresh(c)
    return _out(c).model_dump()


@router.get("/{conv_id}/case")
async def get_conversation_case(
    conv_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Case view for v1: one conversation = one case (scope, RoE, stations, handoff)."""
    from app.services.case_engagement import case_fields_from_context

    c = await _get_conv(conv_id, current_user, db)
    fields = case_fields_from_context(c.context)
    return {
        "case_id": str(c.id),
        "conversation_id": str(c.id),
        "title": c.title,
        "status": c.status,
        **fields,
    }


@router.put("/{conv_id}/case")
async def put_conversation_case(
    conv_id: str,
    body: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update Case-shaped fields on conversation (structured engagement/RoE only)."""
    from app.services.case_engagement import case_fields_from_context, merge_case_into_context

    c = await _get_conv(conv_id, current_user, db)
    c.context = merge_case_into_context(
        c.context if isinstance(c.context, dict) else {},
        engagement_template=body.get("engagement_template"),
        allow_postex=body.get("allow_postex") if "allow_postex" in body else None,
        stations=body.get("stations") if "stations" in body else None,
        handoff=body.get("handoff") if "handoff" in body else None,
        accounts=body.get("accounts") if "accounts" in body else None,
    )
    await _audit(
        db,
        uuid.UUID(current_user["user_id"]),
        "conversation.case.update",
        "conversation",
        c.id,
        c.id,
        {"fields": sorted(k for k in body.keys() if k in ("engagement_template", "allow_postex", "stations", "handoff", "accounts"))},
    )
    await db.commit()
    await db.refresh(c)
    fields = case_fields_from_context(c.context)
    return {"case_id": str(c.id), "conversation_id": str(c.id), **fields}


@router.post("/{conv_id}/handoff")
async def suggest_expert_handoff(
    conv_id: str,
    body: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Store a structured handoff suggestion (does not auto-switch pack).

    Body: { suggest_pack_id, reason?, artifact_ids?, expert_id?, expert_name? }
    UI confirms via @expert / send with expert_id — never silent NLP rewrite.
    """
    from app.services.case_engagement import case_fields_from_context, merge_case_into_context
    from app.services.expert_offers import normalize_pack_id

    c = await _get_conv(conv_id, current_user, db)
    pack = normalize_pack_id(body.get("suggest_pack_id") or body.get("pack_id") or body.get("engagement"))
    if not pack:
        raise HTTPException(400, "suggest_pack_id must be a known pack id or alias")
    handoff = {
        "suggest_pack_id": pack,
        "reason": str(body.get("reason") or "").strip()[:2000],
        "artifact_ids": body.get("artifact_ids") if isinstance(body.get("artifact_ids"), list) else [],
        "expert_id": str(body.get("expert_id") or "").strip() or None,
        "expert_name": str(body.get("expert_name") or "").strip() or None,
        "status": "suggested",
    }
    c.context = merge_case_into_context(
        c.context if isinstance(c.context, dict) else {},
        handoff=handoff,
    )
    await _audit(
        db,
        uuid.UUID(current_user["user_id"]),
        "conversation.handoff.suggest",
        "conversation",
        c.id,
        c.id,
        handoff,
    )
    await db.commit()
    fields = case_fields_from_context(c.context)
    return {"ok": True, "handoff": fields.get("handoff"), "case_id": str(c.id)}


@router.get("/{conv_id}/messages")
async def get_messages(conv_id: str, limit: int = Query(200, ge=1, le=1000), offset: int = Query(0, ge=0),
                       order: str = Query("desc", pattern="^(asc|desc)$"),
                       current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _get_conv(conv_id, current_user, db)
    return await get_message_page(db, c.id, limit=limit, offset=offset, order=order)


@router.put("/{conv_id}/workers/{agent_id}/display-name")
async def put_worker_display_name(
    conv_id: str,
    agent_id: str,
    body: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Spec #308: Case-persistent Worker display_name override (empty clears)."""
    from app.services.case_participants import set_worker_display_name, worker_display_names_map
    from app.ws import router as ws_router

    c = await _get_conv(conv_id, current_user, db)
    aid = str(agent_id or "").strip()
    if not aid:
        raise HTTPException(400, "agent_id required")
    raw_name = body.get("display_name") if isinstance(body, dict) else None
    next_ctx = set_worker_display_name(
        c.context if isinstance(c.context, dict) else {},
        agent_id=aid,
        display_name=raw_name,
    )
    if next_ctx is None:
        raise HTTPException(400, "invalid agent_id or display_name (1–64 chars, no control chars)")
    c.context = next_ctx
    names = worker_display_names_map(next_ctx)
    resolved = names.get(aid) or ""
    await _audit(
        db,
        uuid.UUID(current_user["user_id"]),
        "conversation.worker_display_name",
        "conversation",
        c.id,
        c.id,
        {"agent_id": aid, "display_name": resolved or None, "cleared": not resolved},
    )
    await db.commit()
    # Near-real-time: broadcast so tree/dialog/Tasks can refresh without full reload.
    try:
        import json as _json

        await ws_router._broadcast_to_conversation(
            conv_id,
            _json.dumps(
                {
                    "type": "worker_display_name",
                    "conversation_id": conv_id,
                    "agent_id": aid,
                    "display_name": resolved or None,
                    "worker_display_names": names,
                },
                ensure_ascii=False,
            ),
        )
    except Exception as exc:
        print(f"[API] worker_display_name broadcast: {exc}")
    return {
        "ok": True,
        "agent_id": aid,
        "display_name": resolved or None,
        "worker_display_names": names,
    }


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


@router.get("/{conv_id}/workset")
async def get_workset_api(
    conv_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Case Workset («下一步») projection — open items ordered; survives Graph runs."""
    from app.services.case_workset import get_workset, project_workset_for_api

    c = await _get_conv(conv_id, current_user, db)
    ctx = c.context if isinstance(c.context, dict) else {}
    return project_workset_for_api(get_workset(ctx))


@router.patch("/{conv_id}/workset/{item_id}")
async def patch_workset_item(
    conv_id: str,
    item_id: str,
    body: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Host-gated Workset item update (status / in_progress baton). Agent cannot self-adopt.

    Spec #311: t_host adopt expands Scope.allow / assets (same spirit as next-scope);
    never mark t_host adopted without Scope update.

    User adopt (and in_progress=true 推进) takes the single in-progress baton and
    stamps expert(+Graph|Free) from Case task + Participant Session for US3 UI.
    """
    from app.services.case_workset import (
        adopt_item,
        annotation_fields_from_context,
        expand_task_scope_for_host,
        get_workset,
        host_expand_fields_from_item,
        project_workset_for_api,
        put_workset,
        scope_hosts_from_task,
        take_in_progress_baton,
        update_item_status,
    )

    c = await _get_conv(conv_id, current_user, db)
    ctx = dict(c.context or {}) if isinstance(c.context, dict) else {}
    ws = get_workset(ctx)
    task = dict(ctx.get("task") or {}) if isinstance(ctx.get("task"), dict) else {}
    scope_hosts = scope_hosts_from_task(task)
    status = str(body.get("status") or "").strip()
    actor = "user"  # HTTP path is always user-gated
    scope_expanded: dict | None = None
    registered_asset: dict | None = None
    # Explicit baton request (推进): body.in_progress true without status change.
    want_baton = body.get("in_progress") is True or body.get("in_progress") in ("true", "1", 1)

    if status == "adopted":
        target = next((i for i in ws["items"] if isinstance(i, dict) and str(i.get("id")) == item_id), None)
        if not target:
            raise HTTPException(400, "not_found")
        # t_host: expand Scope before/with adopt (confirm path). Refuse adopt if expand fails.
        expand_fields = host_expand_fields_from_item(target)
        if expand_fields:
            expanded_task, expand_err = expand_task_scope_for_host(
                task,
                host=expand_fields["host"],
                port=expand_fields.get("port"),
                urls=expand_fields.get("urls"),
            )
            if expand_err:
                raise HTTPException(400, f"scope_expand_failed:{expand_err}")
            task = expanded_task
            ctx["task"] = task
            scope_hosts = scope_hosts_from_task(task)
            scope_expanded = {
                "host": expand_fields["host"],
                "port": expand_fields.get("port"),
                "allow": (task.get("scope") or {}).get("allow"),
            }
            # Register asset (same spirit as POST next-scope; user confirm).
            register_assets = body.get("register_assets")
            if register_assets is None:
                register_assets = True
            if register_assets:
                try:
                    from app.api.assets import upsert_discovered_asset

                    user_id = uuid.UUID(current_user["user_id"])
                    port = expand_fields.get("port")
                    urls = expand_fields.get("urls") or []
                    asset = await upsert_discovered_asset(
                        db,
                        user_id=user_id,
                        address=expand_fields["host"],
                        open_ports=[port] if port else None,
                        urls=urls if urls else None,
                        port=port,
                        conversation_id=c.id,
                        source="user_workset_host_adopt",
                        allow_create=True,
                    )
                    if asset:
                        registered_asset = {"id": str(asset.id), "address": asset.address, "port": port}
                except Exception as e:
                    # Scope already expanded; asset registration failure must not orphan adopt.
                    print(f"[api] workset t_host asset register error: {e}")
        ws, item, err = adopt_item(ws, item_id, actor=actor, scope_hosts=scope_hosts)
        # Spec #311 US3: user adopt takes the in-progress baton so expert(+Graph) lights.
        if not err and item:
            ann = annotation_fields_from_context(ctx)
            ws, item, baton_err = take_in_progress_baton(
                ws,
                item_id,
                expert_id=ann.get("expert_id"),
                expert_name=ann.get("expert_name"),
                graph_id=ann.get("graph_id"),
                work_mode=ann.get("work_mode"),
                force=True,
            )
            if baton_err:
                err = baton_err
    elif status:
        ws, item, err = update_item_status(ws, item_id, status=status, actor=actor)
    else:
        item = next((i for i in ws["items"] if str(i.get("id")) == item_id), None)
        err = None if item else "not_found"
        if item and body.get("in_progress") is False:
            from app.services.case_workset import set_in_progress

            # Clear only this item if it holds the baton; leave others untouched.
            if item.get("in_progress"):
                ws = set_in_progress(ws, None)
                item = next((i for i in ws["items"] if str(i.get("id")) == item_id), item)
        elif item and want_baton:
            # 推进: switch baton to an already-adopted open item.
            ann = annotation_fields_from_context(ctx)
            ws, item, err = take_in_progress_baton(
                ws,
                item_id,
                expert_id=ann.get("expert_id"),
                expert_name=ann.get("expert_name"),
                graph_id=ann.get("graph_id"),
                work_mode=ann.get("work_mode"),
                force=True,
            )

    if err:
        raise HTTPException(400, err)
    c.context = put_workset(ctx, ws)
    await _audit(
        db,
        uuid.UUID(current_user["user_id"]),
        "conversation.workset_update",
        "conversation",
        c.id,
        c.id,
        {
            "item_id": item_id,
            "status": status or None,
            "scope_expanded": scope_expanded,
            "registered_asset": registered_asset,
        },
    )
    await db.commit()
    out: dict = {"ok": True, "item": item, "workset": project_workset_for_api(ws)}
    if scope_expanded:
        out["scope"] = {"allow": scope_expanded.get("allow") or [], "deny": (task.get("scope") or {}).get("deny") or []}
        out["scope_expanded"] = scope_expanded
    if registered_asset:
        out["registered_asset"] = registered_asset
    return out


@router.post("/{conv_id}/workset/reorder")
async def reorder_workset(
    conv_id: str,
    body: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """User reorder of open 下一步 items."""
    from app.services.case_workset import get_workset, project_workset_for_api, put_workset, reorder_items

    c = await _get_conv(conv_id, current_user, db)
    ctx = dict(c.context or {}) if isinstance(c.context, dict) else {}
    ordered_ids = body.get("ordered_ids") or body.get("ids") or []
    if not isinstance(ordered_ids, list):
        raise HTTPException(400, "ordered_ids must be a list")
    ws, err = reorder_items(get_workset(ctx), [str(x) for x in ordered_ids])
    if err:
        raise HTTPException(400, err)
    c.context = put_workset(ctx, ws)
    await db.commit()
    return {"ok": True, "workset": project_workset_for_api(ws)}


@router.post("/{conv_id}/next-scope")
async def start_next_scope(
    conv_id: str,
    body: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """User-selected next Scope from post-task attack-surface candidates.

    Body:
      hosts: [{host, port?, url?}, ...]  (required, non-empty)
      register_assets: bool (default true)
      instruction?: str
      engagement / pack_id / expert_id?: optional override (else sticky task)

    Registers selected hosts on the asset ledger (user action), updates task
    target/scope, and dispatches a **new** work burst — does not await mid-run.
    """
    from app.api.assets import upsert_discovered_asset
    from app.services.asset_ledger import is_valid_ledger_address, normalize_port, split_host_port
    from app.services.expert_offers import normalize_pack_id
    from app.ws import router as ws_router

    c = await _get_conv(conv_id, current_user, db)
    user_id = uuid.UUID(current_user["user_id"])
    raw_hosts = body.get("hosts") or body.get("candidates") or []
    if not isinstance(raw_hosts, list) or not raw_hosts:
        raise HTTPException(400, "hosts must be a non-empty list")

    register_assets = body.get("register_assets")
    if register_assets is None:
        register_assets = True

    scope_allow: list[str] = []
    registered: list[dict] = []
    primary_target: dict | None = None

    for item in raw_hosts:
        if isinstance(item, str):
            host, port = split_host_port(item)
            url = item if "://" in item else ""
        elif isinstance(item, dict):
            url = str(item.get("url") or "").strip()
            host, port = split_host_port(url or item.get("host") or item.get("address") or "")
            if not port:
                port = normalize_port(item.get("port"))
        else:
            continue
        if not host or not is_valid_ledger_address(host):
            continue
        allow_entry = url if url and "://" in url else (f"{host}:{port}" if port else host)
        if allow_entry not in scope_allow:
            scope_allow.append(allow_entry)
        if primary_target is None:
            primary_target = {
                "type": "url" if url and "://" in url else "host",
                "value": url if url and "://" in url else host,
            }
        if register_assets:
            asset = await upsert_discovered_asset(
                db,
                user_id=user_id,
                address=host,
                open_ports=[port] if port else None,
                urls=[url] if url and "://" in url else None,
                port=port,
                conversation_id=c.id,
                source="user_next_scope",
                allow_create=True,
            )
            if asset:
                registered.append({"id": str(asset.id), "address": asset.address, "port": port})

    if not scope_allow or not primary_target:
        raise HTTPException(400, "no valid hosts in selection")

    ctx = dict(c.context or {}) if isinstance(c.context, dict) else {}
    prev_task = ctx.get("task") if isinstance(ctx.get("task"), dict) else {}
    eng = str(
        body.get("engagement")
        or body.get("pack_id")
        or prev_task.get("engagement")
        or prev_task.get("role")
        or "pentest"
    ).strip()
    pack = normalize_pack_id(eng) or eng
    instruction = str(body.get("instruction") or "").strip() or (
        "Continue authorized security testing on the selected next-scope targets. "
        f"Scope allow: {', '.join(scope_allow)}."
    )
    expert_id = str(body.get("expert_id") or prev_task.get("expert_id") or "").strip() or None
    expert_name = str(body.get("expert_name") or prev_task.get("expert_name") or "").strip() or None

    task_blob = {
        "target": primary_target,
        "scope": {"allow": scope_allow, "deny": []},
        "instruction": instruction,
        "engagement": pack,
        "role": pack,
    }
    if expert_id:
        task_blob["expert_id"] = expert_id
    if expert_name:
        task_blob["expert_name"] = expert_name
    ctx["task"] = task_blob
    ctx["next_scope_suggested"] = False
    ctx["next_scope_candidates"] = []
    c.context = ctx

    await _audit(
        db,
        user_id,
        "conversation.next_scope",
        "conversation",
        c.id,
        c.id,
        {"hosts": scope_allow, "register_assets": bool(register_assets), "registered": registered, "pack": pack},
    )
    await db.commit()

    # Dispatch new work burst (same path as authorized handoff kickoff).
    node_id = str(c.node_id or "").strip()
    agent_node = str(body.get("agent_node_id") or node_id or "").strip()
    dispatch = {
        "type": "user_message",
        "conversation_id": conv_id,
        "text": instruction,
        "initial_instruction": instruction,
        "engagement": pack,
        "role": pack,
        "target": primary_target,
        "scope": {"allow": scope_allow, "deny": []},
        "expert_id": expert_id,
        "expert_name": expert_name,
        "agent_node_id": agent_node,
    }
    sent = False
    if agent_node:
        try:
            await ws_router._dispatch_task_assign_to_node(
                conv_id=conv_id,
                client_id=str(user_id),
                msg=dispatch,
                node_id=agent_node,
                engagement=pack,
                expert_id=expert_id,
                expert_name=expert_name,
                force_working=True,
            )
            sent = True
        except Exception as e:
            print(f"[api] next-scope dispatch error: {e}")
    return {
        "ok": True,
        "sent": sent,
        "scope": {"allow": scope_allow, "deny": []},
        "target": primary_target,
        "registered_assets": registered,
        "engagement": pack,
    }


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


def _active_expert_id(c: Conversation) -> str | None:
    """Resolve real expert_id only (Spec #354 L8 — never pack/engagement as expert key)."""
    ctx = c.context if isinstance(c.context, dict) else {}
    task = ctx.get("task") if isinstance(ctx.get("task"), dict) else {}
    eid = str(task.get("expert_id") or "").strip()
    return eid or None


def _open_todos_from_context(ctx: dict, expert_id: object = None) -> list:
    """Build incomplete Todo-phase snapshot from Case Tasks for handoff hold / seed."""
    from app.services.session_handoff import open_todo_phases_for_expert, open_todo_phases_from_plan_tree

    if expert_id is not None and str(expert_id or "").strip():
        return open_todo_phases_for_expert(ctx, expert_id)
    # No expert: flatten any participant / checkpoint tree still open.
    phases = open_todo_phases_for_expert(ctx, "")
    if phases:
        return phases
    tree = ctx.get("plan_tree") if isinstance(ctx.get("plan_tree"), list) else []
    if not tree:
        checkpoint = ctx.get("checkpoint") if isinstance(ctx.get("checkpoint"), dict) else {}
        tree = checkpoint.get("plan_tree") if isinstance(checkpoint.get("plan_tree"), list) else []
    return open_todo_phases_from_plan_tree(tree)

async def _notify_node_case_session_release(node_id: object, conversation_id: str) -> dict:
    """Spec #354: structured Case close → Node release all captains.

    Fire-and-forget deliver only (no ack wait). Case DELETE latency must not track
    docker sandbox dispose or mid-burst idle wait on Node.
    """
    nid = str(node_id or "").strip()
    if not nid:
        return {"delivered": False, "reason": "no_node"}
    return await _push_node_json(
        nid,
        {
            "type": "case_session_release",
            "conversation_id": conversation_id,
        },
        wait_ack=None,
        conversation_id=conversation_id,
    )


async def _notify_node_session_op(
    node_id: object,
    op: str,
    *,
    conversation_id: str,
    expert_id: str | None,
) -> dict:
    nid = str(node_id or "").strip()
    if not nid:
        return {"delivered": False, "reason": "no_node"}
    msg: dict = {
        "type": op,
        "conversation_id": conversation_id,
    }
    if expert_id:
        msg["expert_id"] = expert_id
    ack = "session_dispose_ack" if op == "session_dispose" else "session_reset_ack" if op == "session_reset" else None
    return await _push_node_json(
        nid,
        msg,
        wait_ack=ack,
        conversation_id=conversation_id,
        expert_id=expert_id,
        timeout_s=6.0,
    )


async def _push_node_json(
    node_id: str,
    msg: dict,
    *,
    wait_ack: str | None = None,
    conversation_id: str | None = None,
    expert_id: str | None = None,
    timeout_s: float = 5.0,
) -> dict:
    """Push to live node WebSocket; wait for Spec #354 lifecycle ack when requested.

    Waiter is registered **before** send so a fast Node ack cannot be dropped.
    """
    try:
        from app.ws import router as ws_router
    except Exception as e:
        return {"delivered": False, "reason": f"import:{e}"}
    ws = ws_router.node_connections.get(str(node_id))
    if not ws:
        return {"delivered": False, "reason": "offline"}

    waiter = None
    if wait_ack and conversation_id:
        try:
            waiter = ws_router.register_session_lifecycle_ack_waiter(
                ack_type=wait_ack,
                conversation_id=conversation_id,
                expert_id=expert_id,
            )
        except Exception as e:
            print(f"[api] register lifecycle waiter failed: {e}")

    try:
        await ws.send_text(json.dumps(msg, ensure_ascii=False))
    except Exception as e:
        print(f"[api] push_node_json failed node={str(node_id)[:8]} type={msg.get('type')}: {e}")
        if waiter is not None:
            try:
                ws_router.cancel_session_lifecycle_ack_waiter(
                    ack_type=wait_ack or "",
                    conversation_id=conversation_id or "",
                    expert_id=expert_id,
                )
            except Exception:
                pass
        return {"delivered": False, "reason": str(e)}

    if waiter is None or not wait_ack or not conversation_id:
        return {"delivered": True}
    try:
        ack = await ws_router.await_session_lifecycle_ack(waiter, timeout_s=timeout_s)
        if ack is None:
            return {"delivered": True, "ack": None, "ack_timeout": True}
        return {"delivered": True, "ack": ack}
    except Exception as e:
        return {"delivered": True, "ack_error": str(e)}
