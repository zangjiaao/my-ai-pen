"""Asset API — one host (IP/domain) per asset, ports+services+urls, tags for grouping.

Ownership: users create/delete host rows. Agents only enrich surface fields
(ports, services, URLs, API endpoints) on hosts that already exist.
"""
from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.audit import AuditLog
from app.models.vulnerability import Vulnerability
from app.models.conversation import Conversation
from app.services.asset_ledger import (
    apply_discover_to_asset_fields,
    conversation_target_blobs,
    enrich_properties_ports,
    extract_api_endpoints,
    extract_ports,
    extract_services,
    extract_urls,
    infer_asset_type,
    is_valid_ledger_address,
    merge_discover_properties,
    merge_tags,
    normalize_address,
    normalize_port,
    normalize_tags,
    ports_summary,
    render_remediation_html,
    render_remediation_markdown,
    risk_summary_from_vulns,
    source_label,
    split_host_port,
    tech_summary,
    type_label,
)

router = APIRouter(prefix="/api/assets", tags=["assets"])


class AssetCreate(BaseModel):
    """Create/merge one host asset. Address is a single IP or domain."""
    address: str
    name: str | None = None
    tags: list[str] = Field(default_factory=list)
    # Optional initial ports (services without names).
    ports: list[str | int] = Field(default_factory=list)
    properties: dict = Field(default_factory=dict)


class AssetUpdate(BaseModel):
    name: str | None = None
    address: str | None = None
    tags: list[str] | None = None
    # Full replace of port/service list when provided.
    services: list[dict] | None = None


class RelatedVulnOut(BaseModel):
    id: str
    title: str
    severity: str
    status: str
    confidence: str
    port: str | None = None
    description: str | None = None
    remediation: str | None = None
    discovered_at: str | None = None
    updated_at: str | None = None


class RiskSummaryOut(BaseModel):
    open_total: int = 0
    by_severity: dict = Field(default_factory=dict)
    highest: str = "none"
    label: str = "无开放漏洞"


class ServiceOut(BaseModel):
    port: str
    name: str = ""
    protocol: str | None = None
    product: str | None = None
    version: str | None = None
    url: str | None = None
    # User/agent notes about this port — helps agents understand service context.
    note: str | None = None


class ApiEndpointOut(BaseModel):
    method: str | None = None
    path: str | None = None
    url: str | None = None
    name: str | None = None


class AssetOut(BaseModel):
    id: str
    user_id: str | None = None
    conversation_id: str | None = None
    node_id: str | None = None
    name: str
    address: str
    type: str
    type_label: str = ""
    tags: list[str] = Field(default_factory=list)
    properties: dict = Field(default_factory=dict)
    source: str
    source_label: str = ""
    open_ports: list[str] = Field(default_factory=list)
    services: list[ServiceOut] = Field(default_factory=list)
    urls: list[str] = Field(default_factory=list)
    api_endpoints: list[ApiEndpointOut] = Field(default_factory=list)
    ports_summary: str = ""
    tech_summary: str = ""
    risk: RiskSummaryOut = Field(default_factory=RiskSummaryOut)
    related_vulnerabilities: list[RelatedVulnOut] = Field(default_factory=list)
    created_at: str | None
    updated_at: str | None
    model_config = {"from_attributes": True}


def _split_multi(values: list[str] | None) -> list[str]:
    out: list[str] = []
    for raw in values or []:
        for part in str(raw).split(","):
            part = part.strip()
            if part:
                out.append(part)
    return out


