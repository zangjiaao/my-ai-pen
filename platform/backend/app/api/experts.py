"""Expert management API — product personas bound to Node + pack for @mention routing."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.audit import AuditLog
from app.models.expert import Expert
from app.models.node import Node, PLATFORM_AGENT_NODE_ID
from app.services.expert_instances import (
    expert_to_dict,
    validate_expert_name,
    validate_pack_for_node,
)
from app.services.expert_offers import effective_offers

router = APIRouter(prefix="/api/experts", tags=["experts"])


class ExpertCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    pack_id: str = Field(..., min_length=1, max_length=64)
    node_id: str = Field(..., min_length=1)
    display_name: str | None = Field(None, max_length=255)
    description: str | None = None


class ExpertUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=128)
    pack_id: str | None = Field(None, min_length=1, max_length=64)
    node_id: str | None = Field(None, min_length=1)
    display_name: str | None = Field(None, max_length=255)
    description: str | None = None
    enabled: bool | None = None


def _parse_uuid(value: str, label: str = "id") -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError) as e:
        raise HTTPException(400, f"Invalid {label}") from e


async def _get_worker_node(db: AsyncSession, node_id: uuid.UUID) -> Node:
    n = await db.get(Node, node_id)
    if not n:
        raise HTTPException(404, "Node not found")
    if n.id == PLATFORM_AGENT_NODE_ID or n.type == "platform":
        raise HTTPException(400, "Cannot bind an expert to the platform agent node")
    return n


async def _name_taken(db: AsyncSession, name: str, exclude_id: uuid.UUID | None = None) -> bool:
    q = select(Expert).where(Expert.name == name)
    if exclude_id is not None:
        q = q.where(Expert.id != exclude_id)
    row = (await db.execute(q)).scalar_one_or_none()
    return row is not None


async def _node_name_collision(db: AsyncSession, name: str) -> bool:
    """Avoid @mention ambiguity with worker node names."""
    row = (
        await db.execute(select(Node).where(Node.name == name))
    ).scalar_one_or_none()
    return row is not None


@router.get("")
async def list_experts(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Expert).order_by(Expert.created_at.desc()))
    experts = list(result.scalars().all())
    node_ids = {e.node_id for e in experts}
    nodes: dict[uuid.UUID, Node] = {}
    if node_ids:
        nres = await db.execute(select(Node).where(Node.id.in_(node_ids)))
        nodes = {n.id: n for n in nres.scalars().all()}
    out = []
    for e in experts:
        n = nodes.get(e.node_id)
        out.append(
            expert_to_dict(
                e,
                node_name=n.name if n else None,
                node_status=n.status if n else None,
                node_offers=effective_offers(n.config) if n else None,
            )
        )
    return out


@router.post("")
async def create_expert(
    body: ExpertCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        name = validate_expert_name(body.name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    if await _name_taken(db, name):
        raise HTTPException(400, f"Expert name '@{name}' is already taken")
    if await _node_name_collision(db, name):
        raise HTTPException(
            400,
            f"Name '@{name}' collides with a node name; choose a different expert name",
        )

    node_id = _parse_uuid(body.node_id, "node_id")
    node = await _get_worker_node(db, node_id)
    try:
        pack = validate_pack_for_node(node.config, body.pack_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    try:
        user_uuid = uuid.UUID(str(current_user["user_id"]))
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(401, "Invalid user") from e

    expert = Expert(
        id=uuid.uuid4(),
        user_id=user_uuid,
        name=name,
        display_name=(body.display_name or "").strip() or name,
        pack_id=pack,
        node_id=node.id,
        description=(body.description or "").strip() or None,
        enabled=True,
    )
    db.add(expert)
    db.add(
        AuditLog(
            actor_type="user",
            actor_id=user_uuid,
            action="expert.create",
            resource_type="expert",
            resource_id=expert.id,
            detail={
                "name": name,
                "pack_id": pack,
                "node_id": str(node.id),
                "node_name": node.name,
            },
            status="success",
        )
    )
    await db.commit()
    await db.refresh(expert)
    return expert_to_dict(
        expert,
        node_name=node.name,
        node_status=node.status,
        node_offers=effective_offers(node.config),
    )


@router.get("/{expert_id}")
async def get_expert(
    expert_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    eid = _parse_uuid(expert_id)
    expert = await db.get(Expert, eid)
    if not expert:
        raise HTTPException(404, "Expert not found")
    node = await db.get(Node, expert.node_id)
    return expert_to_dict(
        expert,
        node_name=node.name if node else None,
        node_status=node.status if node else None,
        node_offers=effective_offers(node.config) if node else None,
    )


@router.patch("/{expert_id}")
async def update_expert(
    expert_id: str,
    body: ExpertUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    eid = _parse_uuid(expert_id)
    expert = await db.get(Expert, eid)
    if not expert:
        raise HTTPException(404, "Expert not found")

    name = expert.name
    if body.name is not None:
        try:
            name = validate_expert_name(body.name)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        if name != expert.name:
            if await _name_taken(db, name, exclude_id=expert.id):
                raise HTTPException(400, f"Expert name '@{name}' is already taken")
            if await _node_name_collision(db, name):
                raise HTTPException(
                    400,
                    f"Name '@{name}' collides with a node name; choose a different expert name",
                )

    node_id = expert.node_id
    if body.node_id is not None:
        node_id = _parse_uuid(body.node_id, "node_id")

    node = await _get_worker_node(db, node_id)
    pack = expert.pack_id
    if body.pack_id is not None:
        pack = body.pack_id
    try:
        pack = validate_pack_for_node(node.config, pack)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    expert.name = name
    expert.pack_id = pack
    expert.node_id = node.id
    if body.display_name is not None:
        expert.display_name = body.display_name.strip() or name
    if body.description is not None:
        expert.description = body.description.strip() or None
    if body.enabled is not None:
        expert.enabled = bool(body.enabled)

    try:
        user_uuid = uuid.UUID(str(current_user["user_id"]))
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(401, "Invalid user") from e

    db.add(
        AuditLog(
            actor_type="user",
            actor_id=user_uuid,
            action="expert.update",
            resource_type="expert",
            resource_id=expert.id,
            detail={
                "name": expert.name,
                "pack_id": expert.pack_id,
                "node_id": str(expert.node_id),
                "enabled": expert.enabled,
            },
            status="success",
        )
    )
    await db.commit()
    await db.refresh(expert)
    return expert_to_dict(
        expert,
        node_name=node.name,
        node_status=node.status,
        node_offers=effective_offers(node.config),
    )


@router.delete("/{expert_id}")
async def delete_expert(
    expert_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    eid = _parse_uuid(expert_id)
    expert = await db.get(Expert, eid)
    if not expert:
        raise HTTPException(404, "Expert not found")
    name = expert.name
    pack = expert.pack_id
    node_id = str(expert.node_id)

    try:
        user_uuid = uuid.UUID(str(current_user["user_id"]))
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(401, "Invalid user") from e

    await db.delete(expert)
    db.add(
        AuditLog(
            actor_type="user",
            actor_id=user_uuid,
            action="expert.delete",
            resource_type="expert",
            resource_id=eid,
            detail={"name": name, "pack_id": pack, "node_id": node_id},
            status="success",
        )
    )
    await db.commit()
    return {"ok": True, "id": str(eid)}
