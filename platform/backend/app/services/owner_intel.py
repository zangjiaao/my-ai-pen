"""Owner-ledger Intel (线索 / 情报) — Spec owner-intel.md / map #459.

Agent supplies summary + body + hang + kind. Harness stamps id / time / source /
created_task_id / forget_count / New. Status is derived from forget_count.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Iterable, Literal

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.owner_intel import AssetIntel
from app.services.asset_ledger import normalize_port

INTEL_KINDS = (
    "credential_status",
    "secret",
    "token",
    "flag",
    "path_hint",
    "account",
    "config",
)
SECRET_KINDS = frozenset({"secret", "token", "flag"})
MAX_SUMMARY = 400
MAX_BODY = 8000
MAX_INTEL_INJECT = 20

Audience = Literal["agent", "user"]


class IntelError(Exception):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def normalize_kind(raw: object) -> str:
    key = str(raw or "").strip().lower()
    if key in INTEL_KINDS:
        return key
    # Missing / invented → closest generic operational note. Do not drop.
    return "config"


def default_sensitivity(kind: str) -> str:
    return "secret" if normalize_kind(kind) in SECRET_KINDS else "plain"


def status_from_forget_count(count: int) -> str:
    n = int(count or 0)
    if n <= 0:
        return "active"
    if n == 1:
        return "forgotten"
    return "sealed"


def apply_forget(forget_count: int) -> dict[str, Any]:
    nxt = int(forget_count or 0) + 1
    return {"forget_count": nxt, "status": status_from_forget_count(nxt)}


def agent_may_list(row: dict[str, Any]) -> bool:
    return status_from_forget_count(int(row.get("forget_count") or 0)) == "active"


def agent_may_get(row: dict[str, Any]) -> bool:
    return status_from_forget_count(int(row.get("forget_count") or 0)) != "sealed"


def agent_may_update(row: dict[str, Any]) -> bool:
    return agent_may_get(row)


def normalize_hang(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("group_id") or payload.get("group"):
        raise ValueError("group hang is not v1 — hang on a Host or Host+port")
    asset_id = str(payload.get("asset_id") or payload.get("host_id") or "").strip()
    if not asset_id:
        raise ValueError("hang requires asset_id (Host)")
    port_raw = payload.get("port")
    port = None
    if port_raw is not None and str(port_raw).strip() != "":
        port = normalize_port(port_raw) or str(port_raw).strip()
    return {"asset_id": asset_id, "port": port}


_AGENT_AUDIT_KEYS = frozenset(
    {
        "created_at",
        "updated_at",
        "source",
        "new",
        "is_new",
        "forget_count",
        "status",
        "sensitivity",
        "created_task_id",
    }
)


def strip_agent_audit_fields(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop harness-owned fields the Agent must not author."""
    return {k: v for k, v in payload.items() if k not in _AGENT_AUDIT_KEYS}


def project_new(row: dict[str, Any], *, current_task_id: str | None) -> dict[str, Any]:
    out = dict(row)
    cur = str(current_task_id or "").strip()
    created = str(row.get("created_task_id") or "").strip()
    out["is_new"] = bool(cur and created and cur == created)
    return out


def format_intel_inject_line(row: dict[str, Any]) -> str:
    iid = str(row.get("id") or "").strip() or "?"
    summary = str(row.get("summary") or "").strip() or "(no summary)"
    hang = str(row.get("asset_id") or "").strip()
    port = row.get("port")
    if port:
        hang = f"{hang}:{port}" if hang else f":{port}"
    hang_bit = f" hang={hang}" if hang else ""
    kind = str(row.get("kind") or "").strip()
    kind_bit = f" kind={kind}" if kind else ""
    return f"- {iid}{kind_bit}{hang_bit} — {summary}"


def intel_summary_lines(rows: Iterable[dict[str, Any]], *, limit: int = MAX_INTEL_INJECT) -> list[str]:
    out: list[str] = []
    for row in rows:
        if not agent_may_list(row):
            continue
        out.append(format_intel_inject_line(row))
        if len(out) >= max(1, int(limit)):
            break
    return out


