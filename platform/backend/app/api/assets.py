"""Asset API — enterprise asset ledger (manual + agent discovery)."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.audit import AuditLog
from app.models.vulnerability import Vulnerability
from app.services.asset_ledger import (
    apply_discover_to_asset_fields,
    compute_security_changes,
    extract_ports,
    extract_services,
    normalize_address,
    ports_summary,
    render_changes_markdown,
    render_remediation_html,
    render_remediation_markdown,
    risk_summary_from_vulns,
    source_label,
    tech_summary,
    type_label,
)

router = APIRouter(prefix="/api/assets", tags=["assets"])


class AssetCreate(BaseModel):
    name: str
    address: str
    type: str
    tags: list[str] = Field(default_factory=list)
    properties: dict = Field(default_factory=dict)


class RelatedVulnOut(BaseModel):
    id: str
    title: str
    severity: str
    status: str
    confidence: str
    description: str | None = None
    remediation: str | None = None
    discovered_at: str | None = None
    updated_at: str | None = None


class RiskSummaryOut(BaseModel):
    open_total: int = 0
    by_severity: dict = Field(default_factory=dict)
    highest: str = "none"
    label: str = "无开放漏洞"


class AssetOut(BaseModel):
    id: str
    user_id: str | None = None
    conversation_id: str | None = None
    node_id: str | None = None
    name: str
    address: str
    type: str
    type_label: str = ""
    tags: list = Field(default_factory=list)
    properties: dict = Field(default_factory=dict)
    source: str
    source_label: str = ""
    open_ports: list[str] = Field(default_factory=list)
    services: list[dict] = Field(default_factory=list)
    ports_summary: str = ""
    tech_summary: str = ""
    risk: RiskSummaryOut = Field(default_factory=RiskSummaryOut)
    related_vulnerabilities: list[RelatedVulnOut] = Field(default_factory=list)
    created_at: str | None
    updated_at: str | None
    model_config = {"from_attributes": True}


@router.get("", response_model=list[AssetOut])
async def list_assets(
    type: str | None = Query(None),
    search: str | None = Query(None),
    limit: int = 100,
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    q = select(Asset).where(Asset.user_id == user_id)
    if type:
        q = q.where(Asset.type == type)
    if search:
        q = q.where(or_(Asset.name.ilike(f"%{search}%"), Asset.address.ilike(f"%{search}%")))
    q = q.order_by(Asset.updated_at.desc()).offset(offset).limit(limit)
    result = await db.execute(q)
    assets = result.scalars().all()
    related = await _related_vulns(db, user_id, [a.id for a in assets])
    return [_out(a, related.get(a.id, [])) for a in assets]


@router.get("/changes")
async def asset_security_changes(
    days: int = Query(7, ge=1, le=90),
    format: str = Query("json", pattern="^(json|markdown|md)$"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Last-N-days asset security change summary (JSON or markdown download)."""
    user_id = uuid.UUID(current_user["user_id"])
    assets_result = await db.execute(select(Asset).where(Asset.user_id == user_id))
    assets = assets_result.scalars().all()
    vulns_result = await db.execute(
        select(Vulnerability).where(
            Vulnerability.user_id == user_id,
            Vulnerability.asset_id.is_not(None),
        )
    )
    vulns = vulns_result.scalars().all()
    asset_rows = [
        {
            "id": str(a.id),
            "name": a.name,
            "address": a.address,
            "type": a.type,
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "updated_at": a.updated_at.isoformat() if a.updated_at else None,
        }
        for a in assets
    ]
    vuln_rows = [
        {
            "id": str(v.id),
            "title": v.title,
            "severity": v.severity,
            "status": v.status,
            "asset_id": str(v.asset_id) if v.asset_id else None,
            "discovered_at": v.discovered_at.isoformat() if v.discovered_at else None,
            "updated_at": v.updated_at.isoformat() if v.updated_at else None,
        }
        for v in vulns
    ]
    summary = compute_security_changes(asset_rows, vuln_rows, days=days)
    if format in {"markdown", "md"}:
        body = render_changes_markdown(summary)
        return Response(
            content=body,
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="asset-security-changes-7d.md"'},
        )
    return summary


