"""Asset API."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.audit import AuditLog
from app.models.vulnerability import Vulnerability

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


class AssetOut(BaseModel):
    id: str
    user_id: str | None = None
    conversation_id: str | None = None
    node_id: str | None = None
    name: str
    address: str
    type: str
    tags: list = Field(default_factory=list)
    properties: dict = Field(default_factory=dict)
    source: str
    related_vulnerabilities: list[RelatedVulnOut] = Field(default_factory=list)
    created_at: str | None
    updated_at: str | None
    model_config = {"from_attributes": True}


@router.get("", response_model=list[AssetOut])
async def list_assets(
    type: str | None = Query(None),
    search: str | None = Query(None),
    limit: int = 50,
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    q = select(Asset).where(Asset.user_id == user_id)
    if type:
        q = q.where(Asset.type == type)
    if search:
        q = q.where(Asset.name.ilike(f"%{search}%") | Asset.address.ilike(f"%{search}%"))
    q = q.order_by(Asset.updated_at.desc()).offset(offset).limit(limit)
    result = await db.execute(q)
    assets = result.scalars().all()
    related = await _related_vulns(db, user_id, [a.id for a in assets])
    return [_out(a, related.get(a.id, [])) for a in assets]


@router.post("", response_model=AssetOut)
async def create_asset(
    body: AssetCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    a = Asset(
        id=uuid.uuid4(),
        user_id=user_id,
        name=body.name,
        address=body.address,
        type=body.type,
        tags=body.tags,
        properties=body.properties,
        source="manual",
    )
    db.add(a)
    await db.flush()
    await _audit(db, user_id, "asset.create", "asset", a.id, {"address": a.address})
    await db.commit()
    await db.refresh(a)
    return _out(a)


@router.get("/{asset_id}", response_model=AssetOut)
async def get_asset(
    asset_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    a = await _get(asset_id, current_user, db)
    related = await _related_vulns(db, user_id, [a.id])
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
    for k in ("name", "address", "type", "tags", "properties"):
        if k in body:
            setattr(a, k, body[k])
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


async def _related_vulns(db: AsyncSession, user_id: uuid.UUID, asset_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[RelatedVulnOut]]:
    if not asset_ids:
        return {}
    result = await db.execute(
        select(Vulnerability).where(
            Vulnerability.user_id == user_id,
            Vulnerability.asset_id.in_(asset_ids),
        ).order_by(Vulnerability.discovered_at.desc())
    )
    grouped: dict[uuid.UUID, list[RelatedVulnOut]] = {}
    for v in result.scalars().all():
        grouped.setdefault(v.asset_id, []).append(RelatedVulnOut(
            id=str(v.id),
            title=v.title,
            severity=v.severity,
            status=v.status,
            confidence=v.confidence,
        ))
    return grouped


async def _audit(db: AsyncSession, user_id: uuid.UUID, action: str, resource_type: str, resource_id: uuid.UUID, detail: dict) -> None:
    db.add(AuditLog(
        actor_type="user",
        actor_id=user_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        detail=detail,
        status="success",
    ))


def _out(a: Asset, related: list[RelatedVulnOut] | None = None) -> AssetOut:
    return AssetOut(
        id=str(a.id),
        user_id=str(a.user_id) if a.user_id else None,
        conversation_id=str(a.conversation_id) if a.conversation_id else None,
        node_id=str(a.node_id) if a.node_id else None,
        name=a.name,
        address=a.address,
        type=a.type,
        tags=a.tags or [],
        properties=a.properties or {},
        source=a.source,
        related_vulnerabilities=related or [],
        created_at=a.created_at.isoformat() if a.created_at else None,
        updated_at=a.updated_at.isoformat() if a.updated_at else None,
    )
