"""Node-authenticated ledger access for workspace assistant tools.

Hosts: list/get/enrich always; create when the user asked (reason required).
Vulnerabilities: list/get + management status transitions.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.conversation import Conversation
from app.models.owner_ledger import AssetAssembly, AssetGroup
from app.models.vulnerability import Vulnerability
from app.services.asset_ledger import (
    MAX_AGENT_HOST_CREATE,
    expand_host_specs,
    extract_aliases,
    extract_services,
    identity_match_kind,
    identity_query_key,
    identity_values,
    infer_asset_type,
    merge_discover_properties,
    merge_tags,
    normalize_assembly_ports,
    normalize_port,
    normalize_tags,
)

# Management lifecycle (same as vulnerabilities API)
ALLOWED_STATUSES = frozenset({"to_fix", "fixing", "fixed"})


def conversation_bound_to_node_id(conv_node_id: uuid.UUID | None, node_id: str | None) -> bool:
    incoming = str(node_id or "").strip()
    if conv_node_id is None or not incoming:
        return False
    return str(conv_node_id) == incoming


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
    """Return error if *enrich* payload smuggles host create (must use create endpoint)."""
    if not isinstance(body, dict):
        return None
    if body.get("create_host") is True or body.get("create") is True:
        return "host create denied on enrich: use platform_create_asset when the user asked to add Hosts"
    if str(body.get("op") or "").lower() in {"create_asset", "create_host", "add_host"}:
        return "host create denied on enrich: use platform_create_asset when the user asked to add Hosts"
    return None


async def find_group_member_by_address(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    group_id: uuid.UUID,
    address: str,
) -> Asset | None:
    """Host with this address already assembled into the Group (group-scoped identity)."""
    host = str(address or "").strip()
    if not host:
        return None
    stmt = (
        select(Asset)
        .join(AssetAssembly, AssetAssembly.asset_id == Asset.id)
        .where(
            AssetAssembly.group_id == group_id,
            Asset.user_id == user_id,
            Asset.address == host,
        )
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def create_hosts_for_user(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    conversation_id: str | None = None,
    addresses: list[str] | str | None = None,
    address: str | None = None,
    ports: object = None,
    services: object = None,
    tags: object = None,
    reason: str = "",
    group_id: str | None = None,
    group_name: str | None = None,
    assembly_ports: object = None,
    exclude_last_octets: object = None,
) -> dict[str, Any]:
    """Create or merge Hosts when the user asked the Agent to add inventory.

    Requires non-empty ``reason`` (agent-authored summary of the user request).
    Optional ``group_id`` / ``group_name`` puts each Host into that Group assembly
    (empty ports = bare Host in the Group — Spec #454).
    """
    reason_text = str(reason or "").strip()
    if not reason_text:
        raise NodeLedgerError(
            "reason required: only create Hosts when the user explicitly asked "
            "(pass a short quote/summary of their request)",
            status_code=400,
        )

    specs: list[str] = []
    if address and str(address).strip():
        specs.append(str(address).strip())
    if isinstance(addresses, str) and addresses.strip():
        specs.append(addresses.strip())
    elif isinstance(addresses, list):
        specs.extend(str(a).strip() for a in addresses if str(a or "").strip())
    skip: list[int] = []
    if isinstance(exclude_last_octets, list):
        for x in exclude_last_octets:
            try:
                skip.append(int(x))
            except (TypeError, ValueError):
                continue
    try:
        hosts = expand_host_specs(specs, exclude_last_octets=skip or None)
    except ValueError as e:
        raise NodeLedgerError(str(e), status_code=400) from e
    if not hosts:
        raise NodeLedgerError("no valid host addresses to create", status_code=400)

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
                service_list.append(dict(s))
                np = normalize_port(s.get("port"))
                if np:
                    port_list.append(np)

    tag_list = normalize_tags(tags)
    conv_uuid: uuid.UUID | None = None
    if conversation_id:
        try:
            conv_uuid = uuid.UUID(str(conversation_id))
        except ValueError:
            conv_uuid = None

    from app.services.owner_services import load_official_services, upsert_official_service

    # Resolve optional Group once: merge only if address already a *member* of that Group.
    # Same IP in another Group / ungrouped → new Host (identity = asset id, not address).
    target_group: AssetGroup | None = None
    gid = str(group_id or "").strip()
    gname = str(group_name or "").strip()
    if gid or gname:
        target_group = await resolve_group(
            db, user_id=user_id, group_id=gid or None, group_name=gname or None
        )

    created: list[dict[str, Any]] = []
    merged: list[dict[str, Any]] = []
    for host in hosts:
        a: Asset | None = None
        if target_group is not None:
            a = await find_group_member_by_address(
                db, user_id=user_id, group_id=target_group.id, address=host
            )
        if a:
            a.tags = merge_tags(a.tags, tag_list)
            a.properties = merge_discover_properties(
                a.properties,
                open_ports=port_list or None,
                services=service_list or None,
            )
            if conv_uuid and not a.conversation_id:
                a.conversation_id = conv_uuid
            is_new = False
        else:
            props = merge_discover_properties(
                {},
                open_ports=port_list or [],
                services=service_list or None,
            )
            a = Asset(
                id=uuid.uuid4(),
                user_id=user_id,
                name=host,
                address=host,
                type=infer_asset_type(host),
                tags=tag_list,
                properties=props,
                source="agent",
                conversation_id=conv_uuid,
            )
            db.add(a)
            await db.flush()
            is_new = True

        seen_ports: set[str] = set()
        for svc in service_list:
            p = normalize_port(svc.get("port"))
            if not p:
                continue
            await upsert_official_service(
                db,
                asset_id=a.id,
                port=p,
                source="agent",
                name=str(svc.get("name") or svc.get("service") or "") or None,
                protocol=str(svc["protocol"]).strip() if svc.get("protocol") else None,
            )
            seen_ports.add(p)
        for p in port_list:
            pn = normalize_port(p)
            if not pn or pn in seen_ports:
                continue
            await upsert_official_service(db, asset_id=a.id, port=pn, source="agent")
            seen_ports.add(pn)

        await db.flush()
        official = await load_official_services(db, [a.id])
        row = asset_to_dict(a, official_services=official.get(a.id))
        row["created"] = is_new
        (created if is_new else merged).append(row)

    group_attach: dict[str, Any] | None = None
    if target_group is not None:
        asset_ids = [str(r["id"]) for r in (created + merged) if r.get("id")]
        group_attach = await put_hosts_in_group(
            db,
            user_id=user_id,
            group_id=str(target_group.id),
            group_name=None,
            asset_ids=asset_ids,
            ports=assembly_ports if assembly_ports is not None else port_list,
            reason=reason_text,
            commit=False,
        )

    await db.commit()
    out: dict[str, Any] = {
        "ok": True,
        "reason": reason_text,
        "requested": len(hosts),
        "created_count": len(created),
        "merged_count": len(merged),
        "created": created,
        "merged": merged,
        "assets": created + merged,
        "note": (
            "Hosts written to the shared owner ledger (same as 资产管理). "
            "Agent create requires an explicit user request (reason)."
        ),
    }
    if group_attach is not None:
        out["group"] = group_attach.get("group")
        out["assembly"] = group_attach
    return out


def _group_to_dict(
    group: AssetGroup,
    members: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "id": str(group.id),
        "name": group.name,
        "member_count": len(members or []),
        "members": members or [],
        "created_at": group.created_at.isoformat() if group.created_at else None,
        "updated_at": group.updated_at.isoformat() if group.updated_at else None,
    }


async def list_groups_for_user(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    q: str | None = None,
    limit: int = 50,
    include_members: bool = False,
    member_sample: int = 20,
) -> list[dict[str, Any]]:
    """List owner Groups (资产管理分组) for the conversation owner.

    Compact by default so chat wire can carry hundreds of hosts: full ``addresses``
    list + ``member_count``; ``members`` is only a short sample unless include_members.
    """
    limit = max(1, min(int(limit or 50), 100))
    sample_n = max(0, min(int(member_sample or 20), 500))
    stmt = (
        select(AssetGroup)
        .where(AssetGroup.user_id == user_id)
        .order_by(AssetGroup.name.asc())
        .limit(limit)
    )
    if q and str(q).strip():
        like = f"%{str(q).strip()}%"
        stmt = stmt.where(AssetGroup.name.ilike(like))
    groups = list((await db.execute(stmt)).scalars().all())
    if not groups:
        return []
    members_by: dict[uuid.UUID, list[dict[str, Any]]] = {g.id: [] for g in groups}
    gids = [g.id for g in groups]
    rows = list(
        (await db.execute(select(AssetAssembly).where(AssetAssembly.group_id.in_(gids)))).scalars().all()
    )
    asset_ids = {r.asset_id for r in rows}
    assets_map: dict[uuid.UUID, Asset] = {}
    if asset_ids:
        ares = await db.execute(select(Asset).where(Asset.id.in_(asset_ids)))
        assets_map = {a.id: a for a in ares.scalars().all()}
    for row in rows:
        host = assets_map.get(row.asset_id)
        aliases: list[str] = []
        if host:
            aliases = extract_aliases(host.properties or {}, host.address)
        members_by.setdefault(row.group_id, []).append(
            {
                "asset_id": str(row.asset_id),
                "address": host.address if host else None,
                "aliases": aliases,
                "ports": list(row.ports or []),
            }
        )
    out: list[dict[str, Any]] = []
    for g in groups:
        full = members_by.get(g.id, [])
        # Sort for stable agent diffs
        full = sorted(full, key=lambda m: str(m.get("address") or m.get("asset_id") or ""))
        addresses = [str(m["address"]) for m in full if m.get("address")]
        row = _group_to_dict(g, full if include_members else full[:sample_n])
        row["member_count"] = len(full)
        row["addresses"] = addresses
        if not include_members and len(full) > sample_n:
            row["members_sample"] = sample_n
            row["members_note"] = (
                f"members shows first {sample_n} of {len(full)}; "
                "use addresses for the full host list"
            )
        out.append(row)
    return out


async def resolve_group(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    group_id: str | None = None,
    group_name: str | None = None,
) -> AssetGroup:
    gid = str(group_id or "").strip()
    gname = str(group_name or "").strip()
    if gid:
        try:
            guid = uuid.UUID(gid)
        except ValueError as e:
            raise NodeLedgerError("invalid group_id", status_code=400) from e
        group = (
            await db.execute(
                select(AssetGroup).where(AssetGroup.id == guid, AssetGroup.user_id == user_id)
            )
        ).scalar_one_or_none()
        if not group:
            raise NodeLedgerError("group not found", status_code=404)
        return group
    if not gname:
        raise NodeLedgerError("group_id or group_name required", status_code=400)
    # Exact (case-insensitive) first, then unique substring match.
    exact = (
        await db.execute(
            select(AssetGroup).where(
                AssetGroup.user_id == user_id,
                func.lower(AssetGroup.name) == gname.lower(),
            )
        )
    ).scalar_one_or_none()
    if exact:
        return exact
    like = f"%{gname}%"
    hits = list(
        (
            await db.execute(
                select(AssetGroup)
                .where(AssetGroup.user_id == user_id, AssetGroup.name.ilike(like))
                .order_by(AssetGroup.name.asc())
                .limit(10)
            )
        ).scalars().all()
    )
    if not hits:
        raise NodeLedgerError(f"group not found: {gname}", status_code=404)
    if len(hits) > 1:
        names = ", ".join(h.name for h in hits[:8])
        raise NodeLedgerError(
            f"group name ambiguous ({len(hits)} matches): {names}. Pass group_id.",
            status_code=400,
        )
    return hits[0]


async def put_hosts_in_group(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    group_id: str | None = None,
    group_name: str | None = None,
    asset_ids: list[str] | None = None,
    addresses: list[str] | str | None = None,
    ports: object = None,
    reason: str = "",
    commit: bool = True,
) -> dict[str, Any]:
    """Put Hosts into a Group assembly (user-requested inventory organization)."""
    reason_text = str(reason or "").strip()
    if not reason_text:
        raise NodeLedgerError(
            "reason required: only change Group assembly when the user asked",
            status_code=400,
        )
    group = await resolve_group(db, user_id=user_id, group_id=group_id, group_name=group_name)
    port_list = normalize_assembly_ports(ports if ports is not None else [])

    ids: list[uuid.UUID] = []
    seen_ids: set[uuid.UUID] = set()
    ambiguous_addresses: list[str] = []

    def _add_id(aid: uuid.UUID) -> None:
        if aid not in seen_ids:
            seen_ids.add(aid)
            ids.append(aid)

    for raw in asset_ids or []:
        try:
            _add_id(uuid.UUID(str(raw)))
        except ValueError:
            continue
    if addresses:
        try:
            hosts = expand_host_specs(addresses)
        except ValueError as e:
            raise NodeLedgerError(str(e), status_code=400) from e
        owned = list(
            (await db.execute(select(Asset).where(Asset.user_id == user_id))).scalars().all()
        )
        in_group_ids = set(
            (
                await db.execute(
                    select(AssetAssembly.asset_id).where(AssetAssembly.group_id == group.id)
                )
            ).scalars().all()
        )
        for host in hosts:
            key = identity_query_key(host)
            if not key:
                continue
            matches = [
                a for a in owned if key in identity_values(a.address, a.properties or {})
            ]
            if not matches:
                continue
            if len(matches) == 1:
                _add_id(matches[0].id)
                continue
            in_group = [a for a in matches if a.id in in_group_ids]
            if len(in_group) == 1:
                _add_id(in_group[0].id)
            elif len(in_group) > 1:
                for a in in_group:
                    _add_id(a.id)
            else:
                ambiguous_addresses.append(host)

    if not ids:
        msg = "no asset_ids or known addresses to put in group"
        if ambiguous_addresses:
            msg += (
                f"; ambiguous identity needs asset_ids (primary or alias on multiple Hosts): "
                f"{', '.join(ambiguous_addresses[:8])}"
            )
        raise NodeLedgerError(msg, status_code=400)

    attached: list[dict[str, Any]] = []
    missing: list[str] = []
    for aid in ids:
        asset = (
            await db.execute(select(Asset).where(Asset.id == aid, Asset.user_id == user_id))
        ).scalar_one_or_none()
        if not asset:
            missing.append(str(aid))
            continue
        existing = (
            await db.execute(
                select(AssetAssembly).where(
                    AssetAssembly.group_id == group.id,
                    AssetAssembly.asset_id == aid,
                )
            )
        ).scalar_one_or_none()
        if existing:
            existing.ports = port_list
        else:
            db.add(
                AssetAssembly(
                    id=uuid.uuid4(),
                    group_id=group.id,
                    asset_id=aid,
                    ports=port_list,
                )
            )
        attached.append({"asset_id": str(aid), "address": asset.address, "ports": port_list})

    if commit:
        await db.commit()
    else:
        await db.flush()

    return {
        "ok": True,
        "reason": reason_text,
        "group": _group_to_dict(group, None),
        "attached_count": len(attached),
        "attached": attached,
        "missing_asset_ids": missing,
        "ambiguous_addresses": ambiguous_addresses,
        "note": (
            "Hosts assembled into Group (empty ports = bare Host in Group). "
            "Same address may map to multiple Hosts; use asset_ids when ambiguous."
        ),
    }


async def create_group_for_user(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    name: str,
    reason: str = "",
) -> dict[str, Any]:
    """Create a Group when the user asked (e.g. 帮我建「XXX公司」组)."""
    reason_text = str(reason or "").strip()
    if not reason_text:
        raise NodeLedgerError(
            "reason required: only create Groups when the user asked",
            status_code=400,
        )
    gname = str(name or "").strip()
    if not gname:
        raise NodeLedgerError("group name required", status_code=400)
    clash = (
        await db.execute(
            select(AssetGroup).where(
                AssetGroup.user_id == user_id,
                func.lower(AssetGroup.name) == gname.lower(),
            )
        )
    ).scalar_one_or_none()
    if clash:
        return {
            "ok": True,
            "created": False,
            "group": _group_to_dict(clash, None),
            "note": "group already exists",
            "reason": reason_text,
        }
    group = AssetGroup(id=uuid.uuid4(), user_id=user_id, name=gname)
    db.add(group)
    await db.commit()
    await db.refresh(group)
    return {
        "ok": True,
        "created": True,
        "group": _group_to_dict(group, None),
        "reason": reason_text,
    }


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


def asset_to_dict(a: Asset, *, official_services: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    props = a.properties if isinstance(a.properties, dict) else {}
    # Prefer official Service rows (user/agent enrich); fall back to properties.services.
    services = list(official_services) if official_services is not None else extract_services(props)
    note = ""
    for key in ("note", "remark", "comment"):
        text = str(props.get(key) or "").strip()
        if text:
            note = text
            break
    return {
        "id": str(a.id),
        "name": a.name,
        "address": a.address,
        "type": a.type,
        "tags": list(a.tags or []),
        "aliases": extract_aliases(props, a.address),
        "note": note or None,
        "properties": props,
        "services": services,
        "open_ports": [str(s.get("port")) for s in services if s.get("port")],
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
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    """List owner-ledger Hosts for the conversation owner (user-wide, not Case-scoped).

    ``conversation_id`` is accepted for call-site compatibility but does **not**
    filter rows — Agent and 资产管理 share the same Host inventory.

    Returns ``(items, total_count)`` so agents never confuse page size with inventory size.
    """
    _ = conversation_id
    limit = max(1, min(int(limit or 50), 2000))
    offset = max(0, int(offset or 0))
    filters = []
    if user_id:
        filters.append(or_(Asset.user_id == user_id, Asset.user_id.is_(None)))
    if q and str(q).strip():
        like = f"%{str(q).strip()}%"
        tags_text = func.coalesce(func.array_to_string(Asset.tags, ","), "")
        props_text = cast(Asset.properties, String)
        filters.append(
            or_(
                Asset.address.ilike(like),
                Asset.name.ilike(like),
                tags_text.ilike(like),
                props_text.ilike(like),
            )
        )
    count_stmt = select(func.count()).select_from(Asset)
    for f in filters:
        count_stmt = count_stmt.where(f)
    total = int((await db.execute(count_stmt)).scalar_one() or 0)

    stmt = select(Asset).order_by(Asset.updated_at.desc()).offset(offset).limit(limit)
    for f in filters:
        stmt = stmt.where(f)
    result = await db.execute(stmt)
    assets = list(result.scalars().all())
    official: dict[uuid.UUID, list[dict[str, Any]]] = {}
    if assets:
        try:
            from app.services.owner_services import load_official_services

            official = await load_official_services(db, [a.id for a in assets])
        except Exception:
            official = {}
    items = [asset_to_dict(a, official_services=official.get(a.id)) for a in assets]
    return items, total


async def _groups_by_asset_ids(
    db: AsyncSession,
    user_id: uuid.UUID,
    asset_ids: list[uuid.UUID],
) -> dict[str, list[dict[str, str]]]:
    if not asset_ids:
        return {}
    rows = (
        await db.execute(
            select(AssetAssembly.asset_id, AssetGroup.id, AssetGroup.name)
            .join(AssetGroup, AssetGroup.id == AssetAssembly.group_id)
            .where(
                AssetAssembly.asset_id.in_(asset_ids),
                AssetGroup.user_id == user_id,
            )
            .order_by(AssetGroup.name.asc())
        )
    ).all()
    out: dict[str, list[dict[str, str]]] = {}
    for aid, gid, name in rows:
        out.setdefault(str(aid), []).append({"id": str(gid), "name": str(name)})
    return out


async def list_assets_with_identity(
    db: AsyncSession,
    *,
    user_id: uuid.UUID | None,
    conversation_id: str | None = None,
    q: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int, dict[str, Any]]:
    """Agent list: exact identity (primary∪aliases) before fuzzy note search.

    When q is a ledger address: unique / ambiguous / none.
    Ambiguous returns only those Hosts — Agent must request_user_decision, never first-match.
    None falls through to existing ilike (notes/tags) so Q&A still works.
    """
    meta: dict[str, Any] = {}
    key = identity_query_key(q)
    if user_id and key:
        from app.services.owner_services import list_assets_by_identity, load_official_services

        hits = await list_assets_by_identity(db, user_id, key)
        kind = identity_match_kind(len(hits))
        meta = {"identity": kind, "identity_query": key}
        if kind != "none":
            if kind == "ambiguous":
                meta["next"] = "request_user_decision"
            limit_n = max(1, min(int(limit or 50), 2000))
            offset_n = max(0, int(offset or 0))
            total = len(hits)
            page = hits[offset_n : offset_n + limit_n]
            official: dict[uuid.UUID, list[dict[str, Any]]] = {}
            if page:
                official = await load_official_services(db, [a.id for a in page])
            groups = await _groups_by_asset_ids(db, user_id, [a.id for a in page])
            items = []
            for a in page:
                row = asset_to_dict(a, official_services=official.get(a.id))
                row["groups"] = groups.get(str(a.id), [])
                items.append(row)
            return items, total, meta
    items, total = await list_assets(
        db,
        user_id=user_id,
        conversation_id=conversation_id,
        q=q,
        limit=limit,
        offset=offset,
    )
    return items, total, meta


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
    official: list[dict[str, Any]] | None = None
    try:
        from app.services.owner_services import load_official_services

        loaded = await load_official_services(db, [a.id])
        official = loaded.get(a.id)
    except Exception:
        official = None
    return asset_to_dict(a, official_services=official)


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
    offset: int = 0,
    conversation_only: bool = False,
    asset_id: str | None = None,
    asset_ids: list[str] | None = None,
    port: str | None = None,
    q: str | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """
    List ledger findings for agent tools.

    Default: **user-wide** (all Cases) so experts can see prior findings on the
    same asset before booking and treat matches as rediscovery — not only this
    conversation's rows. Pass conversation_only=True to restrict.
    Prefer **asset_id / asset_ids** when the Scope Host is known (same filter grain
    as the product 漏洞台账 UI) so agents do not confuse global top-N with one Host.

    Returns ``(items, total_count)``.
    """
    from sqlalchemy import func

    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
    filters = []
    if user_id:
        filters.append(or_(Vulnerability.user_id == user_id, Vulnerability.user_id.is_(None)))
    if conversation_only and conversation_id:
        try:
            cid = uuid.UUID(str(conversation_id))
            filters.append(
                or_(Vulnerability.conversation_id == cid, Vulnerability.conversation_id.is_(None))
            )
        except ValueError:
            pass
    if status and str(status).strip():
        want = normalize_finding_status(status) or str(status).strip().lower()
        filters.append(Vulnerability.status == want)

    # Asset filter (UI-parity): single id and/or multi ids.
    aid_set: list[uuid.UUID] = []
    for raw in list(asset_ids or []) + ([asset_id] if asset_id else []):
        s = str(raw or "").strip()
        if not s:
            continue
        try:
            aid_set.append(uuid.UUID(s))
        except ValueError:
            continue
    # de-dupe preserve order
    seen_aid: set[uuid.UUID] = set()
    aids: list[uuid.UUID] = []
    for a in aid_set:
        if a in seen_aid:
            continue
        seen_aid.add(a)
        aids.append(a)
    if aids:
        filters.append(Vulnerability.asset_id.in_(aids))

    port_s = str(port or "").strip()
    if port_s:
        from app.services.asset_ledger import normalize_port

        filters.append(Vulnerability.port == (normalize_port(port_s) or port_s))
    needle = str(q or "").strip()
    if needle:
        like = f"%{needle}%"
        filters.append(
            or_(
                Vulnerability.title.ilike(like),
                Vulnerability.description.ilike(like),
                Vulnerability.location_key.ilike(like),
            )
        )

    count_stmt = select(func.count()).select_from(Vulnerability)
    for f in filters:
        count_stmt = count_stmt.where(f)
    total = int((await db.execute(count_stmt)).scalar_one() or 0)

    stmt = (
        select(Vulnerability)
        .order_by(Vulnerability.updated_at.desc())
        .offset(offset)
        .limit(limit)
    )
    for f in filters:
        stmt = stmt.where(f)
    result = await db.execute(stmt)
    return [vuln_to_dict(v) for v in result.scalars().all()], total


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


def _parse_ports_services(body: dict) -> tuple[list[str], list[dict], list[str] | None, list | None]:
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
                service_list.append(dict(s))
                np = normalize_port(s.get("port"))
                if np:
                    port_list.append(np)
            else:
                service_list.append({"name": str(s)})

    url_list = [str(u) for u in urls] if isinstance(urls, list) else None
    api_list = apis if isinstance(apis, list) else None
    seen: set[str] = set()
    uniq_ports: list[str] = []
    for p in port_list:
        if p not in seen:
            seen.add(p)
            uniq_ports.append(p)
    return uniq_ports, service_list, url_list, api_list


async def _apply_remove_ports_to_asset(
    db: AsyncSession,
    a: Asset,
    remove_ports: list[str],
) -> list[str]:
    """Drop Service ports from Host (properties + official rows + assemblies)."""
    from app.services.asset_ledger import extract_services
    from app.services.owner_services import delete_official_services

    drop = {normalize_port(p) for p in remove_ports}
    drop.discard(None)  # type: ignore[arg-type]
    drop_s = {str(p) for p in drop if p}
    if not drop_s:
        return []
    props = dict(a.properties) if isinstance(a.properties, dict) else {}
    kept = [
        dict(s)
        for s in extract_services(props)
        if normalize_port(s.get("port")) not in drop_s
    ]
    props["services"] = kept
    props["open_ports"] = [str(s.get("port")) for s in kept if s.get("port")]
    if "ports" in props:
        props["ports"] = [
            p for p in (props.get("ports") or []) if normalize_port(p) not in drop_s
        ]
    a.properties = props
    # Drop from Group assemblies that list these ports
    rows = list(
        (await db.execute(select(AssetAssembly).where(AssetAssembly.asset_id == a.id))).scalars().all()
    )
    for row in rows:
        cur = list(row.ports or [])
        nxt = [p for p in cur if normalize_port(p) not in drop_s]
        if nxt != cur:
            row.ports = nxt
    await delete_official_services(db, a.id, drop_s)
    return sorted(drop_s)


async def _apply_enrich_to_asset(
    db: AsyncSession,
    a: Asset,
    *,
    port_list: list[str],
    service_list: list[dict],
    url_list: list[str] | None,
    api_list: list | None,
    remove_ports: list[str] | None = None,
) -> None:
    """Write properties + official Service rows (same grain as UI 添加/删除端口)."""
    from app.services.owner_services import upsert_official_service

    if remove_ports:
        await _apply_remove_ports_to_asset(db, a, remove_ports)

    if not port_list and not service_list and not url_list and not api_list:
        return

    props = dict(a.properties) if isinstance(a.properties, dict) else {}
    a.properties = merge_discover_properties(
        props,
        open_ports=port_list or None,
        services=service_list or None,
        urls=url_list,
        api_endpoints=api_list,
    )
    seen_ports: set[str] = set()
    for svc in service_list:
        p = normalize_port(svc.get("port"))
        if not p:
            continue
        await upsert_official_service(
            db,
            asset_id=a.id,
            port=p,
            source="agent",
            name=str(svc.get("name") or svc.get("service") or "") or None,
            protocol=str(svc["protocol"]).strip() if svc.get("protocol") else None,
        )
        seen_ports.add(p)
    for p in port_list:
        if p in seen_ports:
            continue
        await upsert_official_service(db, asset_id=a.id, port=p, source="agent")
        seen_ports.add(p)


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

    port_list, service_list, url_list, api_list = _parse_ports_services(body)
    remove_raw = body.get("remove_ports") if isinstance(body.get("remove_ports"), list) else []
    remove_ports = [str(p) for p in remove_raw if str(p or "").strip()]
    if not port_list and not service_list and not remove_ports and not url_list and not api_list:
        raise NodeLedgerError("ports, services, or remove_ports required", status_code=400)
    await _apply_enrich_to_asset(
        db,
        a,
        port_list=port_list,
        service_list=service_list,
        url_list=url_list,
        api_list=api_list,
        remove_ports=remove_ports or None,
    )
    await db.commit()
    await db.refresh(a)
    from app.services.owner_services import load_official_services

    official = await load_official_services(db, [a.id])
    return asset_to_dict(a, official_services=official.get(a.id))


async def batch_enrich_hosts_for_user(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    reason: str = "",
    asset_ids: list[str] | None = None,
    addresses: list[str] | str | None = None,
    group_id: str | None = None,
    group_name: str | None = None,
    ports: object = None,
    services: object = None,
    remove_ports: object = None,
) -> dict[str, Any]:
    """Bulk add/remove ports/services on existing Hosts (one transaction). User-requested only."""
    reason_text = str(reason or "").strip()
    if not reason_text:
        raise NodeLedgerError(
            "reason required: only enrich Hosts when the user asked",
            status_code=400,
        )
    port_list, service_list, url_list, api_list = _parse_ports_services(
        {"ports": ports, "services": services}
    )
    remove_list = (
        [str(p) for p in remove_ports if str(p or "").strip()]
        if isinstance(remove_ports, list)
        else []
    )
    if not port_list and not service_list and not remove_list:
        raise NodeLedgerError("ports, services, or remove_ports required", status_code=400)

    ids: list[uuid.UUID] = []
    seen_ids: set[uuid.UUID] = set()

    def _add_id(aid: uuid.UUID) -> None:
        if aid not in seen_ids:
            seen_ids.add(aid)
            ids.append(aid)

    for raw in asset_ids or []:
        try:
            _add_id(uuid.UUID(str(raw)))
        except ValueError:
            continue

    missing_addr: list[str] = []
    if addresses:
        try:
            hosts = expand_host_specs(addresses)
        except ValueError as e:
            raise NodeLedgerError(str(e), status_code=400) from e
        if hosts:
            ares = await db.execute(
                select(Asset).where(Asset.user_id == user_id, Asset.address.in_(hosts))
            )
            found = list(ares.scalars().all())
            found_addrs = {a.address for a in found}
            for a in found:
                _add_id(a.id)
            missing_addr = [h for h in hosts if h not in found_addrs]

    if group_id or group_name:
        group = await resolve_group(db, user_id=user_id, group_id=group_id, group_name=group_name)
        rows = list(
            (
                await db.execute(select(AssetAssembly).where(AssetAssembly.group_id == group.id))
            ).scalars().all()
        )
        for row in rows:
            _add_id(row.asset_id)

    if not ids:
        raise NodeLedgerError(
            "no asset_ids / known addresses / group members to enrich",
            status_code=400,
        )
    if len(ids) > 2000:
        raise NodeLedgerError("batch enrich max 2000 hosts per call", status_code=400)

    ares = await db.execute(select(Asset).where(Asset.user_id == user_id, Asset.id.in_(ids)))
    assets = list(ares.scalars().all())
    by_id = {a.id: a for a in assets}
    updated: list[dict[str, Any]] = []
    missing_ids: list[str] = []
    for aid in ids:
        a = by_id.get(aid)
        if not a:
            missing_ids.append(str(aid))
            continue
        await _apply_enrich_to_asset(
            db,
            a,
            port_list=port_list,
            service_list=service_list,
            url_list=url_list,
            api_list=api_list,
            remove_ports=remove_list or None,
        )
        updated.append(
            {
                "asset_id": str(a.id),
                "address": a.address,
                "ports_added": port_list,
                "ports_removed": remove_list,
            }
        )

    await db.commit()
    return {
        "ok": True,
        "reason": reason_text,
        "updated_count": len(updated),
        "updated": updated[:50],
        "updated_total": len(updated),
        "missing_asset_ids": missing_ids,
        "missing_addresses": missing_addr,
        "ports": port_list,
        "remove_ports": remove_list,
        "note": (
            "Host Service rows updated (same as 资产管理 添加/删除端口). "
            "Group assembly ports are separate — use platform_assemble_group only for Group subset."
        ),
    }


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
    vulns, _vuln_total = await list_vulnerabilities(
        db, user_id=user_id, conversation_id=str(cid), limit=20
    )
    assets, _asset_total = await list_assets(db, user_id=user_id, conversation_id=str(cid), limit=20)
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