@router.post("", response_model=AssetOut)
async def create_asset(
    body: AssetCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    address = normalize_address(body.address)
    # Merge into existing ledger row for same normalized address.
    existing = await db.execute(
        select(Asset).where(Asset.user_id == user_id, Asset.address == address)
    )
    a = existing.scalar_one_or_none()
    if a:
        a.name = body.name or a.name
        a.type = body.type or a.type
        a.tags = body.tags or a.tags
        if body.properties:
            from app.services.asset_ledger import merge_discover_properties

            a.properties = merge_discover_properties(
                a.properties,
                open_ports=body.properties.get("open_ports"),
                services=body.properties.get("services"),
                extra={k: v for k, v in body.properties.items() if k not in {"open_ports", "services"}},
            )
        await _audit(db, user_id, "asset.update", "asset", a.id, {"address": a.address, "merged": True})
    else:
        a = Asset(
            id=uuid.uuid4(),
            user_id=user_id,
            name=body.name,
            address=address,
            type=body.type,
            tags=body.tags,
            properties=body.properties or {},
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
    vulns = [
        {
            "id": v.id,
            "title": v.title,
            "severity": v.severity,
            "status": v.status,
            "confidence": v.confidence,
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
    for k in ("name", "type", "tags", "properties"):
        if k in body:
            setattr(a, k, body[k])
    if "address" in body:
        a.address = normalize_address(body["address"])
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
    user_id = uuid.UUID(current_user["user_id"])
    a = await _get(asset_id, current_user, db)
    await _audit(db, user_id, "asset.delete", "asset", a.id, {"address": a.address})
    await db.delete(a)
    await db.commit()
    return {"ok": True}


async def upsert_discovered_asset(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    address: str,
    name: str | None = None,
    asset_type: str | None = None,
    open_ports: object = None,
    services: object = None,
    conversation_id: uuid.UUID | None = None,
    node_id: uuid.UUID | None = None,
    source: str = "agent_discovered",
) -> Asset:
    """
    Upsert agent-discovered asset by (user_id, normalized address).
    Merges ports/services into one ledger row. Used by WS path and tests.
    """
    norm = normalize_address(address)
    result = await db.execute(select(Asset).where(Asset.user_id == user_id, Asset.address == norm))
    asset = result.scalar_one_or_none()
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
        address=norm,
        name=name,
        asset_type=asset_type,
        open_ports=open_ports,
        services=services,
        source=source,
    )
    if not asset:
        asset = Asset(
            id=uuid.uuid4(),
            user_id=user_id,
            conversation_id=conversation_id,
            node_id=node_id,
            name=fields["name"],
            address=fields["address"],
            type=fields["type"],
            source=fields["source"],
            properties=fields["properties"],
        )
        db.add(asset)
    else:
        asset.name = fields["name"]
        asset.type = fields["type"]
        asset.source = fields["source"]
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
                description=v.description if include_detail else None,
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


def _out(a: Asset, related: list[RelatedVulnOut] | None = None) -> AssetOut:
    related = related or []
    props = a.properties or {}
    vuln_dicts = [
        {
            "id": v.id,
            "title": v.title,
            "severity": v.severity,
            "status": v.status,
            "confidence": v.confidence,
        }
        for v in related
    ]
    risk = risk_summary_from_vulns(vuln_dicts)
    ports = extract_ports(props)
    services = extract_services(props)
    return AssetOut(
        id=str(a.id),
        user_id=str(a.user_id) if a.user_id else None,
        conversation_id=str(a.conversation_id) if a.conversation_id else None,
        node_id=str(a.node_id) if a.node_id else None,
        name=a.name,
        address=a.address,
        type=a.type,
        type_label=type_label(a.type),
        tags=a.tags or [],
        properties=props,
        source=a.source,
        source_label=source_label(a.source),
        open_ports=ports,
        services=services,
        ports_summary=ports_summary(props),
        tech_summary=tech_summary(props),
        risk=RiskSummaryOut(**risk),
        related_vulnerabilities=related,
        created_at=a.created_at.isoformat() if a.created_at else None,
        updated_at=a.updated_at.isoformat() if a.updated_at else None,
    )


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^\w.\-]+", "-", value, flags=re.UNICODE).strip("-")
    return cleaned[:80] or "asset"
