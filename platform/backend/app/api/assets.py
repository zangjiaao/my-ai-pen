"""资产 API"""
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset

router = APIRouter(prefix="/api/assets", tags=["assets"])


class AssetCreate(BaseModel):
    name: str; address: str; type: str
    tags: list[str] = []; properties: dict = {}


class AssetOut(BaseModel):
    id: str; name: str; address: str; type: str; tags: list; source: str
    created_at: str | None; updated_at: str | None
    model_config = {"from_attributes": True}


@router.get("", response_model=list[AssetOut])
async def list_assets(type: str | None = Query(None), search: str | None = Query(None),
                       limit: int = 50, offset: int = 0,
                       current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    q = select(Asset)
    if type: q = q.where(Asset.type == type)
    if search: q = q.where(Asset.name.ilike(f"%{search}%") | Asset.address.ilike(f"%{search}%"))
    q = q.offset(offset).limit(limit).order_by(Asset.updated_at.desc())
    result = await db.execute(q)
    return [_out(a) for a in result.scalars().all()]


@router.post("", response_model=AssetOut)
async def create_asset(body: AssetCreate, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    a = Asset(id=uuid.uuid4(), name=body.name, address=body.address, type=body.type, tags=body.tags, properties=body.properties)
    db.add(a); await db.commit(); await db.refresh(a)
    return _out(a)


@router.get("/{asset_id}", response_model=AssetOut)
async def get_asset(asset_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    a = await _get(asset_id, db)
    return _out(a)


@router.patch("/{asset_id}")
async def update_asset(asset_id: str, body: dict, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    a = await _get(asset_id, db)
    for k in ("name", "address", "type", "tags", "properties"):
        if k in body: setattr(a, k, body[k])
    await db.commit()
    return {"ok": True}


@router.delete("/{asset_id}")
async def delete_asset(asset_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    a = await _get(asset_id, db)
    await db.delete(a); await db.commit()
    return {"ok": True}


async def _get(asset_id: str, db: AsyncSession) -> Asset:
    result = await db.execute(select(Asset).where(Asset.id == uuid.UUID(asset_id)))
    a = result.scalar_one_or_none()
    if not a: raise HTTPException(404, "Asset not found")
    return a


def _out(a: Asset) -> AssetOut:
    return AssetOut(id=str(a.id), name=a.name, address=a.address, type=a.type, tags=a.tags or [], source=a.source,
                    created_at=a.created_at.isoformat() if a.created_at else None, updated_at=a.updated_at.isoformat() if a.updated_at else None)
