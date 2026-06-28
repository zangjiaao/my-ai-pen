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
from app.models.node import Node

router = APIRouter(prefix="/api/nodes", tags=["nodes"])


class NodeOut(BaseModel):
    id: str; name: str; type: str; status: str; ip: str | None
    cpu_usage: float | None; memory_usage: float | None; current_sessions: int
    registered_at: str | None
    model_config = {"from_attributes": True}


@router.get("", response_model=list[NodeOut])
async def list_nodes(current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Node).order_by(Node.registered_at.desc()))
    return [_node_out(n) for n in result.scalars().all()]


@router.post("", response_model=dict)
async def register_node(body: dict, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    name = body.get("name", f"node-{secrets.token_hex(4)}")
    existing = await db.execute(select(Node).where(Node.name == name))
    if existing.scalar_one_or_none():
        raise HTTPException(400, "Node name already exists")

    token = secrets.token_hex(32)
    node = Node(id=uuid.uuid4(), name=name, type=body.get("type", "pentest"),
                token_hash=hashlib.sha256(token.encode()).hexdigest())
    db.add(node)
    await db.commit()
    return {"id": str(node.id), "name": node.name, "token": token}


@router.get("/{node_id}", response_model=NodeOut)
async def get_node(node_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Node).where(Node.id == uuid.UUID(node_id)))
    n = result.scalar_one_or_none()
    if not n: raise HTTPException(404, "Node not found")
    return _node_out(n)


@router.delete("/{node_id}")
async def delete_node(node_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Node).where(Node.id == uuid.UUID(node_id)))
    n = result.scalar_one_or_none()
    if not n: raise HTTPException(404, "Node not found")
    await db.delete(n)
    await db.commit()
    return {"ok": True}


def _node_out(n: Node) -> NodeOut:
    return NodeOut(id=str(n.id), name=n.name, type=n.type, status=n.status,
                   ip=str(n.ip) if n.ip else None, cpu_usage=n.cpu_usage, memory_usage=n.memory_usage,
                   current_sessions=n.current_sessions,
                   registered_at=n.registered_at.isoformat() if n.registered_at else None)
