"""Audit log API."""
import uuid
from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.audit import AuditLog
from app.models.conversation import Conversation
from app.models.node import Node

router = APIRouter(prefix="/api/audit", tags=["audit"])


class AuditOut(BaseModel):
    id: str
    timestamp: str
    actor_type: str
    actor_id: str
    actor_name: str | None = None
    action: str
    resource_type: str | None = None
    resource_id: str | None = None
    conversation_id: str | None = None
    status: str
    node_id: str | None = None
    node_name: str | None = None
    activity: str
    result: str
    detail: dict = Field(default_factory=dict)
    model_config = {"from_attributes": True}


@router.get("", response_model=list[AuditOut])
async def list_audit_logs(
    limit: int = Query(50, le=200),
    offset: int = 0,
    conversation_id: str | None = Query(None),
    action: str | None = Query(None),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    q = select(AuditLog)
    if current_user.get("role") != "admin":
        owned_conversations = select(Conversation.id).where(Conversation.user_id == user_id)
        q = q.where(or_(AuditLog.actor_id == user_id, AuditLog.conversation_id.in_(owned_conversations)))
    if conversation_id:
        q = q.where(AuditLog.conversation_id == uuid.UUID(conversation_id))
    if action:
        q = q.where(AuditLog.action == action)
    q = q.order_by(AuditLog.timestamp.desc()).offset(offset).limit(limit)
    result = await db.execute(q)
    rows = result.scalars().all()
    nodes = await _nodes_for_logs(db, rows)
    return [_out(row, nodes) for row in rows]


async def _nodes_for_logs(db: AsyncSession, rows: list[AuditLog]) -> dict[uuid.UUID, Node]:
    node_ids: set[uuid.UUID] = set()
    conversation_ids: set[uuid.UUID] = set()
    for row in rows:
        detail = row.detail if isinstance(row.detail, dict) else {}
        for value in (
            row.actor_id if row.actor_type in {"node", "agent"} else None,
            row.resource_id if row.resource_type == "node" else None,
            detail.get("node_id"),
        ):
            node_id = _uuid(value)
            if node_id:
                node_ids.add(node_id)
        if row.conversation_id:
            conversation_ids.add(row.conversation_id)
    if conversation_ids:
        conversations = await db.execute(select(Conversation).where(Conversation.id.in_(conversation_ids)))
        for conversation in conversations.scalars().all():
            if conversation.node_id:
                node_ids.add(conversation.node_id)
    if not node_ids:
        return {}
    result = await db.execute(select(Node).where(Node.id.in_(node_ids)))
    return {node.id: node for node in result.scalars().all()}


def _out(row: AuditLog, nodes: dict[uuid.UUID, Node]) -> AuditOut:
    detail = row.detail if isinstance(row.detail, dict) else {}
    node_id = _node_id_for_log(row, detail, nodes)
    node = nodes.get(node_id) if node_id else None
    return AuditOut(
        id=str(row.id),
        timestamp=row.timestamp.isoformat(),
        actor_type=row.actor_type,
        actor_id=str(row.actor_id),
        actor_name=row.actor_name,
        action=row.action,
        resource_type=row.resource_type,
        resource_id=str(row.resource_id) if row.resource_id else None,
        conversation_id=str(row.conversation_id) if row.conversation_id else None,
        status=row.status,
        node_id=str(node_id) if node_id else None,
        node_name=node.name if node else None,
        activity=_activity_summary(row.action, detail),
        result=_result_summary(row.status, row.action, detail),
        detail=detail,
    )


def _node_id_for_log(row: AuditLog, detail: dict, nodes: dict[uuid.UUID, Node]) -> uuid.UUID | None:
    for value in (
        row.actor_id if row.actor_type in {"node", "agent"} else None,
        row.resource_id if row.resource_type == "node" else None,
        detail.get("node_id"),
    ):
        node_id = _uuid(value)
        if node_id and node_id in nodes:
            return node_id
    return None


def _uuid(value: object) -> uuid.UUID | None:
    if isinstance(value, uuid.UUID):
        return value
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


def _activity_summary(action: str, detail: dict) -> str:
    if action == "task.assign":
        return "分配任务"
    if action.startswith("node."):
        return "节点状态变更"
    if action == "tool.execute":
        tool = detail.get("tool_name") or "tool"
        command = detail.get("command")
        return f"执行工具 {tool}" + (f": {command}" if command else "")
    if action == "asset.discover":
        return f"发现资产 {detail.get('address') or ''}".strip()
    if action == "evidence.create":
        return f"记录证据 {detail.get('evidence_id') or ''}".strip()
    if action.startswith("finding."):
        return f"处理漏洞 {detail.get('title') or ''}".strip()
    if action.startswith("approval."):
        return "授权确认"
    if action.startswith("conversation."):
        return "会话操作"
    if action.startswith("sync."):
        return "导入会话"
    return action


def _result_summary(status: str, action: str, detail: dict) -> str:
    if action == "tool.execute":
        raw_status = detail.get("raw_status") or status
        line = str(detail.get("line") or "").strip()
        return f"{raw_status}" + (f" · {line[:160]}" if line else "")
    if action.startswith("node."):
        return action.removeprefix("node.")
    if action.startswith("finding."):
        severity = detail.get("severity")
        finding_status = detail.get("status")
        return " · ".join(str(item) for item in (severity, finding_status, status) if item)
    if action.startswith("approval."):
        return action.removeprefix("approval.")
    return status