def intel_to_dict(row: AssetIntel, *, include_body: bool = True) -> dict[str, Any]:
    forget = int(row.forget_count or 0)
    data: dict[str, Any] = {
        "id": str(row.id),
        "asset_id": str(row.asset_id),
        "port": row.port,
        "kind": row.kind,
        "summary": row.summary,
        "source": row.source,
        "created_task_id": row.created_task_id,
        "forget_count": forget,
        "status": status_from_forget_count(forget),
        "sensitivity": row.sensitivity,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
    if include_body:
        data["body"] = row.body
    return data


async def _require_host(
    db: AsyncSession,
    asset_id: str,
    *,
    user_id: uuid.UUID | None,
) -> Asset:
    try:
        aid = uuid.UUID(str(asset_id))
    except ValueError as e:
        raise IntelError("invalid asset_id", status_code=400) from e
    asset = (await db.execute(select(Asset).where(Asset.id == aid))).scalar_one_or_none()
    if not asset:
        raise IntelError("host not found — do not invent a Host to hang intel", status_code=404)
    if user_id and asset.user_id and asset.user_id != user_id:
        raise IntelError("host not found — do not invent a Host to hang intel", status_code=404)
    return asset


async def record_intel(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    payload: dict[str, Any],
    source: str,
    created_task_id: str | None = None,
) -> dict[str, Any]:
    """Create (no id) or update (id). Agent-supplied fields only; harness stamps audit."""
    body = strip_agent_audit_fields(payload if isinstance(payload, dict) else {})
    intel_id = str(body.pop("id", "") or "").strip()
    try:
        hang = normalize_hang(body)
    except ValueError as e:
        raise IntelError(str(e), status_code=400) from e
    await _require_host(db, hang["asset_id"], user_id=user_id)

    summary = str(body.get("summary") or "").strip()
    if len(summary) < 2:
        raise IntelError("summary required", status_code=400)
    if len(summary) > MAX_SUMMARY:
        raise IntelError(f"summary too long (max {MAX_SUMMARY})", status_code=400)
    note = str(body.get("body") or "").strip()
    if len(note) < 1:
        raise IntelError("body required", status_code=400)
    if len(note) > MAX_BODY:
        raise IntelError(f"body too long (max {MAX_BODY})", status_code=400)
    kind = normalize_kind(body.get("kind"))
    now = datetime.now(timezone.utc)
    src = "user" if str(source or "").strip().lower() == "user" else "agent"

    if intel_id:
        try:
            iid = uuid.UUID(intel_id)
        except ValueError as e:
            raise IntelError("invalid id", status_code=400) from e
        row = (await db.execute(select(AssetIntel).where(AssetIntel.id == iid))).scalar_one_or_none()
        if not row or (user_id and row.user_id and row.user_id != user_id):
            raise IntelError("intel not found", status_code=404)
        if status_from_forget_count(int(row.forget_count or 0)) == "sealed":
            raise IntelError("forgotten", status_code=404)
        row.asset_id = uuid.UUID(hang["asset_id"])
        row.port = hang["port"]
        row.kind = kind
        row.summary = summary
        row.body = note
        row.sensitivity = default_sensitivity(kind)
        row.updated_at = now
        await db.commit()
        await db.refresh(row)
        return project_new(intel_to_dict(row), current_task_id=created_task_id)

    row = AssetIntel(
        id=uuid.uuid4(),
        user_id=user_id,
        asset_id=uuid.UUID(hang["asset_id"]),
        port=hang["port"],
        kind=kind,
        summary=summary,
        body=note,
        source=src,
        created_task_id=str(created_task_id or "").strip() or None,
        forget_count=0,
        sensitivity=default_sensitivity(kind),
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return project_new(intel_to_dict(row), current_task_id=created_task_id)


async def list_intel(
    db: AsyncSession,
    *,
    user_id: uuid.UUID | None,
    asset_id: str | None = None,
    asset_ids: list[str] | None = None,
    port: str | None = None,
    status: str | None = None,
    audience: Audience = "agent",
    current_task_id: str | None = None,
    limit: int = 50,
    offset: int = 0,
    include_body: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
    filters: list[Any] = []
    if user_id:
        filters.append(or_(AssetIntel.user_id == user_id, AssetIntel.user_id.is_(None)))

    aid_set: list[uuid.UUID] = []
    for raw in list(asset_ids or []) + ([asset_id] if asset_id else []):
        s = str(raw or "").strip()
        if not s:
            continue
        try:
            aid_set.append(uuid.UUID(s))
        except ValueError:
            continue
    seen: set[uuid.UUID] = set()
    aids: list[uuid.UUID] = []
    for a in aid_set:
        if a in seen:
            continue
        seen.add(a)
        aids.append(a)
    if aids:
        filters.append(AssetIntel.asset_id.in_(aids))

    if port is not None and str(port).strip() != "":
        np = normalize_port(port) or str(port).strip()
        filters.append(AssetIntel.port == np)

    want = str(status or "").strip().lower()
    if audience == "agent":
        # v1 Agent list is living only.
        filters.append(AssetIntel.forget_count <= 0)
    elif want in {"active", "living", ""}:
        filters.append(AssetIntel.forget_count <= 0)
    elif want in {"forgotten", "soft"}:
        filters.append(AssetIntel.forget_count == 1)
    elif want in {"sealed", "archive"}:
        filters.append(AssetIntel.forget_count >= 2)
    # want == "all" → no forget filter (user UI)

    count_stmt = select(func.count()).select_from(AssetIntel)
    for f in filters:
        count_stmt = count_stmt.where(f)
    total = int((await db.execute(count_stmt)).scalar_one() or 0)

    stmt = (
        select(AssetIntel)
        .order_by(AssetIntel.updated_at.desc())
        .offset(offset)
        .limit(limit)
    )
    for f in filters:
        stmt = stmt.where(f)
    rows = list((await db.execute(stmt)).scalars().all())
    items = [
        project_new(intel_to_dict(r, include_body=include_body), current_task_id=current_task_id)
        for r in rows
    ]
    return items, total


async def get_intel(
    db: AsyncSession,
    intel_id: str,
    *,
    user_id: uuid.UUID | None,
    audience: Audience = "agent",
    current_task_id: str | None = None,
) -> dict[str, Any]:
    try:
        iid = uuid.UUID(str(intel_id))
    except ValueError as e:
        raise IntelError("invalid id", status_code=400) from e
    row = (await db.execute(select(AssetIntel).where(AssetIntel.id == iid))).scalar_one_or_none()
    if not row or (user_id and row.user_id and row.user_id != user_id):
        raise IntelError("intel not found", status_code=404)
    data = project_new(intel_to_dict(row), current_task_id=current_task_id)
    if audience == "agent" and not agent_may_get(data):
        raise IntelError("forgotten", status_code=404)
    return data


async def forget_intel(
    db: AsyncSession,
    intel_id: str,
    *,
    user_id: uuid.UUID | None,
    current_task_id: str | None = None,
) -> dict[str, Any]:
    try:
        iid = uuid.UUID(str(intel_id))
    except ValueError as e:
        raise IntelError("invalid id", status_code=400) from e
    row = (await db.execute(select(AssetIntel).where(AssetIntel.id == iid))).scalar_one_or_none()
    if not row or (user_id and row.user_id and row.user_id != user_id):
        raise IntelError("intel not found", status_code=404)
    if status_from_forget_count(int(row.forget_count or 0)) == "sealed":
        raise IntelError("forgotten", status_code=404)
    nxt = apply_forget(int(row.forget_count or 0))
    row.forget_count = int(nxt["forget_count"])
    row.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(row)
    return project_new(intel_to_dict(row), current_task_id=current_task_id)


async def living_intel_for_assets(
    db: AsyncSession,
    *,
    user_id: uuid.UUID | None,
    asset_ids: list[str],
    current_task_id: str | None = None,
    limit: int = MAX_INTEL_INJECT,
) -> list[dict[str, Any]]:
    items, _ = await list_intel(
        db,
        user_id=user_id,
        asset_ids=asset_ids,
        audience="agent",
        current_task_id=current_task_id,
        limit=limit,
        include_body=False,
    )
    return items
