"""Node-authenticated ledger access for workspace assistant tools.

Hosts: user-only create (enrich existing only).
Vulnerabilities: list/get + management status transitions.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.conversation import Conversation
from app.models.vulnerability import Vulnerability
from app.services.asset_ledger import (
    extract_services,
    merge_discover_properties,
    normalize_port,
)

# Management lifecycle (same as vulnerabilities API)
ALLOWED_STATUSES = frozenset({"to_fix", "fixing", "fixed"})
LEGACY_STATUS_MAP = {
    "pending": "to_fix",
    "open": "to_fix",
    "confirmed": "to_fix",
    "candidate": "to_fix",
    "in_progress": "fixing",
    "retest": "fixing",
    "reported": "fixing",
    "fixed": "fixed",
    "closed": "fixed",
    "to_fix": "to_fix",
    "fixing": "fixing",
}


class NodeLedgerError(Exception):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def normalize_finding_status(raw: object) -> str | None:
    key = str(raw or "").strip().lower()
    if not key:
        return None
    mapped = LEGACY_STATUS_MAP.get(key, key)
    return mapped if mapped in ALLOWED_STATUSES else None


def deny_host_create_payload(body: dict | None) -> str | None:
    """Return error message if payload attempts to create a host; else None."""
    if not isinstance(body, dict):
        return None
    if body.get("create_host") is True or body.get("create") is True:
        return "host create denied: only users may create host assets"
    # Explicit create endpoint simulation
    if str(body.get("op") or "").lower() in {"create_asset", "create_host", "add_host"}:
        return "host create denied: only users may create host assets"
    return None


async def conversation_user_id(db: AsyncSession, conversation_id: str | None) -> uuid.UUID | None:
    if not conversation_id:
        return None
    try:
        cid = uuid.UUID(str(conversation_id))
    except ValueError:
        return None
    result = await db.execute(select(Conversation).where(Conversation.id == cid))
    conv = result.scalar_one_or_none()
    return conv.user_id if conv else None


def asset_to_dict(a: Asset) -> dict[str, Any]:
    props = a.properties if isinstance(a.properties, dict) else {}
    return {
        "id": str(a.id),
        "name": a.name,
        "address": a.address,
        "type": a.type,
        "tags": list(a.tags or []),
        "properties": props,
        "services": extract_services(props),
        "source": a.source,
        "conversation_id": str(a.conversation_id) if a.conversation_id else None,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "updated_at": a.updated_at.isoformat() if a.updated_at else None,
    }


def vuln_to_dict(v: Vulnerability) -> dict[str, Any]:
    from app.services.finding_dedupe import discovery_count, rediscovery_count

    history = getattr(v, "history", None)
    rcount = rediscovery_count(history)
    return {
        "id": str(v.id),
        "title": v.title,
        "severity": v.severity,
        "status": v.status,
        "status_normalized": normalize_finding_status(v.status) or str(v.status or ""),
        "asset_id": str(v.asset_id) if v.asset_id else None,
        "port": v.port,
        "conversation_id": str(v.conversation_id) if v.conversation_id else None,
        "description": v.description,
        "poc": (v.poc or "")[:500] if getattr(v, "poc", None) else None,
        "cve_id": v.cve_id,
        "cvss": v.cvss,
        "first_seen_at": (
            v.first_seen_at.isoformat()
            if getattr(v, "first_seen_at", None)
            else (v.discovered_at.isoformat() if v.discovered_at else None)
        ),
        "discovered_at": v.discovered_at.isoformat() if v.discovered_at else None,
        "updated_at": v.updated_at.isoformat() if v.updated_at else None,
        "rediscovery_count": rcount,
        "discovery_count": discovery_count(history),
        "multiple_discoveries": rcount > 0,
    }


async def list_assets(
    db: AsyncSession,
    *,
    user_id: uuid.UUID | None,
    conversation_id: str | None = None,
    q: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit or 50), 100))
    stmt = select(Asset).order_by(Asset.updated_at.desc()).limit(limit)
    if user_id:
        stmt = stmt.where(or_(Asset.user_id == user_id, Asset.user_id.is_(None)))
    if q and str(q).strip():
        like = f"%{str(q).strip()}%"
        stmt = stmt.where(or_(Asset.address.ilike(like), Asset.name.ilike(like)))
    result = await db.execute(stmt)
    return [asset_to_dict(a) for a in result.scalars().all()]


async def get_asset(db: AsyncSession, asset_id: str, *, user_id: uuid.UUID | None) -> dict[str, Any]:
    try:
        aid = uuid.UUID(str(asset_id))
    except ValueError as e:
        raise NodeLedgerError("invalid asset_id", status_code=400) from e
    result = await db.execute(select(Asset).where(Asset.id == aid))
    a = result.scalar_one_or_none()
    if not a:
        raise NodeLedgerError("asset not found", status_code=404)
    if user_id and a.user_id and a.user_id != user_id:
        raise NodeLedgerError("asset not found", status_code=404)
    return asset_to_dict(a)


async def list_experts(
    db: AsyncSession,
    *,
    enabled_only: bool = True,
) -> list[dict[str, Any]]:
    """Product experts available for structured handoff (pack + id + name + node)."""
    from app.models.expert import Expert
    from app.models.node import Node
    from app.services.expert_offers import effective_offers

    stmt = select(Expert).order_by(Expert.created_at.desc())
    if enabled_only:
        stmt = stmt.where(Expert.enabled.is_(True))
    experts = list((await db.execute(stmt)).scalars().all())
    node_ids = {e.node_id for e in experts if e.node_id}
    nodes: dict = {}
    if node_ids:
        nres = await db.execute(select(Node).where(Node.id.in_(node_ids)))
        nodes = {n.id: n for n in nres.scalars().all()}
    out: list[dict[str, Any]] = []
    for e in experts:
        n = nodes.get(e.node_id)
        out.append(
            {
                "id": str(e.id),
                "name": e.name,
                "pack_id": str(e.pack_id or "").strip(),
                "enabled": bool(e.enabled),
                "node_id": str(e.node_id) if e.node_id else None,
                "node_name": n.name if n else None,
                "node_status": n.status if n else None,
                "node_online": bool(n and str(getattr(n, "status", "") or "").lower() == "online"),
            }
        )
    return out


async def list_vulnerabilities(
    db: AsyncSession,
    *,
    user_id: uuid.UUID | None,
    conversation_id: str | None = None,
    status: str | None = None,
    limit: int = 50,
    conversation_only: bool = False,
) -> list[dict[str, Any]]:
    """
    List ledger findings for agent tools.

    Default: **user-wide** (all Cases) so experts can see prior findings on the
    same asset before booking and treat matches as rediscovery — not only this
    conversation's rows. Pass conversation_only=True to restrict.
    """
    limit = max(1, min(int(limit or 50), 100))
    stmt = select(Vulnerability).order_by(Vulnerability.updated_at.desc()).limit(limit)
    if user_id:
        stmt = stmt.where(or_(Vulnerability.user_id == user_id, Vulnerability.user_id.is_(None)))
    if conversation_only and conversation_id:
        try:
            cid = uuid.UUID(str(conversation_id))
            stmt = stmt.where(
                or_(Vulnerability.conversation_id == cid, Vulnerability.conversation_id.is_(None))
            )
        except ValueError:
            pass
    if status and str(status).strip():
        want = normalize_finding_status(status) or str(status).strip().lower()
        stmt = stmt.where(Vulnerability.status == want)
    result = await db.execute(stmt)
    return [vuln_to_dict(v) for v in result.scalars().all()]


async def get_vulnerability(db: AsyncSession, vulnerability_id: str, *, user_id: uuid.UUID | None) -> dict[str, Any]:
    try:
        vid = uuid.UUID(str(vulnerability_id))
    except ValueError as e:
        raise NodeLedgerError("invalid vulnerability_id", status_code=400) from e
    result = await db.execute(select(Vulnerability).where(Vulnerability.id == vid))
    v = result.scalar_one_or_none()
    if not v:
        raise NodeLedgerError("vulnerability not found", status_code=404)
    if user_id and v.user_id and v.user_id != user_id:
        raise NodeLedgerError("vulnerability not found", status_code=404)
    return vuln_to_dict(v)


async def update_finding_status(
    db: AsyncSession,
    vulnerability_id: str,
    *,
    status: str,
    user_id: uuid.UUID | None,
) -> dict[str, Any]:
    mapped = normalize_finding_status(status)
    if not mapped:
        raise NodeLedgerError("status must be to_fix | fixing | fixed", status_code=400)
    try:
        vid = uuid.UUID(str(vulnerability_id))
    except ValueError as e:
        raise NodeLedgerError("invalid vulnerability_id", status_code=400) from e
    result = await db.execute(select(Vulnerability).where(Vulnerability.id == vid))
    v = result.scalar_one_or_none()
    if not v:
        raise NodeLedgerError("vulnerability not found", status_code=404)
    if user_id and v.user_id and v.user_id != user_id:
        raise NodeLedgerError("vulnerability not found", status_code=404)
    v.status = mapped
    await db.commit()
    await db.refresh(v)
    return vuln_to_dict(v)


async def enrich_existing_asset(
    db: AsyncSession,
    asset_id: str,
    *,
    user_id: uuid.UUID | None,
    body: dict | None,
) -> dict[str, Any]:
    deny = deny_host_create_payload(body)
    if deny:
        raise NodeLedgerError(deny, status_code=403)
    if not isinstance(body, dict):
        raise NodeLedgerError("body required", status_code=400)
    if not str(body.get("asset_id") or asset_id or "").strip():
        raise NodeLedgerError("asset_id required; cannot create hosts", status_code=403)
    try:
        aid = uuid.UUID(str(asset_id or body.get("asset_id")))
    except ValueError as e:
        raise NodeLedgerError("invalid asset_id", status_code=400) from e
    result = await db.execute(select(Asset).where(Asset.id == aid))
    a = result.scalar_one_or_none()
    if not a:
        raise NodeLedgerError("asset not found — users create hosts; agent may only enrich", status_code=404)
    if user_id and a.user_id and a.user_id != user_id:
        raise NodeLedgerError("asset not found", status_code=404)

    ports = body.get("ports") or body.get("open_ports")
    services = body.get("services")
    urls = body.get("urls")
    apis = body.get("api_endpoints")

    port_list: list[str] = []
    if isinstance(ports, list):
        for p in ports:
            if isinstance(p, dict):
                np = normalize_port(p.get("port") or p.get("value"))
            else:
                np = normalize_port(p)
            if np:
                port_list.append(np)

    service_list: list[dict] = []
    if isinstance(services, list):
        for s in services:
            if isinstance(s, dict):
                service_list.append(s)
            else:
                service_list.append({"name": str(s)})

    url_list = [str(u) for u in urls] if isinstance(urls, list) else None
    api_list = apis if isinstance(apis, list) else None

    props = dict(a.properties) if isinstance(a.properties, dict) else {}
    a.properties = merge_discover_properties(
        props,
        open_ports=port_list or None,
        services=service_list or None,
        urls=url_list,
        api_endpoints=api_list,
    )
    await db.commit()
    await db.refresh(a)
    return asset_to_dict(a)


async def conversation_snapshot(
    db: AsyncSession,
    conversation_id: str,
    *,
    node_id: str | None = None,
) -> dict[str, Any]:
    try:
        cid = uuid.UUID(str(conversation_id))
    except ValueError as e:
        raise NodeLedgerError("invalid conversation_id", status_code=400) from e
    result = await db.execute(select(Conversation).where(Conversation.id == cid))
    conv = result.scalar_one_or_none()
    if not conv:
        raise NodeLedgerError("conversation not found", status_code=404)

    user_id = conv.user_id
    vulns = await list_vulnerabilities(db, user_id=user_id, conversation_id=str(cid), limit=20)
    assets = await list_assets(db, user_id=user_id, conversation_id=str(cid), limit=20)
    ctx = conv.context if isinstance(conv.context, dict) else {}
    return {
        "conversation_id": str(conv.id),
        "status": conv.status,
        "node_id": str(conv.node_id) if conv.node_id else None,
        "title": conv.title,
        "counts": {
            "assets": len(assets),
            "vulnerabilities": len(vulns),
        },
        "recent_vulnerabilities": vulns[:10],
        "recent_assets": assets[:10],
        "task": ctx.get("task") if isinstance(ctx.get("task"), dict) else {},
        "checkpoint_status": (
            (ctx.get("checkpoint") or {}).get("status")
            if isinstance(ctx.get("checkpoint"), dict)
            else None
        ),
    }
