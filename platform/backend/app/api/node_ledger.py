"""Node-token ledger API for workspace assistant tools."""
from __future__ import annotations

import hashlib
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.models.conversation import Conversation
from app.models.node import Node
from app.services import node_ledger as ledger
from app.services.conversation_reports import create_report, list_reports, report_to_dict

router = APIRouter(prefix="/api/node/ledger", tags=["node-ledger"])


async def get_node_from_token(
    request: Request,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
    x_node_token: str | None = Header(default=None, alias="X-Node-Token"),
) -> Node:
    token = ""
    if x_node_token:
        token = str(x_node_token).strip()
    elif authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        raise HTTPException(401, "node token required")
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    result = await db.execute(select(Node).where(Node.token_hash == token_hash))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(401, "invalid node token")
    return node


async def _user_for_conversation(db: AsyncSession, conversation_id: str | None) -> uuid.UUID | None:
    return await ledger.conversation_user_id(db, conversation_id)


@router.get("/assets")
async def list_assets(
    conversation_id: str | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    node: Node = Depends(get_node_from_token),
    x_conversation_id: str | None = Header(default=None, alias="X-Conversation-Id"),
):
    _ = node
    cid = conversation_id or x_conversation_id
    user_id = await _user_for_conversation(db, cid)
    items = await ledger.list_assets(db, user_id=user_id, conversation_id=cid, q=q, limit=limit)
    return {"ok": True, "assets": items, "count": len(items)}


@router.get("/assets/{asset_id}")
async def get_asset(
    asset_id: str,
    conversation_id: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    node: Node = Depends(get_node_from_token),
    x_conversation_id: str | None = Header(default=None, alias="X-Conversation-Id"),
):
    _ = node
    cid = conversation_id or x_conversation_id
    user_id = await _user_for_conversation(db, cid)
    try:
        item = await ledger.get_asset(db, asset_id, user_id=user_id)
    except ledger.NodeLedgerError as e:
        raise HTTPException(e.status_code, e.message) from e
    return {"ok": True, "asset": item}


@router.post("/assets/{asset_id}/enrich")
async def enrich_asset(
    asset_id: str,
    body: dict,
    conversation_id: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    node: Node = Depends(get_node_from_token),
    x_conversation_id: str | None = Header(default=None, alias="X-Conversation-Id"),
):
    _ = node
    cid = conversation_id or x_conversation_id
    user_id = await _user_for_conversation(db, cid)
    # Explicitly reject host create attempts
    deny = ledger.deny_host_create_payload(body if isinstance(body, dict) else None)
    if deny:
        raise HTTPException(403, deny)
    try:
        item = await ledger.enrich_existing_asset(db, asset_id, user_id=user_id, body=body if isinstance(body, dict) else {})
    except ledger.NodeLedgerError as e:
        raise HTTPException(e.status_code, e.message) from e
    return {"ok": True, "asset": item}


@router.post("/assets")
async def create_asset_denied(
    body: dict | None = None,
    node: Node = Depends(get_node_from_token),
):
    """Hard deny: agents must not create host rows via node ledger API."""
    _ = node
    _ = body
    raise HTTPException(403, "host create denied: only users may create host assets")


@router.get("/experts")
async def list_experts_for_node(
    enabled_only: bool = Query(default=True),
    db: AsyncSession = Depends(get_db),
    node: Node = Depends(get_node_from_token),
):
    """Product experts for handoff discovery (Node-authenticated)."""
    _ = node
    items = await ledger.list_experts(db, enabled_only=enabled_only)
    packs = sorted({str(i.get("pack_id") or "") for i in items if i.get("pack_id")})
    return {
        "ok": True,
        "experts": items,
        "count": len(items),
        "pack_ids": packs,
        "can_handoff": len(items) > 0,
        "note": (
            "Use these rows for request_user_decision(kind=handoff). "
            "If can_handoff is false, only the default seat exists — stay in chat/ledger or ask the user to create an Expert."
        ),
    }


@router.get("/vulnerabilities")
async def list_vulns(
    conversation_id: str | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    node: Node = Depends(get_node_from_token),
    x_conversation_id: str | None = Header(default=None, alias="X-Conversation-Id"),
):
    _ = node
    cid = conversation_id or x_conversation_id
    user_id = await _user_for_conversation(db, cid)
    items = await ledger.list_vulnerabilities(
        db, user_id=user_id, conversation_id=cid, status=status, limit=limit
    )
    return {"ok": True, "vulnerabilities": items, "count": len(items)}


