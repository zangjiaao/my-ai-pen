"""节点 API"""
import uuid
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.audit import AuditLog
from app.models.conversation import Conversation
from app.models.evidence import Evidence
from app.models.expert import Expert
from app.models.node import Node, PLATFORM_AGENT_NODE_ID
from app.models.vulnerability import Vulnerability
from app.services.expert_offers import (
    ACTION_INSTALL,
    ACTION_UNINSTALL,
    effective_offers,
    install_offer,
    known_pack_ids,
    uninstall_offer,
)

router = APIRouter(prefix="/api/nodes", tags=["nodes"])


# Defaults for pentest runtime budgets (node2 main agent + workers).
DEFAULT_WORKER_MAX_MS = 300_000
DEFAULT_WORKER_MAX_TURNS = 12
DEFAULT_WORKER_MAX_TIMEOUT_RETRIES = 2
DEFAULT_MAIN_MAX_MS = 1_800_000  # 30 min whole-task wall clock
DEFAULT_MAIN_MAX_TURNS = 80
DEFAULT_MAX_CONCURRENT_WORKERS = 1
DEFAULT_SCAN_MODE = "standard"
MIN_WORKER_MAX_MS = 10_000
MAX_WORKER_MAX_MS = 900_000
MIN_WORKER_MAX_TURNS = 1
MAX_WORKER_MAX_TURNS = 40
MIN_WORKER_MAX_TIMEOUT_RETRIES = 0
MAX_WORKER_MAX_TIMEOUT_RETRIES = 5
MIN_MAIN_MAX_MS = 60_000
MAX_MAIN_MAX_MS = 7_200_000  # 2 h
MIN_MAIN_MAX_TURNS = 5
MAX_MAIN_MAX_TURNS = 200
MIN_MAX_CONCURRENT_WORKERS = 1
MAX_MAX_CONCURRENT_WORKERS = 4
ALLOWED_SCAN_MODES = frozenset({"quick", "standard", "deep"})

# Connectivity sparkline: last 24h in 30 buckets (~48 min each).
CONNECTIVITY_WINDOW_HOURS = 24
CONNECTIVITY_BUCKETS = 30
# Ignore offline→online flaps shorter than this (proxy idle, brief reconnect, deploy).
CONNECTIVITY_BLIP_SECONDS = 120


class ConnectivityBar(BaseModel):
    """One time-bucket for the node card connectivity strip."""
    status: str  # up | down | unknown
    from_at: str
    to_at: str


class NodeOut(BaseModel):
    id: str; name: str; type: str; status: str; ip: str | None
    cpu_usage: float | None; memory_usage: float | None; current_sessions: int
    registered_at: str | None
    last_heartbeat: str | None = None
    current_task: dict | None = None
    last_failure_reason: str | None = None
    token_required: bool
    token: str | None = None
    # Runtime limits (pentest nodes). Stored in node.config; sent on task_assign.
    worker_max_ms: int | None = None
    worker_max_turns: int | None = None
    worker_max_timeout_retries: int | None = None
    main_max_ms: int | None = None
    main_max_turns: int | None = None
    max_concurrent_workers: int | None = None
    default_scan_mode: str | None = None
    # Uptime-style bars for the last 24h (card sparkline).
    connectivity: list[ConnectivityBar] = Field(default_factory=list)
    connectivity_uptime_pct: float | None = None
    # Optional capability manifest from node.config.capabilities (node-reported).
    capabilities: dict | None = None
    # Installed extension pack ids (node as container). Empty = only built-in default.
    offers: list[str] = Field(default_factory=list)
    model_config = {"from_attributes": True}


class NodeUpdate(BaseModel):
    name: str | None = None
    worker_max_ms: int | None = None
    worker_max_turns: int | None = None
    worker_max_timeout_retries: int | None = None
    main_max_ms: int | None = None
    main_max_turns: int | None = None
    max_concurrent_workers: int | None = None
    default_scan_mode: str | None = None


