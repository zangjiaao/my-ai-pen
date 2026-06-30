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
from app.models.node import Node, PLATFORM_AGENT_NODE_ID, PLATFORM_AGENT_NODE_NAME

router = APIRouter(prefix="/api/nodes", tags=["nodes"])


class NodeOut(BaseModel):
    id: str; name: str; type: str; status: str; ip: str | None
    cpu_usage: float | None; memory_usage: float | None; current_sessions: int
    registered_at: str | None
    token_required: bool
    model_config = {"from_attributes": True}


class NodeUpdate(BaseModel):
    name: str | None = None


@router.get("", response_model=list[NodeOut])
async def list_nodes(current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _ensure_platform_node(db)
    result = await db.execute(select(Node).order_by(Node.type.asc(), Node.registered_at.desc()))
    return [_node_out(n) for n in result.scalars().all()]


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
                token_hash=hashlib.sha256(token.encode()).hexdigest())
    db.add(node)
    await db.commit()
    return {"id": str(node.id), "name": node.name, "token": token}


@router.get("/{node_id}", response_model=NodeOut)
async def get_node(node_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _ensure_platform_node(db)
    n = await _get_node(db, node_id)
    return _node_out(n)


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
    await db.commit()
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


def _node_out(n: Node) -> NodeOut:
    return NodeOut(id=str(n.id), name=n.name, type=n.type, status=n.status,
                   ip=str(n.ip) if n.ip else None, cpu_usage=n.cpu_usage, memory_usage=n.memory_usage,
                   current_sessions=n.current_sessions,
                   registered_at=n.registered_at.isoformat() if n.registered_at else None,
                   token_required=bool(n.token_hash))