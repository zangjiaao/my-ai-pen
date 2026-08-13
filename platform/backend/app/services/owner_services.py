"""Persist official Service rows and 攻击面 paths — Spec #454b / #454c.

Does not write Case Surface (#368) or surface_inventory (#410).
Does not create Hosts.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.owner_ledger import AssetService, AssetServicePath
from app.services.asset_ledger import (
    admit_owner_path,
    extract_aliases,
    identity_values,
    merge_official_service,
    normalize_owner_path,
    normalize_port,
    normalize_tags,
    owner_target_from_location,
    owner_target_from_surface_row,
    service_source_admits,
    split_host_port,
)


def _row_to_dict(row: AssetService, paths: list[AssetServicePath] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(row.id),
        "asset_id": str(row.asset_id),
        "port": row.port,
        "name": row.name or "",
        "protocol": row.protocol,
        "product": row.product,
        "version": row.version,
        "url": row.url,
        "note": row.note,
        "tags": list(row.tags or []),
        "source": row.source,
    }
    if paths is not None:
        out["paths"] = [{"path": p.path, "source": p.source} for p in paths]
    return out


async def load_official_services(
    db: AsyncSession, asset_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[dict[str, Any]]]:
    if not asset_ids:
        return {}
    result = await db.execute(select(AssetService).where(AssetService.asset_id.in_(asset_ids)))
    rows = list(result.scalars().all())
    if not rows:
        return {}
    path_result = await db.execute(
        select(AssetServicePath).where(AssetServicePath.service_id.in_([r.id for r in rows]))
    )
    paths_by_svc: dict[uuid.UUID, list[AssetServicePath]] = {}
    for p in path_result.scalars().all():
        paths_by_svc.setdefault(p.service_id, []).append(p)
    out: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for row in rows:
        out.setdefault(row.asset_id, []).append(_row_to_dict(row, paths_by_svc.get(row.id, [])))
    return out


async def find_asset_by_address_or_alias(
    db: AsyncSession,
    user_id: uuid.UUID,
    address: str,
) -> Asset | None:
    host, _ = split_host_port(address)
    if not host:
        return None
    exact = await db.execute(select(Asset).where(Asset.user_id == user_id, Asset.address == host))
    found = exact.scalar_one_or_none()
    if found:
        return found
    result = await db.execute(select(Asset).where(Asset.user_id == user_id))
    for asset in result.scalars().all():
        keys = identity_values(asset.address, asset.properties or {})
        if host in keys:
            return asset
        aliases = extract_aliases(asset.properties or {}, asset.address)
        if host in aliases:
            return asset
    return None


async def upsert_official_service(
    db: AsyncSession,
    *,
    asset_id: uuid.UUID,
    port: object,
    source: str,
    name: str | None = None,
    protocol: str | None = None,
    product: str | None = None,
    version: str | None = None,
    url: str | None = None,
    note: str | None = None,
    tags: object = None,
) -> dict[str, Any] | None:
    if not service_source_admits(source):
        return None
    port_n = normalize_port(port)
    if not port_n:
        return None
    result = await db.execute(
        select(AssetService).where(AssetService.asset_id == asset_id, AssetService.port == port_n)
    )
    row = result.scalar_one_or_none()
    incoming = {
        "port": port_n,
        "name": name,
        "protocol": protocol,
        "product": product,
        "version": version,
        "url": url,
        "note": note,
        "source": source,
    }
    if tags is not None:
        incoming["tags"] = normalize_tags(tags)
    if row:
        merged = merge_official_service(_row_to_dict(row), incoming)
        row.name = str(merged.get("name") or row.name or "")
        if merged.get("protocol"):
            row.protocol = str(merged["protocol"])
        if merged.get("product"):
            row.product = str(merged["product"])
        if merged.get("version"):
            row.version = str(merged["version"])
        if merged.get("url"):
            row.url = str(merged["url"])
        if note is not None:
            row.note = str(note)
        if tags is not None:
            row.tags = normalize_tags(tags)
        if row.source == "user" or source == "user":
            row.source = row.source or source
        await db.flush()
        return _row_to_dict(row)
    row = AssetService(
        id=uuid.uuid4(),
        asset_id=asset_id,
        port=port_n,
        name=str(name or ""),
        protocol=protocol,
        product=product,
        version=version,
        url=url,
        note=note,
        tags=normalize_tags(tags) if tags is not None else [],
        source=source,
    )
    db.add(row)
    await db.flush()
    return _row_to_dict(row)


async def delete_official_services(
    db: AsyncSession, asset_id: uuid.UUID, ports: set[str]
) -> None:
    if not ports:
        return
    result = await db.execute(
        select(AssetService).where(
            AssetService.asset_id == asset_id,
            AssetService.port.in_(list(ports)),
        )
    )
    for row in result.scalars().all():
        await db.delete(row)


async def admit_official_path(
    db: AsyncSession,
    *,
    asset_id: uuid.UUID,
    port: object,
    path: object,
    source: str,
) -> dict[str, Any] | None:
    planned = admit_owner_path([], path=path, source=source)
    if not planned:
        return None
    svc = await upsert_official_service(db, asset_id=asset_id, port=port, source=source)
    if not svc:
        return None
    result = await db.execute(
        select(AssetService).where(
            AssetService.asset_id == asset_id,
            AssetService.port == normalize_port(port),
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    norm = normalize_owner_path(path)
    if not norm:
        return None
    existing = await db.execute(
        select(AssetServicePath).where(
            AssetServicePath.service_id == row.id,
            AssetServicePath.path == norm,
        )
    )
    if existing.scalar_one_or_none():
        return {"path": norm, "source": source}
    db.add(
        AssetServicePath(
            id=uuid.uuid4(),
            service_id=row.id,
            path=norm,
            source=source,
        )
    )
    await db.flush()
    return {"path": norm, "source": source}


async def attach_book_to_owner_ledger(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    host: str | None,
    port: object = None,
    location: str | None = None,
    service_name: str | None = None,
) -> None:
    """Finding book → Service row + HTTP path. Never creates a Host."""
    target = owner_target_from_location(location) if location else None
    address = (target or {}).get("host") or host
    port_n = (target or {}).get("port") or normalize_port(port)
    if not address or not port_n:
        return
    asset = await find_asset_by_address_or_alias(db, user_id, str(address))
    if not asset:
        return
    await upsert_official_service(
        db,
        asset_id=asset.id,
        port=port_n,
        source="book",
        name=service_name,
        url=location if location and "://" in str(location) else None,
    )
    path = (target or {}).get("path")
    if path:
        await admit_official_path(
            db, asset_id=asset.id, port=port_n, path=path, source="book"
        )


async def attach_http_surfaces_to_owner_ledger(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    surfaces: list[dict[str, Any]],
) -> None:
    """Accepted HTTP(S) Surface settle → Service row + path. Does not mutate surfaces."""
    for row in surfaces or []:
        target = owner_target_from_surface_row(row)
        if not target:
            continue
        asset = await find_asset_by_address_or_alias(db, user_id, target["host"])
        if not asset:
            continue
        await upsert_official_service(
            db,
            asset_id=asset.id,
            port=target["port"],
            source="http_settle",
        )
        if target.get("path"):
            await admit_official_path(
                db,
                asset_id=asset.id,
                port=target["port"],
                path=target["path"],
                source="http_settle",
            )
