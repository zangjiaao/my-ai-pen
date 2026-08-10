"""Spec #410 — Durable surface inventory (asset-scoped novelty baseline).

Layer split (locked with Spec #322 / case-surface-ledger):
  - Case surface_ledger: live engagement SoT for TESTED / traffic / booked.
  - This module: long-lived identity precipitation for NEW only.

Identity matches Surface: origin_key + path_key (see surface_ledger.surface_row_key).
Scope: per user (and optional asset_id when Host is known). Does **not**
auto-mark TESTED and does **not** invent surfaces from prose or vulns.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from app.services.surface_ledger import surface_row_key


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def host_from_origin_key(origin_key: str | None) -> str:
    """Extract host (no port) from a Surface origin_key for asset join."""
    raw = str(origin_key or "").strip()
    if not raw:
        return ""
    try:
        # origin_key is scheme://host:port (host may be [ipv6])
        parsed = urlparse(raw if "://" in raw else f"//{raw}")
        host = (parsed.hostname or "").lower().strip()
        return host
    except Exception:
        return ""


def inventory_identity_key(origin_key: str | None, path_key: str | None) -> str:
    """Stable identity key aligned with Case Surface ledger."""
    return surface_row_key(
        str(origin_key or "").strip(),
        "" if path_key is None else str(path_key).strip(),
    )


def coerce_is_new_flag(value: Any, *, default: bool = False) -> bool:
    """False-safe boolean for Case row is_new (mirrors FE isSurfaceNew truthiness)."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    s = str(value).strip().lower()
    if s in {"1", "true", "yes", "y", "on"}:
        return True
    if s in {"0", "false", "no", "n", "off", ""}:
        return False
    return default


def empty_memory_inventory() -> dict[str, dict[str, Any]]:
    """In-memory inventory map for pure tests (key → record)."""
    return {}


def admit_identity_memory(
    inventory: dict[str, dict[str, Any]],
    origin_key: str,
    path_key: str = "",
    *,
    conversation_id: str | None = None,
    asset_id: str | None = None,
    now: str | None = None,
) -> dict[str, Any]:
    """Upsert one identity into an in-memory inventory.

    Returns:
      {
        "is_new": bool,   # True only on first admit
        "key": str,
        "record": dict,
      }
    """
    ok = str(origin_key or "").strip()
    pk = "" if path_key is None else str(path_key).strip()
    key = inventory_identity_key(ok, pk)
    if not ok:
        return {"is_new": False, "key": key, "record": {}}
    ts = now or _now_iso()
    existing = inventory.get(key)
    if existing is not None:
        existing["last_seen_at"] = ts
        if conversation_id:
            existing["last_conversation_id"] = str(conversation_id)
        if asset_id and not existing.get("asset_id"):
            existing["asset_id"] = str(asset_id)
        return {"is_new": False, "key": key, "record": existing}

    host = host_from_origin_key(ok)
    record: dict[str, Any] = {
        "origin_key": ok,
        "path_key": pk,
        "host": host or None,
        "asset_id": str(asset_id) if asset_id else None,
        "first_seen_at": ts,
        "first_conversation_id": str(conversation_id) if conversation_id else None,
        "last_seen_at": ts,
        "last_conversation_id": str(conversation_id) if conversation_id else None,
    }
    inventory[key] = record
    return {"is_new": True, "key": key, "record": record}


def admit_many_memory(
    inventory: dict[str, dict[str, Any]],
    surfaces: list[dict],
    *,
    conversation_id: str | None = None,
    now: str | None = None,
) -> dict[str, bool]:
    """Admit many surface rows; return map identity_key → is_new (first admit)."""
    novelty: dict[str, bool] = {}
    ts = now or _now_iso()
    for raw in surfaces:
        if not isinstance(raw, dict):
            continue
        ok = str(raw.get("origin_key") or "").strip()
        if not ok:
            continue
        pk = "" if raw.get("path_key") is None else str(raw.get("path_key")).strip()
        result = admit_identity_memory(
            inventory,
            ok,
            pk,
            conversation_id=conversation_id,
            asset_id=str(raw["asset_id"]) if raw.get("asset_id") else None,
            now=ts,
        )
        novelty[result["key"]] = bool(result["is_new"])
    return novelty


def stamp_is_new_from_novelty(
    surfaces: list[dict],
    novelty: dict[str, bool],
) -> list[dict]:
    """Copy surfaces and set is_new from inventory novelty map (missing → False)."""
    out: list[dict] = []
    for raw in surfaces:
        if not isinstance(raw, dict):
            continue
        row = dict(raw)
        ok = str(row.get("origin_key") or "").strip()
        pk = "" if row.get("path_key") is None else str(row.get("path_key")).strip()
        key = inventory_identity_key(ok, pk)
        if key in novelty:
            row["is_new"] = bool(novelty[key])
        else:
            # False-safe: unknown novelty is not NEW
            row["is_new"] = coerce_is_new_flag(row.get("is_new"), default=False)
        out.append(row)
    return out


