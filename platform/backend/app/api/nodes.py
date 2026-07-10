"""节点 API"""
import uuid
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.audit import AuditLog
from app.models.conversation import Conversation
from app.models.node import Node, PLATFORM_AGENT_NODE_ID, PLATFORM_AGENT_NODE_NAME

router = APIRouter(prefix="/api/nodes", tags=["nodes"])


# Defaults for pentest worker wall-clock / turn budgets (node2 workers).
DEFAULT_WORKER_MAX_MS = 300_000
DEFAULT_WORKER_MAX_TURNS = 12
DEFAULT_WORKER_MAX_TIMEOUT_RETRIES = 2
MIN_WORKER_MAX_MS = 10_000
MAX_WORKER_MAX_MS = 900_000
MIN_WORKER_MAX_TURNS = 1
MAX_WORKER_MAX_TURNS = 40
MIN_WORKER_MAX_TIMEOUT_RETRIES = 0
MAX_WORKER_MAX_TIMEOUT_RETRIES = 5

# Connectivity sparkline: last 24h in 30 buckets (~48 min each).
CONNECTIVITY_WINDOW_HOURS = 24
CONNECTIVITY_BUCKETS = 30


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
    # Worker runtime limits (pentest nodes). Stored in node.config.
    worker_max_ms: int | None = None
    worker_max_turns: int | None = None
    worker_max_timeout_retries: int | None = None
    # Uptime-style bars for the last 24h (card sparkline).
    connectivity: list[ConnectivityBar] = Field(default_factory=list)
    connectivity_uptime_pct: float | None = None
    model_config = {"from_attributes": True}


class NodeUpdate(BaseModel):
    name: str | None = None
    worker_max_ms: int | None = None
    worker_max_turns: int | None = None
    worker_max_timeout_retries: int | None = None


