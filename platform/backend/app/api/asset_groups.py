"""Owner ledger Groups and assemblies — Spec #454a. User-authored only."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.audit import AuditLog
from app.models.owner_ledger import AssetAssembly, AssetGroup
from app.services.asset_ledger import normalize_assembly_ports

router = APIRouter(prefix="/api/asset-groups", tags=["asset-groups"])


class GroupCreate(BaseModel):
    name: str


class GroupUpdate(BaseModel):
    name: str | None = None


class AssemblyPut(BaseModel):
    ports: list[str | int] = Field(default_factory=list)


class BatchMoveIn(BaseModel):
    """One-shot assembly move/add for many Hosts (UI multi-select).

    - target_group_id set → upsert each Host into that Group
    - target_group_id empty + remove_from_all_groups → strip all assemblies (→ 未分组)
    - source_group_id set → delete those Hosts from the source Group after put
    """

    asset_ids: list[str] = Field(default_factory=list)
    target_group_id: str | None = None
    source_group_id: str | None = None
    remove_from_all_groups: bool = False
    # Same ports for every Host when ports_by_asset omits an id (default bare).
    default_ports: list[str | int] = Field(default_factory=list)
    ports_by_asset: dict[str, list[str | int]] | None = None


class AssemblyMemberOut(BaseModel):
    asset_id: str
    ports: list[str] = Field(default_factory=list)


class GroupOut(BaseModel):
    id: str
    name: str
    members: list[AssemblyMemberOut] = Field(default_factory=list)
    created_at: str | None = None
    updated_at: str | None = None


def _norm_name(value: object) -> str:
    return str(value or "").strip()


async def _user_id(current_user: dict) -> uuid.UUID:
    return uuid.UUID(current_user["user_id"])


async def _get_group(db: AsyncSession, user_id: uuid.UUID, group_id: str) -> AssetGroup:
    try:
        gid = uuid.UUID(group_id)
    except ValueError as exc:
        raise HTTPException(404, "组不存在") from exc
    result = await db.execute(
        select(AssetGroup).where(AssetGroup.id == gid, AssetGroup.user_id == user_id)
    )
    group = result.scalar_one_or_none()
    if not group:
        raise HTTPException(404, "组不存在")
    return group


async def _members_by_group(
    db: AsyncSession, group_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[AssemblyMemberOut]]:
    if not group_ids:
        return {}
    result = await db.execute(select(AssetAssembly).where(AssetAssembly.group_id.in_(group_ids)))
    out: dict[uuid.UUID, list[AssemblyMemberOut]] = {gid: [] for gid in group_ids}
    for row in result.scalars().all():
        out.setdefault(row.group_id, []).append(
            AssemblyMemberOut(
                asset_id=str(row.asset_id),
                ports=normalize_assembly_ports(row.ports or []),
            )
        )
    return out


def _out(group: AssetGroup, members: list[AssemblyMemberOut] | None = None) -> GroupOut:
    return GroupOut(
        id=str(group.id),
        name=group.name,
        members=members or [],
        created_at=group.created_at.isoformat() if group.created_at else None,
        updated_at=group.updated_at.isoformat() if group.updated_at else None,
    )


async def _audit(db: AsyncSession, user_id: uuid.UUID, action: str, resource_id: uuid.UUID, detail: dict) -> None:
    db.add(
        AuditLog(
            actor_type="user",
            actor_id=user_id,
            action=action,
            resource_type="asset_group",
            resource_id=resource_id,
            detail=detail,
            status="success",
        )
    )


@router.get("", response_model=list[GroupOut])
async def list_groups(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = await _user_id(current_user)
    result = await db.execute(
        select(AssetGroup).where(AssetGroup.user_id == user_id).order_by(AssetGroup.name.asc())
    )
    groups = list(result.scalars().all())
    members = await _members_by_group(db, [g.id for g in groups])
    return [_out(g, members.get(g.id, [])) for g in groups]


@router.post("", response_model=GroupOut)
async def create_group(
    body: GroupCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = await _user_id(current_user)
    name = _norm_name(body.name)
    if not name:
        raise HTTPException(400, "组名不能为空")
    clash = await db.execute(
        select(AssetGroup).where(
            AssetGroup.user_id == user_id,
            func.lower(AssetGroup.name) == name.lower(),
        )
    )
    if clash.scalar_one_or_none():
        raise HTTPException(409, f"已存在名为 {name} 的组")
    group = AssetGroup(id=uuid.uuid4(), user_id=user_id, name=name)
    db.add(group)
    await db.flush()
    await _audit(db, user_id, "asset_group.create", group.id, {"name": name})
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, f"已存在名为 {name} 的组") from exc
    await db.refresh(group)
    return _out(group, [])


@router.patch("/{group_id}", response_model=GroupOut)
async def update_group(
    group_id: str,
    body: GroupUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = await _user_id(current_user)
    group = await _get_group(db, user_id, group_id)
    if body.name is not None:
        name = _norm_name(body.name)
        if not name:
            raise HTTPException(400, "组名不能为空")
        clash = await db.execute(
            select(AssetGroup).where(
                AssetGroup.user_id == user_id,
                func.lower(AssetGroup.name) == name.lower(),
                AssetGroup.id != group.id,
            )
        )
        if clash.scalar_one_or_none():
            raise HTTPException(409, f"已存在名为 {name} 的组")
        group.name = name
    await _audit(db, user_id, "asset_group.update", group.id, {"name": group.name})
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, f"已存在名为 {group.name} 的组") from exc
    await db.refresh(group)
    members = await _members_by_group(db, [group.id])
    return _out(group, members.get(group.id, []))


@router.delete("/{group_id}")
async def delete_group(
    group_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = await _user_id(current_user)
    group = await _get_group(db, user_id, group_id)
    name = group.name
    await _audit(db, user_id, "asset_group.delete", group.id, {"name": name})
    await db.delete(group)
    await db.commit()
    return {"ok": True}


@router.post("/batch-move")
async def batch_move(
    body: BatchMoveIn,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Move/add many Hosts in one transaction (replaces N× PUT/DELETE)."""
    user_id = await _user_id(current_user)
    raw_ids = [str(x).strip() for x in (body.asset_ids or []) if str(x or "").strip()]
    if not raw_ids:
        raise HTTPException(400, "请选择主机")
    if len(raw_ids) > 2000:
        raise HTTPException(400, "一次最多移动 2000 台")

    asset_uuids: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for raw in raw_ids:
        try:
            aid = uuid.UUID(raw)
        except ValueError as exc:
            raise HTTPException(400, f"无效资产 id: {raw}") from exc
        if aid in seen:
            continue
        seen.add(aid)
        asset_uuids.append(aid)

    owned = (
        await db.execute(select(Asset.id).where(Asset.user_id == user_id, Asset.id.in_(asset_uuids)))
    ).scalars().all()
    owned_set = set(owned)
    missing = [str(a) for a in asset_uuids if a not in owned_set]
    if missing:
        raise HTTPException(404, f"资产不存在: {missing[0]}")

    target_raw = str(body.target_group_id or "").strip()
    source_raw = str(body.source_group_id or "").strip()
    target: AssetGroup | None = None
    source: AssetGroup | None = None
    if target_raw:
        target = await _get_group(db, user_id, target_raw)
    if source_raw:
        source = await _get_group(db, user_id, source_raw)
        if target and source.id == target.id:
            source = None

    if not target and not source and not body.remove_from_all_groups:
        raise HTTPException(400, "请指定目标组、源组或移到未分组")

    default_ports = normalize_assembly_ports(body.default_ports)
    ports_map = body.ports_by_asset if isinstance(body.ports_by_asset, dict) else {}

    put_count = 0
    if target:
        existing_rows = (
            await db.execute(
                select(AssetAssembly).where(
                    AssetAssembly.group_id == target.id,
                    AssetAssembly.asset_id.in_(asset_uuids),
                )
            )
        ).scalars().all()
        by_asset = {row.asset_id: row for row in existing_rows}
        for aid in asset_uuids:
            key = str(aid)
            if key in ports_map:
                ports = normalize_assembly_ports(ports_map[key])
            else:
                ports = default_ports
            row = by_asset.get(aid)
            if row:
                row.ports = ports
            else:
                db.add(
                    AssetAssembly(
                        id=uuid.uuid4(),
                        group_id=target.id,
                        asset_id=aid,
                        ports=ports,
                    )
                )
            put_count += 1

    removed = 0
    if body.remove_from_all_groups:
        # Strip every assembly for these Hosts, then re-put target if any
        # (target put already applied above — only delete non-target rows).
        q = select(AssetAssembly).where(AssetAssembly.asset_id.in_(asset_uuids))
        if target:
            q = q.where(AssetAssembly.group_id != target.id)
        rows = (await db.execute(q)).scalars().all()
        for row in rows:
            await db.delete(row)
            removed += 1
    elif source:
        rows = (
            await db.execute(
                select(AssetAssembly).where(
                    AssetAssembly.group_id == source.id,
                    AssetAssembly.asset_id.in_(asset_uuids),
                )
            )
        ).scalars().all()
        for row in rows:
            await db.delete(row)
            removed += 1

    audit_target = target.id if target else (source.id if source else asset_uuids[0])
    await _audit(
        db,
        user_id,
        "asset_assembly.batch_move",
        audit_target,
        {
            "asset_count": len(asset_uuids),
            "put_count": put_count,
            "removed": removed,
            "target_group_id": str(target.id) if target else None,
            "source_group_id": str(source.id) if source else None,
            "remove_from_all_groups": bool(body.remove_from_all_groups),
        },
    )
    await db.commit()
    return {
        "ok": True,
        "asset_count": len(asset_uuids),
        "put_count": put_count,
        "removed": removed,
        "target_group_id": str(target.id) if target else None,
        "source_group_id": str(source.id) if source else None,
    }