def merge_with_inventory_novelty(
    context: dict | None,
    surfaces: list[dict],
    inventory: dict[str, dict[str, Any]],
    *,
    conversation_id: str | None = None,
    row_cap: int | None = None,
    allow_booked: bool = False,
) -> tuple[dict, list[dict], dict[str, bool]]:
    """Pure end-to-end: admit inventory → stamp is_new → merge Case ledger.

    Returns (next_context, landed_rows, novelty_map).
    Inventory is mutated (caller owns the map). Case ledger sticky is_new is
    enforced inside merge_surface_row.
    """
    from app.services.surface_ledger import (
        DEFAULT_ROW_CAP,
        merge_surfaces_into_context,
    )

    cap = DEFAULT_ROW_CAP if row_cap is None else row_cap
    novelty = admit_many_memory(
        inventory,
        surfaces,
        conversation_id=conversation_id,
    )
    stamped = stamp_is_new_from_novelty(surfaces, novelty)
    next_ctx, landed = merge_surfaces_into_context(
        context,
        stamped,
        row_cap=cap,
        allow_booked=allow_booked,
    )
    return next_ctx, landed, novelty


# ---------------------------------------------------------------------------
# Platform DB admit (async) — used by surface_upsert dual-write path
# ---------------------------------------------------------------------------


async def admit_surfaces_for_user(
    db: Any,
    *,
    user_id: Any,
    conversation_id: Any | None,
    surfaces: list[dict],
) -> dict[str, bool]:
    """Persist identities into surface_inventory; return key → first-admit.

    Soft on failure of individual rows (caller still merges Case ledger).
    Optional asset_id is resolved by host match on Asset.address when possible.
    Does not touch Case ledger status (no auto-TESTED).
    """
    import uuid as _uuid

    from sqlalchemy import select

    from app.models.asset import Asset
    from app.models.surface_inventory import SurfaceInventory

    if not user_id or not surfaces:
        return {}

    uid = user_id if isinstance(user_id, _uuid.UUID) else _uuid.UUID(str(user_id))
    conv_uuid: _uuid.UUID | None = None
    if conversation_id:
        try:
            conv_uuid = (
                conversation_id
                if isinstance(conversation_id, _uuid.UUID)
                else _uuid.UUID(str(conversation_id))
            )
        except (TypeError, ValueError):
            conv_uuid = None

    # Collect distinct identities from payload.
    identities: list[tuple[str, str, str]] = []  # (key, origin, path)
    seen_keys: set[str] = set()
    for raw in surfaces:
        if not isinstance(raw, dict):
            continue
        ok = str(raw.get("origin_key") or "").strip()
        if not ok:
            continue
        pk = "" if raw.get("path_key") is None else str(raw.get("path_key")).strip()
        key = inventory_identity_key(ok, pk)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        identities.append((key, ok, pk))

    if not identities:
        return {}

    # Prefetch existing inventory rows for this user (settle batches are small).
    existing_by_key: dict[str, Any] = {}
    result = await db.execute(
        select(SurfaceInventory).where(SurfaceInventory.user_id == uid)
    )
    for row in result.scalars().all():
        k = inventory_identity_key(row.origin_key, row.path_key or "")
        existing_by_key[k] = row

    # Prefetch assets by host for optional asset_id fill.
    hosts = {host_from_origin_key(ok) for _k, ok, _pk in identities}
    hosts.discard("")
    asset_by_host: dict[str, _uuid.UUID] = {}
    if hosts:
        ar = await db.execute(
            select(Asset).where(Asset.user_id == uid, Asset.address.in_(list(hosts)))
        )
        for asset in ar.scalars().all():
            addr = str(asset.address or "").strip().lower()
            if addr:
                asset_by_host[addr] = asset.id

    now = datetime.now(timezone.utc)
    novelty: dict[str, bool] = {}

    for key, ok, pk in identities:
        host = host_from_origin_key(ok) or None
        asset_id = asset_by_host.get(host) if host else None
        existing = existing_by_key.get(key)
        if existing is not None:
            existing.last_seen_at = now
            if conv_uuid is not None:
                existing.last_conversation_id = conv_uuid
            if asset_id is not None and existing.asset_id is None:
                existing.asset_id = asset_id
            novelty[key] = False
            continue

        inv = SurfaceInventory(
            id=_uuid.uuid4(),
            user_id=uid,
            asset_id=asset_id,
            origin_key=ok[:500],
            path_key=(pk or "")[:1000],
            host=(host[:255] if host else None),
            first_conversation_id=conv_uuid,
            last_conversation_id=conv_uuid,
            first_seen_at=now,
            last_seen_at=now,
        )
        db.add(inv)
        existing_by_key[key] = inv
        novelty[key] = True

    # Flush so unique constraint races surface before Case commit when possible.
    await db.flush()
    return novelty