class ExpertInstallBody(BaseModel):
    """Install an expert pack on a worker node (structured id only — no NLP)."""
    expert_id: str = Field(..., min_length=1, max_length=64)


@router.get("", response_model=list[NodeOut])
async def list_nodes(current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    # Product model: only worker Nodes (no built-in platform agent node).
    await _retire_platform_nodes(db)
    result = await db.execute(
        select(Node)
        .where(Node.type != "platform", Node.id != PLATFORM_AGENT_NODE_ID)
        .order_by(Node.type.asc(), Node.registered_at.desc())
    )
    nodes = result.scalars().all()
    tasks = await _current_tasks_by_node(db, nodes)
    connectivity = await _connectivity_by_node(db, nodes)
    return [
        _node_out(n, tasks.get(n.id), connectivity.get(n.id))
        for n in nodes
    ]


@router.post("", response_model=dict)
async def register_node(body: dict, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    name = str(body.get("name") or f"node-{secrets.token_hex(4)}").strip()
    if not name:
        raise HTTPException(400, "Node name cannot be empty")
    existing = await db.execute(select(Node).where(Node.name == name))
    if existing.scalar_one_or_none():
        raise HTTPException(400, "Node name already exists")

    node_type = str(body.get("type") or "pentest")
    if node_type == "platform":
        raise HTTPException(400, "Platform agent node is retired; register a worker Node instead")
    token = secrets.token_hex(32)
    node = Node(id=uuid.uuid4(), name=name, type=node_type,
                token_hash=hashlib.sha256(token.encode()).hexdigest(),
                config={"token": token})
    db.add(node)
    await db.flush()
    await _audit_user(
        db,
        uuid.UUID(current_user["user_id"]),
        "node.register",
        node.id,
        {"name": node.name, "type": node.type},
    )
    await db.commit()
    return {"id": str(node.id), "name": node.name, "token": token}


@router.get("/{node_id}", response_model=NodeOut)
async def get_node(node_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    n = await _get_worker_node(db, node_id)
    tasks = await _current_tasks_by_node(db, [n])
    connectivity = await _connectivity_by_node(db, [n])
    return _node_out(n, tasks.get(n.id), connectivity.get(n.id))


@router.patch("/{node_id}", response_model=NodeOut)
async def update_node(node_id: str, body: NodeUpdate, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    n = await _get_worker_node(db, node_id)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "Node name cannot be empty")
        existing = await db.execute(select(Node).where(Node.name == name, Node.id != n.id))
        if existing.scalar_one_or_none():
            raise HTTPException(400, "Node name already exists")
        n.name = name
    runtime_fields = (
        body.worker_max_ms,
        body.worker_max_turns,
        body.worker_max_timeout_retries,
        body.main_max_ms,
        body.main_max_turns,
        body.max_concurrent_workers,
        body.default_scan_mode,
    )
    changed_fields: list[str] = []
    if body.name is not None:
        changed_fields.append("name")
    if any(value is not None for value in runtime_fields):
        if n.type != "pentest":
            raise HTTPException(400, "Runtime budgets apply only to pentest nodes")
        cfg = dict(n.config or {})
        if body.worker_max_ms is not None:
            cfg["worker_max_ms"] = _clamp_int(
                body.worker_max_ms, MIN_WORKER_MAX_MS, MAX_WORKER_MAX_MS, DEFAULT_WORKER_MAX_MS
            )
            changed_fields.append("worker_max_ms")
        if body.worker_max_turns is not None:
            cfg["worker_max_turns"] = _clamp_int(
                body.worker_max_turns, MIN_WORKER_MAX_TURNS, MAX_WORKER_MAX_TURNS, DEFAULT_WORKER_MAX_TURNS
            )
            changed_fields.append("worker_max_turns")
        if body.worker_max_timeout_retries is not None:
            cfg["worker_max_timeout_retries"] = _clamp_int(
                body.worker_max_timeout_retries,
                MIN_WORKER_MAX_TIMEOUT_RETRIES,
                MAX_WORKER_MAX_TIMEOUT_RETRIES,
                DEFAULT_WORKER_MAX_TIMEOUT_RETRIES,
            )
            changed_fields.append("worker_max_timeout_retries")
        if body.main_max_ms is not None:
            cfg["main_max_ms"] = _clamp_int(
                body.main_max_ms, MIN_MAIN_MAX_MS, MAX_MAIN_MAX_MS, DEFAULT_MAIN_MAX_MS
            )
            changed_fields.append("main_max_ms")
        if body.main_max_turns is not None:
            cfg["main_max_turns"] = _clamp_int(
                body.main_max_turns, MIN_MAIN_MAX_TURNS, MAX_MAIN_MAX_TURNS, DEFAULT_MAIN_MAX_TURNS
            )
            changed_fields.append("main_max_turns")
        if body.max_concurrent_workers is not None:
            cfg["max_concurrent_workers"] = _clamp_int(
                body.max_concurrent_workers,
                MIN_MAX_CONCURRENT_WORKERS,
                MAX_MAX_CONCURRENT_WORKERS,
                DEFAULT_MAX_CONCURRENT_WORKERS,
            )
            changed_fields.append("max_concurrent_workers")
        if body.default_scan_mode is not None:
            mode = str(body.default_scan_mode).strip().lower()
            if mode not in ALLOWED_SCAN_MODES:
                raise HTTPException(400, "default_scan_mode must be quick, standard, or deep")
            cfg["default_scan_mode"] = mode
            changed_fields.append("default_scan_mode")
        n.config = cfg
    if changed_fields:
        await _audit_user(
            db,
            uuid.UUID(current_user["user_id"]),
            "node.update",
            n.id,
            {"name": n.name, "fields": changed_fields},
        )
    await db.commit()
    await db.refresh(n)
    tasks = await _current_tasks_by_node(db, [n])
    connectivity = await _connectivity_by_node(db, [n])
    return _node_out(n, tasks.get(n.id), connectivity.get(n.id))


@router.get("/{node_id}/offers", response_model=dict)
async def get_node_offers(
    node_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List effective expert offers for a node (default: pentest only)."""
    n = await _get_worker_node(db, node_id)
    offers = effective_offers(n.config)
    return {
        "node_id": str(n.id),
        "name": n.name,
        "offers": offers,
        "known_packs": sorted(known_pack_ids()),
    }


@router.post("/{node_id}/experts", response_model=dict)
async def install_node_expert(
    node_id: str,
    body: ExpertInstallBody,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Install an expert pack on a node. Emits expert.install billing hook (no payment)."""
    n = await _get_worker_node(db, node_id)
    try:
        new_cfg, detail = install_offer(n.config, body.expert_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    n.config = new_cfg
    await _audit_user(
        db,
        uuid.UUID(current_user["user_id"]),
        ACTION_INSTALL,
        n.id,
        detail,
    )
    await db.commit()
    await db.refresh(n)
    return {
        "ok": True,
        "node_id": str(n.id),
        "offers": effective_offers(n.config),
        "billing": detail,
    }


@router.delete("/{node_id}/experts/{expert_id}", response_model=dict)
async def uninstall_node_expert(
    node_id: str,
    expert_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove an expert pack from a node. Emits expert.uninstall billing hook (no payment)."""
    n = await _get_worker_node(db, node_id)
    try:
        new_cfg, detail = uninstall_offer(n.config, expert_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    n.config = new_cfg
    await _audit_user(
        db,
        uuid.UUID(current_user["user_id"]),
        ACTION_UNINSTALL,
        n.id,
        detail,
    )
    await db.commit()
    await db.refresh(n)
    return {
        "ok": True,
        "node_id": str(n.id),
        "offers": effective_offers(n.config),
        "billing": detail,
    }


@router.post("/{node_id}/regenerate-token", response_model=dict)
async def regenerate_token(node_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    n = await _get_worker_node(db, node_id)
    new_token = secrets.token_hex(32)
    n.token_hash = hashlib.sha256(new_token.encode()).hexdigest()
    n.config = {**(n.config or {}), "token": new_token}
    await _audit_user(
        db,
        uuid.UUID(current_user["user_id"]),
        "node.regenerate_token",
        n.id,
        {"name": n.name},
    )
    await db.commit()
    from app.ws import router as ws_router
    await ws_router.revoke_node_connection(str(n.id), "token regenerated")
    return {"id": str(n.id), "name": n.name, "token": new_token}


@router.delete("/{node_id}")
async def delete_node(node_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Delete a worker node (or retire a leftover platform agent row).

    Detach ledger rows that reference the node (assets / vulns / conversations /
    evidence keep data, ``node_id`` cleared). Product experts bound to this node
    are removed.
    """
    n = await _get_node(db, node_id)

    # Detach optional FKs first — DB constraints are NO ACTION, not CASCADE.
    for model in (Asset, Vulnerability, Conversation, Evidence):
        await db.execute(
            update(model).where(model.node_id == n.id).values(node_id=None)
        )
    # Experts are node-bound routing personas; remove with the physical node.
    expert_rows = (await db.execute(select(Expert).where(Expert.node_id == n.id))).scalars().all()
    expert_count = len(expert_rows)
    for exp in expert_rows:
        await db.delete(exp)

    await _audit_user(
        db,
        uuid.UUID(current_user["user_id"]),
        "node.delete",
        n.id,
        {
            "name": n.name,
            "type": n.type,
            "detached": True,
            "experts_removed": expert_count,
        },
    )
    await db.delete(n)
    try:
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(
            409,
            f"无法删除节点「{n.name}」：仍有关联数据（{e.__class__.__name__}）。",
        ) from e

    try:
        from app.ws import router as ws_router

        await ws_router.revoke_node_connection(str(n.id), "node deleted")
    except Exception:
        pass

    return {"ok": True, "id": str(n.id), "experts_removed": expert_count}


async def _audit_user(
    db: AsyncSession,
    user_id: uuid.UUID,
    action: str,
    resource_id: uuid.UUID,
    detail: dict,
) -> None:
    db.add(
        AuditLog(
            actor_type="user",
            actor_id=user_id,
            action=action,
            resource_type="node",
            resource_id=resource_id,
            detail=detail,
            status="success",
        )
    )


async def _retire_platform_nodes(db: AsyncSession) -> int:
    """Remove built-in platform agent node rows (no longer a product entity).

    Detaches FK references first, then deletes. Safe to call on every list.
    """
    result = await db.execute(
        select(Node).where(or_(Node.type == "platform", Node.id == PLATFORM_AGENT_NODE_ID))
    )
    nodes = list(result.scalars().all())
    if not nodes:
        return 0
    removed = 0
    for n in nodes:
        for model in (Asset, Vulnerability, Conversation, Evidence):
            await db.execute(update(model).where(model.node_id == n.id).values(node_id=None))
        expert_rows = (await db.execute(select(Expert).where(Expert.node_id == n.id))).scalars().all()
        for exp in expert_rows:
            await db.delete(exp)
        await db.delete(n)
        removed += 1
    if removed:
        await db.commit()
    return removed


async def _get_node(db: AsyncSession, node_id: str) -> Node:
    try:
        node_uuid = uuid.UUID(node_id)
    except ValueError as exc:
        raise HTTPException(400, "Invalid node id") from exc
    result = await db.execute(select(Node).where(Node.id == node_uuid))
    n = result.scalar_one_or_none()
    if not n:
        raise HTTPException(404, "Node not found")
    return n


async def _get_worker_node(db: AsyncSession, node_id: str) -> Node:
    """Worker Node only — platform agent rows are retired and not addressable."""
    n = await _get_node(db, node_id)
    if n.id == PLATFORM_AGENT_NODE_ID or str(n.type or "") == "platform":
        raise HTTPException(404, "Node not found")
    return n


def _node_token(n: Node) -> str | None:
    if n.type == "platform":
        return None
    config = n.config if isinstance(n.config, dict) else {}
    token = config.get("token")
    return token if isinstance(token, str) and token else None


async def _current_tasks_by_node(db: AsyncSession, nodes: list[Node]) -> dict[uuid.UUID, dict]:
    node_ids = [node.id for node in nodes]
    if not node_ids:
        return {}
    result = await db.execute(
        select(Conversation)
        .where(Conversation.node_id.in_(node_ids), Conversation.status == "running")
        .order_by(Conversation.last_active_at.desc())
    )
    tasks: dict[uuid.UUID, dict] = {}
    for conv in result.scalars().all():
        if not conv.node_id or conv.node_id in tasks:
            continue
        context = conv.context if isinstance(conv.context, dict) else {}
        task = context.get("task") if isinstance(context.get("task"), dict) else {}
        target = task.get("target") if isinstance(task.get("target"), dict) else {}
        tasks[conv.node_id] = {
            "conversation_id": str(conv.id),
            "title": conv.title,
            "status": conv.status,
            "target": target.get("value") or "",
            "updated_at": conv.last_active_at.isoformat() if conv.last_active_at else None,
        }
    return tasks


def _last_failure_reason(n: Node) -> str | None:
    config = n.config if isinstance(n.config, dict) else {}
    value = config.get("last_failure_reason")
    return value if isinstance(value, str) and value else None


def _clamp_int(value: object, lo: int, hi: int, default: int) -> int:
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def worker_limits_from_config(config: object) -> dict:
    """Normalize runtime limits from node.config (worker + main + schedule) with defaults."""
    cfg = config if isinstance(config, dict) else {}
    mode = str(cfg.get("default_scan_mode") or DEFAULT_SCAN_MODE).strip().lower()
    if mode not in ALLOWED_SCAN_MODES:
        mode = DEFAULT_SCAN_MODE
    return {
        "worker_max_ms": _clamp_int(
            cfg.get("worker_max_ms"), MIN_WORKER_MAX_MS, MAX_WORKER_MAX_MS, DEFAULT_WORKER_MAX_MS
        ),
        "worker_max_turns": _clamp_int(
            cfg.get("worker_max_turns"), MIN_WORKER_MAX_TURNS, MAX_WORKER_MAX_TURNS, DEFAULT_WORKER_MAX_TURNS
        ),
        "worker_max_timeout_retries": _clamp_int(
            cfg.get("worker_max_timeout_retries"),
            MIN_WORKER_MAX_TIMEOUT_RETRIES,
            MAX_WORKER_MAX_TIMEOUT_RETRIES,
            DEFAULT_WORKER_MAX_TIMEOUT_RETRIES,
        ),
        "main_max_ms": _clamp_int(
            cfg.get("main_max_ms"), MIN_MAIN_MAX_MS, MAX_MAIN_MAX_MS, DEFAULT_MAIN_MAX_MS
        ),
        "main_max_turns": _clamp_int(
            cfg.get("main_max_turns"), MIN_MAIN_MAX_TURNS, MAX_MAIN_MAX_TURNS, DEFAULT_MAIN_MAX_TURNS
        ),
        "max_concurrent_workers": _clamp_int(
            cfg.get("max_concurrent_workers"),
            MIN_MAX_CONCURRENT_WORKERS,
            MAX_MAX_CONCURRENT_WORKERS,
            DEFAULT_MAX_CONCURRENT_WORKERS,
        ),
        "default_scan_mode": mode,
    }


async def _connectivity_by_node(
    db: AsyncSession,
    nodes: list[Node],
) -> dict[uuid.UUID, list[ConnectivityBar]]:
    """Build 24h connectivity bars from node.online / node.offline audit events."""
    if not nodes:
        return {}
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(hours=CONNECTIVITY_WINDOW_HOURS)
    # Look a bit earlier so we know state at window start.
    lookback = window_start - timedelta(hours=CONNECTIVITY_WINDOW_HOURS)
    node_ids = [n.id for n in nodes]

    result = await db.execute(
        select(AuditLog)
        .where(
            AuditLog.action.in_(["node.online", "node.offline"]),
            AuditLog.timestamp >= lookback,
            or_(
                AuditLog.resource_id.in_(node_ids),
                AuditLog.actor_id.in_(node_ids),
            ),
        )
        .order_by(AuditLog.timestamp.asc())
    )
    rows = result.scalars().all()

    events_by_node: dict[uuid.UUID, list[tuple[datetime, bool]]] = {nid: [] for nid in node_ids}
    for row in rows:
        nid = row.resource_id if row.resource_id in events_by_node else (
            row.actor_id if row.actor_id in events_by_node else None
        )
        if not nid:
            continue
        online = row.action == "node.online"
        ts = row.timestamp
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        events_by_node[nid].append((ts, online))

    out: dict[uuid.UUID, list[ConnectivityBar]] = {}
    for n in nodes:
        raw_events = events_by_node.get(n.id, [])
        # Drop sub-minute reconnect noise so the strip reflects real outages.
        events = _collapse_reconnect_blips(
            raw_events,
            min_down=timedelta(seconds=CONNECTIVITY_BLIP_SECONDS),
        )
        out[n.id] = _build_connectivity_bars(
            events=events,
            now=now,
            window_start=window_start,
            buckets=CONNECTIVITY_BUCKETS,
            current_online=str(n.status or "").lower() == "online" or n.type == "platform",
            registered_at=n.registered_at,
            always_up=n.type == "platform",
        )
    return out


def _collapse_reconnect_blips(
    events: list[tuple[datetime, bool]],
    *,
    min_down: timedelta,
) -> list[tuple[datetime, bool]]:
    """Remove offline periods shorter than min_down (false disconnect / reconnect)."""
    if not events:
        return []
    # Collapse consecutive duplicate states first.
    merged: list[tuple[datetime, bool]] = []
    for ts, online in events:
        if merged and merged[-1][1] is online:
            continue
        merged.append((ts, online))

    out: list[tuple[datetime, bool]] = []
    i = 0
    while i < len(merged):
        ts, online = merged[i]
        if (not online) and i + 1 < len(merged) and merged[i + 1][1]:
            offline_at = ts
            online_at = merged[i + 1][0]
            if online_at - offline_at < min_down:
                # Brief flap: skip offline + the following online re-event.
                # If we were already online before, stay online with no new event.
                i += 2
                continue
        out.append((ts, online))
        i += 1
    return out


def _build_connectivity_bars(
    *,
    events: list[tuple[datetime, bool]],
    now: datetime,
    window_start: datetime,
    buckets: int,
    current_online: bool,
    registered_at: datetime | None,
    always_up: bool = False,
) -> list[ConnectivityBar]:
    if always_up:
        width = (now - window_start) / buckets
        return [
            ConnectivityBar(
                status="up",
                from_at=(window_start + width * i).isoformat(),
                to_at=(window_start + width * (i + 1)).isoformat(),
            )
            for i in range(buckets)
        ]

    reg = registered_at
    if reg and reg.tzinfo is None:
        reg = reg.replace(tzinfo=timezone.utc)

    # State just before window: last event before window_start.
    known: bool | None = None
    for ts, online in events:
        if ts < window_start:
            known = online
        else:
            break

    width = (now - window_start) / buckets
    # Index events from window_start onward
    idx = 0
    while idx < len(events) and events[idx][0] < window_start:
        idx += 1

    bars: list[ConnectivityBar] = []
    state = known
    for i in range(buckets):
        b_start = window_start + width * i
        b_end = window_start + width * (i + 1)
        # Track wall time spent up/down inside the bucket (not just "any event").
        cursor = b_start
        up_seconds = 0.0
        down_seconds = 0.0

        def _add_span(start: datetime, end: datetime, online: bool | None) -> None:
            nonlocal up_seconds, down_seconds
            if end <= start or online is None:
                return
            secs = (end - start).total_seconds()
            if online:
                up_seconds += secs
            else:
                down_seconds += secs

        while idx < len(events) and events[idx][0] < b_end:
            ts, online = events[idx]
            _add_span(cursor, ts, state)
            state = online
            cursor = ts
            idx += 1
        _add_span(cursor, b_end, state)

        # Open (last) bucket uses live status as source of truth.
        if i == buckets - 1:
            state = current_online

        if reg and b_end <= reg:
            status = "unknown"
        elif i == buckets - 1:
            # Avoid painting the live bucket red while the node is currently online.
            status = "up" if current_online else "down"
        elif up_seconds > 0 and down_seconds <= 0:
            status = "up"
        elif down_seconds > 0 and up_seconds <= 0:
            status = "down"
        elif up_seconds > 0 and down_seconds > 0:
            # Mixed bucket: majority wall time wins (brief reconnect blips stay green).
            status = "up" if up_seconds >= down_seconds else "down"
        elif state is True:
            status = "up"
        elif state is False:
            status = "down"
        else:
            status = "unknown"

        bars.append(
            ConnectivityBar(
                status=status,
                from_at=b_start.isoformat(),
                to_at=b_end.isoformat(),
            )
        )

    # If currently online and no (material) offline events in the window, treat
    # remaining unknown buckets as up — node stayed connected without churn.
    has_down_event = any(not online for ts, online in events if ts >= window_start)
    if current_online and not has_down_event:
        filled: list[ConnectivityBar] = []
        for bar in bars:
            if bar.status == "unknown":
                try:
                    end = datetime.fromisoformat(bar.to_at.replace("Z", "+00:00"))
                except ValueError:
                    end = now
                if not reg or end > reg:
                    filled.append(ConnectivityBar(status="up", from_at=bar.from_at, to_at=bar.to_at))
                    continue
            filled.append(bar)
        return filled

    return bars


def _uptime_pct(bars: list[ConnectivityBar]) -> float | None:
    known = [b for b in bars if b.status in {"up", "down"}]
    if not known:
        return None
    up = sum(1 for b in known if b.status == "up")
    return round(100.0 * up / len(known), 1)


def _capabilities_from_config(config: object) -> dict | None:
    """Return node-reported capability manifest if present and non-empty."""
    cfg = config if isinstance(config, dict) else {}
    raw = cfg.get("capabilities")
    if not isinstance(raw, dict):
        return None
    out: dict = {}
    for key in ("runtime", "version"):
        val = raw.get(key)
        if isinstance(val, str) and val.strip():
            out[key] = val.strip()
    for key in ("skills", "workflows", "tools"):
        val = raw.get(key)
        if isinstance(val, list):
            items = [str(x).strip() for x in val if str(x).strip()]
            if items:
                out[key] = items
    return out or None


def _node_out(
    n: Node,
    current_task: dict | None = None,
    connectivity: list[ConnectivityBar] | None = None,
) -> NodeOut:
    limits = worker_limits_from_config(n.config) if n.type == "pentest" else {}
    bars = connectivity or []
    return NodeOut(
        id=str(n.id),
        name=n.name,
        type=n.type,
        status=n.status,
        ip=str(n.ip) if n.ip else None,
        cpu_usage=n.cpu_usage,
        memory_usage=n.memory_usage,
        current_sessions=n.current_sessions or 0,
        registered_at=n.registered_at.isoformat() if n.registered_at else None,
        last_heartbeat=n.last_heartbeat.isoformat() if n.last_heartbeat else None,
        current_task=current_task,
        last_failure_reason=_last_failure_reason(n),
        token_required=bool(n.token_hash),
        token=_node_token(n),
        worker_max_ms=limits.get("worker_max_ms"),
        worker_max_turns=limits.get("worker_max_turns"),
        worker_max_timeout_retries=limits.get("worker_max_timeout_retries"),
        main_max_ms=limits.get("main_max_ms"),
        main_max_turns=limits.get("main_max_turns"),
        max_concurrent_workers=limits.get("max_concurrent_workers"),
        default_scan_mode=limits.get("default_scan_mode"),
        connectivity=bars,
        connectivity_uptime_pct=_uptime_pct(bars),
        capabilities=_capabilities_from_config(n.config),
        offers=effective_offers(n.config) if n.type != "platform" else [],
    )