@router.put("/{group_id}/hosts/{asset_id}", response_model=AssemblyMemberOut)
async def put_assembly(
    group_id: str,
    asset_id: str,
    body: AssemblyPut,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = await _user_id(current_user)
    group = await _get_group(db, user_id, group_id)
    try:
        aid = uuid.UUID(asset_id)
    except ValueError as exc:
        raise HTTPException(404, "资产不存在") from exc
    asset = (
        await db.execute(select(Asset).where(Asset.id == aid, Asset.user_id == user_id))
    ).scalar_one_or_none()
    if not asset:
        raise HTTPException(404, "资产不存在")
    ports = normalize_assembly_ports(body.ports)
    existing = (
        await db.execute(
            select(AssetAssembly).where(
                AssetAssembly.group_id == group.id,
                AssetAssembly.asset_id == aid,
            )
        )
    ).scalar_one_or_none()
    if existing:
        existing.ports = ports
        row = existing
    else:
        row = AssetAssembly(
            id=uuid.uuid4(),
            group_id=group.id,
            asset_id=aid,
            ports=ports,
        )
        db.add(row)
    await _audit(
        db,
        user_id,
        "asset_assembly.put",
        group.id,
        {"asset_id": str(aid), "ports": ports},
    )
    await db.commit()
    return AssemblyMemberOut(asset_id=str(aid), ports=ports)


@router.delete("/{group_id}/hosts/{asset_id}")
async def delete_assembly(
    group_id: str,
    asset_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = await _user_id(current_user)
    group = await _get_group(db, user_id, group_id)
    try:
        aid = uuid.UUID(asset_id)
    except ValueError as exc:
        raise HTTPException(404, "组装不存在") from exc
    row = (
        await db.execute(
            select(AssetAssembly).where(
                AssetAssembly.group_id == group.id,
                AssetAssembly.asset_id == aid,
            )
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "组装不存在")
    await db.delete(row)
    await _audit(db, user_id, "asset_assembly.delete", group.id, {"asset_id": str(aid)})
    await db.commit()
    return {"ok": True}
