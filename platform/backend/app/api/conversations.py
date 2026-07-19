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
    conv_dict = {
        "id": str(c.id),
        "title": c.title,
        "status": c.status,
        "task": task,
        "engagement": task.get("engagement") or task.get("role"),
        "target": task.get("target"),
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
    await db.execute(delete(Message).where(Message.conversation_id == conversation_id))
    await db.execute(delete(Evidence).where(Evidence.conversation_id == conversation_id))
    # Vulnerability + asset ledgers are user-owned and long-lived: do not cascade-delete.
    # Unbind conversation so rediscovered findings and history remain.
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
