"""User-facing Intel (线索 / 情报) reads — Spec owner-intel.md."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.services import owner_intel as intel

router = APIRouter(prefix="/api/intel", tags=["intel"])


def _user_id(current_user: dict) -> uuid.UUID:
    return uuid.UUID(str(current_user["user_id"]))


@router.get("")
async def list_intel(
    asset_id: str | None = Query(default=None),
    port: str | None = Query(default=None),
    status: str | None = Query(default="active"),
    current_task_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    items, total = await intel.list_intel(
        db,
        user_id=_user_id(current_user),
        asset_id=asset_id,
        port=port,
        status=status,
        audience="user",
        current_task_id=current_task_id,
        limit=limit,
        offset=offset,
        include_body=False,
    )
    return {
        "ok": True,
        "intel": items,
        "count": len(items),
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(items) < total,
    }


@router.get("/{intel_id}")
async def get_intel(
    intel_id: str,
    current_task_id: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    try:
        item = await intel.get_intel(
            db,
            intel_id,
            user_id=_user_id(current_user),
            audience="user",
            current_task_id=current_task_id,
        )
    except intel.IntelError as e:
        raise HTTPException(e.status_code, e.message) from e
    return {"ok": True, "intel": item}
