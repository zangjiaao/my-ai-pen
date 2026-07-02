"""节点 API"""
import uuid
import hashlib
import secrets
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.conversation import Conversation
from app.models.node import Node, PLATFORM_AGENT_NODE_ID, PLATFORM_AGENT_NODE_NAME

router = APIRouter(prefix="/api/nodes", tags=["nodes"])


class NodeOut(BaseModel):
    id: str; name: str; type: str; status: str; ip: str | None
    cpu_usage: float | None; memory_usage: float | None; current_sessions: int
    registered_at: str | None
    last_heartbeat: str | None = None
    current_task: dict | None = None
    last_failure_reason: str | None = None
    token_required: bool
    token: str | None = None
    model_config = {"from_attributes": True}


class NodeUpdate(BaseModel):
    name: str | None = None


@router.get("", response_model=list[NodeOut])
async def list_nodes(current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _ensure_platform_node(db)
    result = await db.execute(select(Node).order_by(Node.type.asc(), Node.registered_at.desc()))
    nodes = result.scalars().all()
    tasks = await _current_tasks_by_node(db, nodes)
    return [_node_out(n, tasks.get(n.id)) for n in nodes]


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
    return _node_out(n, tasks.get(n.id))


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
    await db.commit()
    await db.refresh(n)
    return _node_out(n)


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


def _node_out(n: Node, current_task: dict | None = None) -> NodeOut:
    return NodeOut(id=str(n.id), name=n.name, type=n.type, status=n.status,
                   ip=str(n.ip) if n.ip else None, cpu_usage=n.cpu_usage, memory_usage=n.memory_usage,
                   current_sessions=n.current_sessions or 0,
                   registered_at=n.registered_at.isoformat() if n.registered_at else None,
                   last_heartbeat=n.last_heartbeat.isoformat() if n.last_heartbeat else None,
                   current_task=current_task,
                   last_failure_reason=_last_failure_reason(n),
                   token_required=bool(n.token_hash),
                   token=_node_token(n))