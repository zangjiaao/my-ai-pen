"""Owner-ledger Intel (线索 / 情报) — Spec owner-intel.md / map #459.

Agent supplies summary + body + hang + kind. Harness stamps id / time / source /
created_task_id / forget audit / access_count / New / unused-fold.
access_count increments on get(id) only (operator open / Agent get), not list or inject.
Unused across FOLD_IDLE_CASES Cases → folded (遗忘区). Hard forget is agent|user.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Iterable, Literal

from sqlalchemy import and_, false, func, or_, select, update
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
MAX_FORGET_REASON = 400
# After this many scoped Cases without get/upsert, harness folds the row off 线索.
FOLD_IDLE_CASES = 3

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
    """Hard-forget only. Folded unused is `lifecycle_status`, not this."""
    return "forgotten" if int(count or 0) >= 1 else "active"


def lifecycle_status(
    *,
    forget_count: object = 0,
    idle_case_count: object = 0,
    forgotten_by: object = None,
) -> str:
    if int(forget_count or 0) >= 1 or str(forgotten_by or "").strip():
        return "forgotten"
    if int(idle_case_count or 0) >= FOLD_IDLE_CASES:
        return "folded"
    return "active"


def apply_forget(forget_count: int) -> dict[str, Any]:
    n = int(forget_count or 0)
    nxt = 1 if n <= 0 else n
    return {"forget_count": nxt, "status": "forgotten"}


def next_idle_case_count(
    *,
    conversation_id: str,
    last_used_conversation_id: str | None,
    last_idle_conversation_id: str | None,
    idle_case_count: int,
) -> tuple[int, str | None]:
    """One increment per Case. Used this Case resets idle. Same Case not double-counted."""
    cid = str(conversation_id or "").strip()
    if not cid:
        return int(idle_case_count or 0), last_idle_conversation_id
    if str(last_used_conversation_id or "").strip() == cid:
        return 0, last_idle_conversation_id
    if str(last_idle_conversation_id or "").strip() == cid:
        return int(idle_case_count or 0), last_idle_conversation_id
    return int(idle_case_count or 0) + 1, cid


def next_access_count(access_count: object) -> int:
    try:
        n = int(access_count or 0)
    except (TypeError, ValueError):
        n = 0
    return max(0, n) + 1


def agent_may_list(row: dict[str, Any]) -> bool:
    return lifecycle_status(
        forget_count=row.get("forget_count"),
        idle_case_count=row.get("idle_case_count"),
        forgotten_by=row.get("forgotten_by"),
    ) != "forgotten"


def agent_may_get(row: dict[str, Any]) -> bool:
    return agent_may_list(row)


def agent_may_update(row: dict[str, Any]) -> bool:
    return agent_may_get(row)


def intel_port_key(port: object) -> str | None:
    """Empty / missing hang port → Host-level. Else a normalized Service port."""
    if port is None or str(port).strip() == "":
        return None
    return normalize_port(port) or str(port).strip()


def intel_matches_case_scope(
    *,
    asset_id: str,
    port: object,
    port_scope: dict[str, set[str] | None],
) -> bool:
    """Case 线索 / inject: Host-level + Scope Service ports; sibling ports out.

    port_scope[asset_id]:
      None — Scope named the Host with no ports → whole Host
      set  — those Service ports plus Host-level (empty port)
    """
    aid = str(asset_id or "").strip()
    if not aid or aid not in port_scope:
        return False
    allowed = port_scope[aid]
    if allowed is None:
        return True
    key = intel_port_key(port)
    if key is None:
        return True
    allowed_n = {intel_port_key(p) for p in allowed}
    allowed_n.discard(None)
    return key in allowed_n


def case_scope_sql_clause(port_scope: dict[str, set[str] | None]):
    """SQLAlchemy predicate matching intel_matches_case_scope."""
    parts: list[Any] = []
    host_level = or_(AssetIntel.port.is_(None), AssetIntel.port == "")
    for aid_raw, ports in (port_scope or {}).items():
        try:
            aid = uuid.UUID(str(aid_raw))
        except ValueError:
            continue
        if ports is None:
            parts.append(AssetIntel.asset_id == aid)
            continue
        allowed = sorted({p for p in (intel_port_key(x) for x in ports) if p})
        if allowed:
            parts.append(
                and_(
                    AssetIntel.asset_id == aid,
                    or_(host_level, AssetIntel.port.in_(allowed)),
                )
            )
        else:
            parts.append(and_(AssetIntel.asset_id == aid, host_level))
    return or_(*parts) if parts else false()


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
        "access_count",
        "status",
        "sensitivity",
        "created_task_id",
        "idle_case_count",
        "last_idle_conversation_id",
        "last_used_conversation_id",
        "forgotten_by",
        "forget_reason",
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
    folded: list[str] = []
    for row in rows:
        life = lifecycle_status(
            forget_count=row.get("forget_count"),
            idle_case_count=row.get("idle_case_count"),
            forgotten_by=row.get("forgotten_by"),
        )
        if life == "forgotten":
            continue
        if life == "folded":
            rid = str(row.get("id") or "").strip()
            if rid:
                folded.append(rid)
            continue
        out.append(format_intel_inject_line(row))
        if len(out) >= max(1, int(limit)):
            break
    if folded:
        shown = folded[:12]
        more = len(folded) - len(shown)
        tail = f" +{more} more" if more > 0 else ""
        out.append(
            f"Folded unused ({len(folded)}): get/upsert id to activate — {', '.join(shown)}{tail}."
        )
    return out


def intel_to_dict(row: AssetIntel, *, include_body: bool = True) -> dict[str, Any]:
    forget = int(row.forget_count or 0)
    idle = int(getattr(row, "idle_case_count", 0) or 0)
    forgotten_by = getattr(row, "forgotten_by", None)
    data: dict[str, Any] = {
        "id": str(row.id),
        "asset_id": str(row.asset_id),
        "port": row.port,
        "kind": row.kind,
        "summary": row.summary,
        "source": row.source,
        "created_task_id": row.created_task_id,
        "forget_count": forget,
        "access_count": int(row.access_count or 0),
        "idle_case_count": idle,
        "forgotten_by": forgotten_by,
        "forget_reason": getattr(row, "forget_reason", None),
        "status": lifecycle_status(
            forget_count=forget,
            idle_case_count=idle,
            forgotten_by=forgotten_by,
        ),
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


def _mark_used(row: AssetIntel, conversation_id: str | None) -> None:
    cid = str(conversation_id or "").strip()
    row.idle_case_count = 0
    if cid:
        row.last_used_conversation_id = cid[:64]


async def record_intel(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    payload: dict[str, Any],
    source: str,
    created_task_id: str | None = None,
    conversation_id: str | None = None,
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
        if lifecycle_status(
            forget_count=row.forget_count,
            idle_case_count=getattr(row, "idle_case_count", 0),
            forgotten_by=getattr(row, "forgotten_by", None),
        ) == "forgotten":
            raise IntelError("forgotten", status_code=404)
        row.asset_id = uuid.UUID(hang["asset_id"])
        row.port = hang["port"]
        row.kind = kind
        row.summary = summary
        row.body = note
        row.sensitivity = default_sensitivity(kind)
        row.updated_at = now
        _mark_used(row, conversation_id)
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
        access_count=0,
        idle_case_count=0,
        last_used_conversation_id=(str(conversation_id).strip()[:64] if conversation_id else None),
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
    port_scope: dict[str, set[str] | None] | None = None,
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
    if port_scope:
        filters.append(case_scope_sql_clause(port_scope))
    elif aids:
        filters.append(AssetIntel.asset_id.in_(aids))

    if port is not None and str(port).strip() != "":
        np = normalize_port(port) or str(port).strip()
        filters.append(AssetIntel.port == np)

    want = str(status or "").strip().lower()
    if audience == "agent":
        # Agent sees living + unused-folded; not hard-forgotten.
        filters.append(AssetIntel.forget_count <= 0)
    elif want in {"active", "living", ""}:
        filters.append(AssetIntel.forget_count <= 0)
        filters.append(AssetIntel.idle_case_count < FOLD_IDLE_CASES)
    elif want in {"folded"}:
        filters.append(AssetIntel.forget_count <= 0)
        filters.append(AssetIntel.idle_case_count >= FOLD_IDLE_CASES)
    elif want in {"forgotten", "soft", "sealed", "archive"}:
        filters.append(AssetIntel.forget_count >= 1)
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
    conversation_id: str | None = None,
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
    row.access_count = int(row.access_count or 0) + 1
    if audience == "agent":
        _mark_used(row, conversation_id)
    await db.commit()
    await db.refresh(row)
    return project_new(intel_to_dict(row), current_task_id=current_task_id)


async def forget_intel(
    db: AsyncSession,
    intel_id: str,
    *,
    user_id: uuid.UUID | None,
    current_task_id: str | None = None,
    forgotten_by: str = "agent",
    reason: str | None = None,
) -> dict[str, Any]:
    try:
        iid = uuid.UUID(str(intel_id))
    except ValueError as e:
        raise IntelError("invalid id", status_code=400) from e
    row = (await db.execute(select(AssetIntel).where(AssetIntel.id == iid))).scalar_one_or_none()
    if not row or (user_id and row.user_id and row.user_id != user_id):
        raise IntelError("intel not found", status_code=404)
    who = str(forgotten_by or "agent").strip().lower()
    if who not in {"agent", "user"}:
        who = "agent"
    note = str(reason or "").strip()
    if who == "agent" and len(note) < 2:
        raise IntelError("reason required to forget", status_code=400)
    if len(note) > MAX_FORGET_REASON:
        raise IntelError(f"reason too long (max {MAX_FORGET_REASON})", status_code=400)
    if lifecycle_status(
        forget_count=row.forget_count,
        idle_case_count=getattr(row, "idle_case_count", 0),
        forgotten_by=getattr(row, "forgotten_by", None),
    ) == "forgotten":
        return project_new(intel_to_dict(row), current_task_id=current_task_id)
    nxt = apply_forget(int(row.forget_count or 0))
    row.forget_count = int(nxt["forget_count"])
    row.forgotten_by = who
    row.forget_reason = note or None
    row.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(row)
    return project_new(intel_to_dict(row), current_task_id=current_task_id)


async def restore_intel(
    db: AsyncSession,
    intel_id: str,
    *,
    user_id: uuid.UUID | None,
    current_task_id: str | None = None,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    try:
        iid = uuid.UUID(str(intel_id))
    except ValueError as e:
        raise IntelError("invalid id", status_code=400) from e
    row = (await db.execute(select(AssetIntel).where(AssetIntel.id == iid))).scalar_one_or_none()
    if not row or (user_id and row.user_id and row.user_id != user_id):
        raise IntelError("intel not found", status_code=404)
    row.forget_count = 0
    row.forgotten_by = None
    row.forget_reason = None
    row.updated_at = datetime.now(timezone.utc)
    _mark_used(row, conversation_id)
    await db.commit()
    await db.refresh(row)
    return project_new(intel_to_dict(row), current_task_id=current_task_id)


async def delete_intel(
    db: AsyncSession,
    intel_id: str,
    *,
    user_id: uuid.UUID | None,
) -> None:
    try:
        iid = uuid.UUID(str(intel_id))
    except ValueError as e:
        raise IntelError("invalid id", status_code=400) from e
    row = (await db.execute(select(AssetIntel).where(AssetIntel.id == iid))).scalar_one_or_none()
    if not row or (user_id and row.user_id and row.user_id != user_id):
        raise IntelError("intel not found", status_code=404)
    await db.delete(row)
    await db.commit()


async def tick_idle_for_scope(
    db: AsyncSession,
    *,
    user_id: uuid.UUID | None,
    conversation_id: str,
    port_scope: dict[str, set[str] | None] | None,
    asset_ids: list[str] | None = None,
) -> int:
    """Harness: one unused-Case increment per scoped living/folded row."""
    cid = str(conversation_id or "").strip()
    if not cid:
        return 0
    filters: list[Any] = [AssetIntel.forget_count <= 0]
    if user_id:
        filters.append(AssetIntel.user_id == user_id)
    if port_scope:
        filters.append(case_scope_sql_clause(port_scope))
    elif asset_ids:
        aids: list[uuid.UUID] = []
        for raw in asset_ids:
            try:
                aids.append(uuid.UUID(str(raw)))
            except ValueError:
                continue
        if not aids:
            return 0
        filters.append(AssetIntel.asset_id.in_(aids))
    else:
        return 0
    stmt = select(AssetIntel)
    for f in filters:
        stmt = stmt.where(f)
    rows = list((await db.execute(stmt)).scalars().all())
    changed = 0
    for row in rows:
        nxt, last = next_idle_case_count(
            conversation_id=cid,
            last_used_conversation_id=getattr(row, "last_used_conversation_id", None),
            last_idle_conversation_id=getattr(row, "last_idle_conversation_id", None),
            idle_case_count=int(getattr(row, "idle_case_count", 0) or 0),
        )
        if nxt != int(getattr(row, "idle_case_count", 0) or 0) or last != getattr(
            row, "last_idle_conversation_id", None
        ):
            row.idle_case_count = nxt
            row.last_idle_conversation_id = last
            changed += 1
    if changed:
        await db.commit()
    return changed


async def living_intel_for_assets(
    db: AsyncSession,
    *,
    user_id: uuid.UUID | None,
    asset_ids: list[str],
    current_task_id: str | None = None,
    limit: int = MAX_INTEL_INJECT,
    port_scope: dict[str, set[str] | None] | None = None,
    conversation_id: str | None = None,
) -> list[dict[str, Any]]:
    if conversation_id:
        await tick_idle_for_scope(
            db,
            user_id=user_id,
            conversation_id=str(conversation_id),
            port_scope=port_scope,
            asset_ids=None if port_scope else asset_ids,
        )
    items, _ = await list_intel(
        db,
        user_id=user_id,
        asset_ids=None if port_scope else asset_ids,
        port_scope=port_scope,
        audience="agent",
        current_task_id=current_task_id,
        limit=max(limit, 80),
        include_body=False,
    )
    return items