@router.get("", response_model=list[NodeOut])
async def list_nodes(current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _ensure_platform_node(db)
    result = await db.execute(select(Node).order_by(Node.type.asc(), Node.registered_at.desc()))
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
        raise HTTPException(400, "Platform node is built in")

    token = secrets.token_hex(32)
    node = Node(id=uuid.uuid4(), name=name, type=node_type,
                token_hash=hashlib.sha256(token.encode()).hexdigest(),
                config={"token": token})
    db.add(node)
    await db.commit()
    return {"id": str(node.id), "name": node.name, "token": token}


@router.get("/{node_id}", response_model=NodeOut)
async def get_node(node_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _ensure_platform_node(db)
    n = await _get_node(db, node_id)
    tasks = await _current_tasks_by_node(db, [n])
    connectivity = await _connectivity_by_node(db, [n])
    return _node_out(n, tasks.get(n.id), connectivity.get(n.id))


@router.patch("/{node_id}", response_model=NodeOut)
async def update_node(node_id: str, body: NodeUpdate, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _ensure_platform_node(db)
    n = await _get_node(db, node_id)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "Node name cannot be empty")
        existing = await db.execute(select(Node).where(Node.name == name, Node.id != n.id))
        if existing.scalar_one_or_none():
            raise HTTPException(400, "Node name already exists")
        n.name = name
    if any(
        value is not None
        for value in (body.worker_max_ms, body.worker_max_turns, body.worker_max_timeout_retries)
    ):
        if n.type == "platform":
            raise HTTPException(400, "Platform node does not run worker packages")
        cfg = dict(n.config or {})
        if body.worker_max_ms is not None:
            cfg["worker_max_ms"] = _clamp_int(
                body.worker_max_ms, MIN_WORKER_MAX_MS, MAX_WORKER_MAX_MS, DEFAULT_WORKER_MAX_MS
            )
        if body.worker_max_turns is not None:
            cfg["worker_max_turns"] = _clamp_int(
                body.worker_max_turns, MIN_WORKER_MAX_TURNS, MAX_WORKER_MAX_TURNS, DEFAULT_WORKER_MAX_TURNS
            )
        if body.worker_max_timeout_retries is not None:
            cfg["worker_max_timeout_retries"] = _clamp_int(
                body.worker_max_timeout_retries,
                MIN_WORKER_MAX_TIMEOUT_RETRIES,
                MAX_WORKER_MAX_TIMEOUT_RETRIES,
                DEFAULT_WORKER_MAX_TIMEOUT_RETRIES,
            )
        n.config = cfg
    await db.commit()
    await db.refresh(n)
    tasks = await _current_tasks_by_node(db, [n])
    connectivity = await _connectivity_by_node(db, [n])
    return _node_out(n, tasks.get(n.id), connectivity.get(n.id))


@router.post("/{node_id}/regenerate-token", response_model=dict)
async def regenerate_token(node_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    n = await _get_node(db, node_id)
    if n.id == PLATFORM_AGENT_NODE_ID or n.type == "platform":
        raise HTTPException(400, "Platform node does not use a token")
    new_token = secrets.token_hex(32)
    n.token_hash = hashlib.sha256(new_token.encode()).hexdigest()
    n.config = {**(n.config or {}), "token": new_token}
    await db.commit()
    from app.ws import router as ws_router
    await ws_router.revoke_node_connection(str(n.id), "token regenerated")
    return {"id": str(n.id), "name": n.name, "token": new_token}


@router.delete("/{node_id}")
async def delete_node(node_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    n = await _get_node(db, node_id)
    if n.id == PLATFORM_AGENT_NODE_ID or n.type == "platform":
        raise HTTPException(400, "Platform node cannot be deleted")
    await db.delete(n)
    await db.commit()
    return {"ok": True}


async def _ensure_platform_node(db: AsyncSession) -> Node:
    result = await db.execute(select(Node).where(Node.id == PLATFORM_AGENT_NODE_ID))
    node = result.scalar_one_or_none()
    if node:
        if node.type != "platform" or node.status != "online" or node.token_hash is not None:
            node.type = "platform"
            node.status = "online"
            node.token_hash = None
            await db.commit()
        return node

    node = Node(
        id=PLATFORM_AGENT_NODE_ID,
        name=PLATFORM_AGENT_NODE_NAME,
        type="platform",
        status="online",
        token_hash=None,
        current_sessions=0,
        config={"built_in": True},
    )
    db.add(node)
    await db.commit()
    return node


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


def worker_limits_from_config(config: object) -> dict[str, int]:
    """Normalize worker runtime limits from node.config (with defaults)."""
    cfg = config if isinstance(config, dict) else {}
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
        out[n.id] = _build_connectivity_bars(
            events=events_by_node.get(n.id, []),
            now=now,
            window_start=window_start,
            buckets=CONNECTIVITY_BUCKETS,
            current_online=str(n.status or "").lower() == "online" or n.type == "platform",
            registered_at=n.registered_at,
            always_up=n.type == "platform",
        )
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
        # Apply transitions inside this bucket; track if any online time occurred.
        saw_up = False
        saw_down = False
        if state is True:
            saw_up = True
        elif state is False:
            saw_down = True

        while idx < len(events) and events[idx][0] < b_end:
            state = events[idx][1]
            if state:
                saw_up = True
            else:
                saw_down = True
            idx += 1

        # Last bucket prefers live status.
        if i == buckets - 1:
            if current_online:
                saw_up = True
            else:
                saw_down = True
            state = current_online

        if reg and b_end <= reg:
            status = "unknown"
        elif saw_up and not saw_down:
            status = "up"
        elif saw_down and not saw_up:
            status = "down"
        elif saw_up and saw_down:
            # Flapping in bucket → show down to surface instability (or "up" if prefer lenient).
            status = "down"
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

    # If currently online and no offline events in the window, treat remaining
    # unknown buckets (after registration) as up — avoids empty sparklines when
    # the node stayed connected without reconnect churn.
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


def _node_out(
    n: Node,
    current_task: dict | None = None,
    connectivity: list[ConnectivityBar] | None = None,
) -> NodeOut:
    limits = worker_limits_from_config(n.config) if n.type != "platform" else {}
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
        connectivity=bars,
        connectivity_uptime_pct=_uptime_pct(bars),
    )