@router.get("", response_model=list[AssetOut])
async def list_assets(
    tag: list[str] | None = Query(None, description="Multi tags (any match)"),
    port: list[str] | None = Query(None, description="Multi ports (any match)"),
    service: list[str] | None = Query(None, description="Multi service names (any match, case-insensitive)"),
    search: str | None = Query(None),
    limit: int = 100,
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    q = select(Asset).where(Asset.user_id == user_id)
    if search:
        q = q.where(or_(Asset.name.ilike(f"%{search}%"), Asset.address.ilike(f"%{search}%")))
    q = q.order_by(Asset.updated_at.desc())
    # Load broader set when filtering by tag/port/service (applied after hydrate).
    result = await db.execute(q.limit(min(2000, max(limit + offset, 500))))
    assets = list(result.scalars().all())

    related = await _related_vulns(db, user_id, [a.id for a in assets])
    await _hydrate_asset_ports(db, assets, related)

    tags_want = {t.strip().lower() for t in _split_multi(tag) if t.strip()}
    if tags_want:
        assets = [
            a
            for a in assets
            if any(str(t).strip().lower() in tags_want for t in (a.tags or []))
        ]

    ports_want = {normalize_port(p) for p in _split_multi(port)}
    ports_want.discard(None)
    if ports_want:
        assets = [
            a
            for a in assets
            if ports_want & set(extract_ports(a.properties or {}))
        ]

    services_want = {s.strip().lower() for s in _split_multi(service) if s.strip()}
    if services_want:
        filtered: list[Asset] = []
        for a in assets:
            names = {
                str(s.get("name") or s.get("service") or s.get("product") or "").strip().lower()
                for s in extract_services(a.properties or {})
            }
            names.discard("")
            if names & services_want:
                filtered.append(a)
        assets = filtered

    assets = assets[offset : offset + limit]
    # related may be broader; re-key for page slice
    page_related = {a.id: related.get(a.id, []) for a in assets}
    return [_out(a, page_related.get(a.id, [])) for a in assets]


@router.get("/tags", response_model=list[str])
async def list_asset_tags(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Distinct tags used on this user's assets (for filter / autocomplete)."""
    user_id = uuid.UUID(current_user["user_id"])
    result = await db.execute(select(Asset).where(Asset.user_id == user_id))
    tags: set[str] = set()
    for a in result.scalars().all():
        for t in a.tags or []:
            text = str(t).strip()
            if text:
                tags.add(text)
    return sorted(tags, key=lambda x: x.lower())


@router.get("/ports", response_model=list[str])
async def list_asset_ports(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Distinct open ports across the user's asset ledger."""
    user_id = uuid.UUID(current_user["user_id"])
    result = await db.execute(select(Asset).where(Asset.user_id == user_id))
    assets = list(result.scalars().all())
    related = await _related_vulns(db, user_id, [a.id for a in assets])
    await _hydrate_asset_ports(db, assets, related)
    ports: set[str] = set()
    for a in assets:
        for p in extract_ports(a.properties or {}):
            if p:
                ports.add(str(p))
    return sorted(ports, key=lambda x: (0, int(x)) if x.isdigit() else (1, x))


@router.get("/services", response_model=list[str])
async def list_asset_services(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Distinct service names across the user's asset ledger."""
    user_id = uuid.UUID(current_user["user_id"])
    result = await db.execute(select(Asset).where(Asset.user_id == user_id))
    assets = list(result.scalars().all())
    related = await _related_vulns(db, user_id, [a.id for a in assets])
    await _hydrate_asset_ports(db, assets, related)
    names: set[str] = set()
    for a in assets:
        for s in extract_services(a.properties or {}):
            name = str(s.get("name") or s.get("service") or s.get("product") or "").strip()
            if name:
                names.add(name)
    return sorted(names, key=lambda x: x.lower())


@router.post("", response_model=AssetOut)
async def create_asset(
    body: AssetCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    if not is_valid_ledger_address(body.address):
        raise HTTPException(400, "地址无效：请填写一个 IP 或域名")
    host, addr_port = split_host_port(body.address)
    if not host:
        raise HTTPException(400, "地址无效：无法解析为 IP 或域名")

    existing = await db.execute(
        select(Asset).where(Asset.user_id == user_id, Asset.address == host)
    )
    a = existing.scalar_one_or_none()
    tags = normalize_tags(body.tags)
    ports = list(body.ports or [])
    if addr_port:
        ports.append(addr_port)

    if a:
        a.name = (body.name or "").strip() or a.name or host
        a.tags = merge_tags(a.tags, tags)
        a.properties = merge_discover_properties(
            a.properties,
            open_ports=ports or None,
            services=(body.properties or {}).get("services"),
        )
        await _audit(db, user_id, "asset.update", "asset", a.id, {"address": a.address, "merged": True})
    else:
        props = merge_discover_properties(
            body.properties or {},
            open_ports=ports or [],
            services=(body.properties or {}).get("services"),
        )
        a = Asset(
            id=uuid.uuid4(),
            user_id=user_id,
            name=(body.name or "").strip() or host,
            address=host,
            type=infer_asset_type(host),
            tags=tags,
            properties=props,
            source="manual",
        )
        db.add(a)
        await db.flush()
        await _audit(db, user_id, "asset.create", "asset", a.id, {"address": a.address})
    await db.commit()
    await db.refresh(a)
    related = await _related_vulns(db, user_id, [a.id])
    return _out(a, related.get(a.id, []))


@router.get("/{asset_id}/export")
async def export_asset_remediation(
    asset_id: str,
    format: str = Query("markdown", pattern="^(markdown|md|html)$"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    a = await _get(asset_id, current_user, db)
    related = await _related_vulns(db, user_id, [a.id], include_detail=True)
    await _hydrate_asset_ports(db, [a], related)
    vulns = [
        {
            "id": v.id,
            "title": v.title,
            "severity": v.severity,
            "status": v.status,
            "confidence": v.confidence,
            "port": v.port,
            "description": v.description,
            "remediation": v.remediation,
        }
        for v in related.get(a.id, [])
    ]
    asset_dict = {
        "id": str(a.id),
        "name": a.name,
        "address": a.address,
        "type": a.type,
        "source": a.source,
        "tags": a.tags or [],
        "properties": a.properties or {},
    }
    basename = _safe_filename(f"{a.name or a.address}-{str(a.id)[:8]}-remediation")
    if format == "html":
        body = render_remediation_html(asset_dict, vulns)
        return Response(
            content=body,
            media_type="text/html; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{basename}.html"'},
        )
    body = render_remediation_markdown(asset_dict, vulns)
    return Response(
        content=body,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{basename}.md"'},
    )


@router.get("/{asset_id}", response_model=AssetOut)
async def get_asset(
    asset_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    a = await _get(asset_id, current_user, db)
    related = await _related_vulns(db, user_id, [a.id], include_detail=True)
    await _hydrate_asset_ports(db, [a], related)
    return _out(a, related.get(a.id, []))


@router.patch("/{asset_id}", response_model=AssetOut)
async def update_asset(
    asset_id: str,
    body: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    a = await _get(asset_id, current_user, db)

    if "name" in body and body["name"] is not None:
        a.name = str(body["name"]).strip() or a.address

    if "tags" in body:
        a.tags = normalize_tags(body.get("tags"))

    if "address" in body and body["address"] is not None:
        if not is_valid_ledger_address(body["address"]):
            raise HTTPException(400, "地址无效：请填写一个 IP 或域名")
        host, _ = split_host_port(body["address"])
        if not host:
            raise HTTPException(400, "地址无效：无法解析为 IP 或域名")
        # Enforce uniqueness: one host = one asset.
        clash = await db.execute(
            select(Asset).where(
                Asset.user_id == user_id,
                Asset.address == host,
                Asset.id != a.id,
            )
        )
        if clash.scalar_one_or_none():
            raise HTTPException(409, f"已存在地址为 {host} 的资产")
        a.address = host
        a.type = infer_asset_type(host)
        if not a.name or a.name == normalize_address(body.get("address") or ""):
            a.name = host

    if "services" in body and isinstance(body["services"], list):
        # Merge into existing so agent rediscover fields + other ports stay.
        # Used for manual add/update of ports (port, name, note, …).
        a.properties = merge_discover_properties(
            a.properties,
            services=body["services"],
            open_ports=[s.get("port") for s in body["services"] if isinstance(s, dict)],
        )
    elif "port_notes" in body and isinstance(body["port_notes"], dict):
        # Partial update: { "52799": "CTF web, 9 levels", "22": "SSH bastion" }
        props = dict(a.properties or {})
        services = extract_services(props)
        by_port: dict[str, dict] = {
            str(s.get("port")): dict(s) for s in services if s.get("port")
        }
        for raw_port, raw_note in body["port_notes"].items():
            p = normalize_port(raw_port)
            if not p:
                continue
            svc = by_port.get(p) or {"port": p, "name": ""}
            text = str(raw_note or "").strip()
            svc["note"] = text  # empty clears
            by_port[p] = svc
        a.properties = merge_discover_properties(
            props,
            services=list(by_port.values()),
            open_ports=list(by_port.keys()),
        )
    if "remove_ports" in body and isinstance(body["remove_ports"], list):
        # Manual maintenance: drop selected ports from the host ledger.
        props = dict(a.properties or {})
        drop = {normalize_port(p) for p in body["remove_ports"]}
        drop.discard(None)
        if drop:
            kept = [
                dict(s)
                for s in extract_services(props)
                if normalize_port(s.get("port")) not in drop
            ]
            props["services"] = kept
            props["open_ports"] = [
                str(s.get("port")) for s in kept if s.get("port")
            ]
            # Drop legacy bare ports list if present.
            if "ports" in props:
                props["ports"] = [
                    p for p in (props.get("ports") or []) if normalize_port(p) not in drop
                ]
            a.properties = props
    elif (
        "properties" in body
        and isinstance(body["properties"], dict)
        and "services" not in body
        and "port_notes" not in body
        and "remove_ports" not in body
    ):
        # Allow limited properties patch; always re-normalize services.
        props = dict(body["properties"])
        a.properties = merge_discover_properties(
            props,
            open_ports=props.get("open_ports"),
            services=props.get("services"),
        )

    await _audit(db, user_id, "asset.update", "asset", a.id, {"fields": sorted(body.keys())})
    await db.commit()
    await db.refresh(a)
    related = await _related_vulns(db, user_id, [a.id])
    return _out(a, related.get(a.id, []))


@router.delete("/{asset_id}")
async def delete_asset(
    asset_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import delete as sa_delete, update
    from sqlalchemy.exc import IntegrityError, SQLAlchemyError

    user_id = uuid.UUID(current_user["user_id"])
    a = await _get(asset_id, current_user, db)
    address = str(a.address or "")
    asset_uuid = a.id

    try:
        unlink_result = await db.execute(
            update(Vulnerability)
            .where(Vulnerability.asset_id == asset_uuid)
            .values(asset_id=None)
        )
        unlinked = int(getattr(unlink_result, "rowcount", 0) or 0)

        await _audit(
            db,
            user_id,
            "asset.delete",
            "asset",
            asset_uuid,
            {"address": address, "unlinked_vulnerabilities": unlinked},
        )

        await db.execute(sa_delete(Asset).where(Asset.id == asset_uuid, Asset.user_id == user_id))
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        detail = str(getattr(exc, "orig", None) or exc)
        raise HTTPException(
            409,
            f"资产删除失败（{address}）。已尝试解绑关联漏洞。"
            f" 请刷新后重试。{detail[:180]}",
        ) from exc
    except SQLAlchemyError as exc:
        await db.rollback()
        raise HTTPException(500, f"资产删除数据库错误：{exc}") from exc
    except Exception as exc:
        await db.rollback()
        raise HTTPException(500, f"资产删除失败：{type(exc).__name__}: {exc}") from exc

    return {"ok": True, "unlinked_vulnerabilities": unlinked}


async def find_asset_by_host(
    db: AsyncSession,
    user_id: uuid.UUID,
    address: str,
) -> Asset | None:
    """Match ledger row by exact normalized host (IP or domain)."""
    host, _ = split_host_port(address)
    if not host:
        host = normalize_address(address)
    if not host:
        return None
    result = await db.execute(
        select(Asset).where(Asset.user_id == user_id, Asset.address == host)
    )
    return result.scalar_one_or_none()


# Backward-compatible alias for callers still using identity name.
async def find_asset_by_identity(
    db: AsyncSession,
    user_id: uuid.UUID,
    address: str,
) -> Asset | None:
    return await find_asset_by_host(db, user_id, address)


async def upsert_discovered_asset(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    address: str,
    name: str | None = None,
    asset_type: str | None = None,
    open_ports: object = None,
    services: object = None,
    urls: object = None,
    api_endpoints: object = None,
    port: object = None,
    conversation_id: uuid.UUID | None = None,
    node_id: uuid.UUID | None = None,
    source: str | None = None,
    identity_scope: str | None = None,
    allow_create: bool = False,
) -> Asset | None:
    """
    Enrich a user-owned host asset by exact (user_id, host).

    Policy: agents never create ledger hosts. Only merge ports/services/urls/
    api_endpoints onto an existing row. Returns None when the host is unknown
    (caller should not invent an asset).

    `allow_create=True` is reserved for **user-authorized** paths:
    open-task / handoff Scope registration, next-scope promote, tests/import.
    Agent discovery and vuln_found enrichment always leave it False.
    """
    host, addr_port = split_host_port(address)
    if not host:
        raise ValueError("invalid asset host")
    port_norm = normalize_port(port) or addr_port

    asset = await find_asset_by_host(db, user_id, host)
    if not asset and not allow_create:
        return None

    existing_fields = None
    if asset:
        existing_fields = {
            "address": asset.address,
            "name": asset.name,
            "type": asset.type,
            "source": asset.source,
            "properties": asset.properties or {},
        }
    fields = apply_discover_to_asset_fields(
        existing=existing_fields,
        address=host,
        name=name,
        asset_type=asset_type,
        open_ports=open_ports,
        services=services,
        urls=urls,
        api_endpoints=api_endpoints,
        source=source,
        port=port_norm,
    )
    if not asset:
        # Explicit create path only (user/import helpers) — never agent default.
        asset = Asset(
            id=uuid.uuid4(),
            user_id=user_id,
            conversation_id=conversation_id,
            node_id=node_id,
            name=fields["name"],
            address=fields["address"],
            type=fields["type"],
            tags=[],
            source=fields["source"] if fields.get("source") != "agent_discovered" else "manual",
            properties=fields["properties"],
        )
        db.add(asset)
    else:
        # Keep user name/type/source stable; only fill empty name, always merge surface.
        if not (asset.name or "").strip():
            asset.name = fields["name"]
        if not (asset.type or "").strip():
            asset.type = fields["type"]
        # Never rewrite ownership source from agent enrich.
        asset.properties = fields["properties"]
        if conversation_id:
            asset.conversation_id = conversation_id
        if node_id:
            asset.node_id = node_id
        asset.user_id = asset.user_id or user_id
    await db.flush()
    return asset


async def _get(asset_id: str, current_user: dict, db: AsyncSession) -> Asset:
    result = await db.execute(
        select(Asset).where(
            Asset.id == uuid.UUID(asset_id),
            Asset.user_id == uuid.UUID(current_user["user_id"]),
        )
    )
    a = result.scalar_one_or_none()
    if not a:
        raise HTTPException(404, "Asset not found")
    return a


async def _related_vulns(
    db: AsyncSession,
    user_id: uuid.UUID,
    asset_ids: list[uuid.UUID],
    *,
    include_detail: bool = False,
) -> dict[uuid.UUID, list[RelatedVulnOut]]:
    """All vulnerabilities under each asset (every port)."""
    if not asset_ids:
        return {}
    result = await db.execute(
        select(Vulnerability)
        .where(
            Vulnerability.user_id == user_id,
            Vulnerability.asset_id.in_(asset_ids),
        )
        .order_by(Vulnerability.discovered_at.desc())
    )
    grouped: dict[uuid.UUID, list[RelatedVulnOut]] = {}
    for v in result.scalars().all():
        grouped.setdefault(v.asset_id, []).append(
            RelatedVulnOut(
                id=str(v.id),
                title=v.title,
                severity=v.severity,
                status=v.status,
                confidence=v.confidence,
                port=str(v.port) if getattr(v, "port", None) else None,
                # Always include description so list risk chips can classify Key/Flag.
                description=v.description,
                remediation=v.remediation if include_detail else None,
                discovered_at=v.discovered_at.isoformat() if v.discovered_at else None,
                updated_at=v.updated_at.isoformat() if v.updated_at else None,
            )
        )
    return grouped


async def _audit(
    db: AsyncSession,
    user_id: uuid.UUID,
    action: str,
    resource_type: str,
    resource_id: uuid.UUID,
    detail: dict,
) -> None:
    db.add(
        AuditLog(
            actor_type="user",
            actor_id=user_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            detail=detail,
            status="success",
        )
    )


async def _hydrate_asset_ports(
    db: AsyncSession,
    assets: list[Asset],
    related: dict[uuid.UUID, list[RelatedVulnOut]],
) -> None:
    """
    Fill empty/missing ports from related findings + conversation task target.

    Agents often leave open_ports empty while the real port lives in
    task target (http://ip:52799) or evidence URLs. Hydrate for display and
    self-heal properties so subsequent reads stay correct.
    """
    if not assets:
        return

    conv_ids = [a.conversation_id for a in assets if a.conversation_id]
    contexts: dict[uuid.UUID, dict] = {}
    if conv_ids:
        result = await db.execute(select(Conversation).where(Conversation.id.in_(conv_ids)))
        for conv in result.scalars().all():
            if isinstance(conv.context, dict):
                contexts[conv.id] = conv.context

    healed: list[tuple[Asset, dict]] = []
    for a in assets:
        related_rows = related.get(a.id, [])
        related_dicts = [
            {
                "port": v.port,
                "description": v.description,
                "title": v.title,
            }
            for v in related_rows
        ]
        blobs: list[str] = []
        if a.conversation_id and a.conversation_id in contexts:
            blobs.extend(conversation_target_blobs(contexts[a.conversation_id]))

        before_ports = set(extract_ports(a.properties or {}))
        before_svcs = extract_services(a.properties or {})
        enriched = enrich_properties_ports(
            a.properties,
            host=a.address,
            related=related_dicts,
            extra_blobs=blobs,
        )
        after_ports = set(extract_ports(enriched))
        after_svcs = extract_services(enriched)
        # Always apply in-memory so this response shows ports even if DB write fails.
        if after_ports != before_ports or len(after_svcs) != len(before_svcs) or (
            after_ports and not before_ports
        ):
            a.properties = enriched
            healed.append((a, enriched))

    if healed:
        try:
            await db.commit()
        except Exception:
            await db.rollback()
            for a, enriched in healed:
                a.properties = enriched


def _out(a: Asset, related: list[RelatedVulnOut] | None = None) -> AssetOut:
    related = related or []
    props = a.properties or {}
    # Display-time merge (even if hydrate could not persist).
    related_dicts = [
        {
            "port": v.port,
            "description": v.description,
            "title": v.title,
        }
        for v in related
    ]
    props = enrich_properties_ports(props, host=a.address, related=related_dicts)
    vuln_dicts = [
        {
            "id": v.id,
            "title": v.title,
            "severity": v.severity,
            "status": v.status,
            "confidence": v.confidence,
            "port": v.port,
            "description": v.description,
        }
        for v in related
    ]
    risk = risk_summary_from_vulns(vuln_dicts)
    services_raw = extract_services(props)
    services = [
        ServiceOut(
            port=str(s.get("port") or ""),
            name=str(s.get("name") or s.get("service") or s.get("product") or ""),
            protocol=str(s["protocol"]) if s.get("protocol") else None,
            product=str(s["product"]) if s.get("product") else None,
            version=str(s["version"]) if s.get("version") else None,
            url=_service_url(s, a.address),
            note=(str(s.get("note") or s.get("remark") or "").strip() or None),
        )
        for s in services_raw
        if s.get("port")
    ]
    api_raw = extract_api_endpoints(props)
    api_endpoints = [
        ApiEndpointOut(
            method=str(e["method"]) if e.get("method") else None,
            path=str(e["path"]) if e.get("path") else None,
            url=str(e["url"]) if e.get("url") else None,
            name=str(e["name"]) if e.get("name") else None,
        )
        for e in api_raw
    ]
    return AssetOut(
        id=str(a.id),
        user_id=str(a.user_id) if a.user_id else None,
        conversation_id=str(a.conversation_id) if a.conversation_id else None,
        node_id=str(a.node_id) if a.node_id else None,
        name=a.name,
        address=a.address,
        type=a.type,
        type_label=type_label(a.type),
        tags=list(a.tags or []),
        properties=props,
        source=a.source,
        source_label=source_label(a.source),
        open_ports=extract_ports(props),
        services=services,
        urls=extract_urls(props),
        api_endpoints=api_endpoints,
        ports_summary=ports_summary(props),
        tech_summary=tech_summary(props),
        risk=RiskSummaryOut(**risk),
        related_vulnerabilities=related,
        created_at=a.created_at.isoformat() if a.created_at else None,
        updated_at=a.updated_at.isoformat() if a.updated_at else None,
    )


def _service_url(service: dict, host: str) -> str | None:
    """Prefer explicit service url; otherwise build from host + web-ish ports/services."""
    raw = service.get("url") or service.get("uri") or service.get("endpoint")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    port = str(service.get("port") or "").strip()
    name = str(service.get("name") or service.get("service") or "").strip().lower()
    proto = str(service.get("protocol") or "").strip().lower()
    host = (host or "").strip()
    if not host or not port:
        return None
    # Web-ish: named http(s), common ports, or any high/non-std port with empty name
    # when agent only left open_ports (CTF often uses random high ports).
    webish = (
        name in {"http", "https", "http-proxy", "ssl/http", "ssl/https", "www", ""}
        or proto in {"http", "https", "tcp"}
        or port in {"80", "443", "8080", "8443", "8000", "8888", "3000", "5000"}
        or (port.isdigit() and int(port) > 1024 and name in {"", "http", "https"})
    )
    if not webish:
        return None
    scheme = "https" if port in {"443", "8443"} or name in {"https", "ssl/https"} or proto == "https" else "http"
    if (scheme == "http" and port == "80") or (scheme == "https" and port == "443"):
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^\w.\-]+", "-", value, flags=re.UNICODE).strip("-")
    return cleaned[:80] or "asset"