@router.get("/vulnerabilities/{vulnerability_id}")
async def get_vuln(
    vulnerability_id: str,
    conversation_id: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    node: Node = Depends(get_node_from_token),
    x_conversation_id: str | None = Header(default=None, alias="X-Conversation-Id"),
):
    _ = node
    cid = conversation_id or x_conversation_id
    user_id = await _user_for_conversation(db, cid)
    try:
        item = await ledger.get_vulnerability(db, vulnerability_id, user_id=user_id)
    except ledger.NodeLedgerError as e:
        raise HTTPException(e.status_code, e.message) from e
    return {"ok": True, "vulnerability": item}


@router.patch("/vulnerabilities/{vulnerability_id}")
async def patch_vuln(
    vulnerability_id: str,
    body: dict,
    conversation_id: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    node: Node = Depends(get_node_from_token),
    x_conversation_id: str | None = Header(default=None, alias="X-Conversation-Id"),
):
    _ = node
    cid = conversation_id or x_conversation_id
    user_id = await _user_for_conversation(db, cid)
    status = body.get("status") if isinstance(body, dict) else None
    try:
        item = await ledger.update_finding_status(
            db, vulnerability_id, status=str(status or ""), user_id=user_id
        )
    except ledger.NodeLedgerError as e:
        raise HTTPException(e.status_code, e.message) from e
    return {"ok": True, "vulnerability": item}


@router.get("/conversations/{conversation_id}/snapshot")
async def conversation_snapshot(
    conversation_id: str,
    db: AsyncSession = Depends(get_db),
    node: Node = Depends(get_node_from_token),
):
    try:
        snap = await ledger.conversation_snapshot(
            db, conversation_id, node_id=str(node.id)
        )
    except ledger.NodeLedgerError as e:
        raise HTTPException(e.status_code, e.message) from e
    return {"ok": True, "snapshot": snap}


@router.get("/conversations/{conversation_id}/reports")
async def list_conversation_reports_node(
    conversation_id: str,
    limit: int = Query(default=50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    node: Node = Depends(get_node_from_token),
):
    """List delivery report revisions for the conversation (node tools)."""
    _ = node
    user_id = await _user_for_conversation(db, conversation_id)
    if not user_id:
        raise HTTPException(404, "conversation not found")
    try:
        cid = uuid.UUID(conversation_id)
    except ValueError as e:
        raise HTTPException(400, "invalid conversation id") from e
    rows = await list_reports(db, conversation_id=cid, user_id=user_id, limit=limit)
    return {"ok": True, "reports": [report_to_dict(r) for r in rows], "count": len(rows)}


@router.post("/conversations/{conversation_id}/reports")
async def create_conversation_report_node(
    conversation_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    node: Node = Depends(get_node_from_token),
):
    """Agent creates a delivery report revision from authored markdown + findings data."""
    user_id = await _user_for_conversation(db, conversation_id)
    if not user_id:
        raise HTTPException(404, "conversation not found")
    try:
        cid = uuid.UUID(conversation_id)
    except ValueError as e:
        raise HTTPException(400, "invalid conversation id") from e
    # Ensure conversation exists
    result = await db.execute(select(Conversation).where(Conversation.id == cid, Conversation.user_id == user_id))
    if not result.scalar_one_or_none():
        raise HTTPException(404, "conversation not found")

    body = body if isinstance(body, dict) else {}
    title = str(body.get("title") or "").strip() or "Security Assessment Report"
    markdown = str(body.get("markdown") or body.get("body") or "").strip()
    summary = str(body.get("summary") or "").strip() or None
    finding_ids_raw = body.get("finding_ids") or body.get("vulnerability_ids") or []
    finding_ids = [str(x) for x in finding_ids_raw if x] if isinstance(finding_ids_raw, list) else []
    created_by = str(body.get("created_by") or node.name or node.id or "node")[:255]
    try:
        row = await create_report(
            db,
            conversation_id=cid,
            user_id=user_id,
            title=title,
            markdown=markdown,
            summary=summary,
            source="agent",
            created_by=created_by,
            finding_ids=finding_ids,
            meta=body.get("meta") if isinstance(body.get("meta"), dict) else {"node_id": str(node.id)},
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "report": report_to_dict(row, include_markdown=False)}
