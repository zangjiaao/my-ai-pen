"""Audit log API — platform system operations (CRUD), not agent runtime noise."""
import uuid
from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.audit import AuditLog
from app.models.conversation import Conversation
from app.models.node import Node
from app.models.user import User
from app.models.vulnerability import Vulnerability

router = APIRouter(prefix="/api/audit", tags=["audit"])

# Platform operation ledger only. Agent/tool/finding noise stays out of the default list.
SYSTEM_ACTIONS = frozenset({
    "auth.login",
    "conversation.create",
    "conversation.update",
    "conversation.delete",
    "conversation.archive",
    "asset.create",
    "asset.update",
    "asset.delete",
    "node.register",
    "node.update",
    "node.regenerate_token",
    "node.delete",
    "vulnerability.update",
    "vuln.retest",
    "sync.import_report",
})

ACTION_LABELS: dict[str, str] = {
    "auth.login": "登录",
    "conversation.create": "创建会话",
    "conversation.update": "更新会话",
    "conversation.delete": "删除会话",
    "conversation.archive": "归档会话",
    "asset.create": "创建资产",
    "asset.update": "更新资产",
    "asset.delete": "删除资产",
    "node.register": "注册节点",
    "node.update": "更新节点",
    "node.regenerate_token": "刷新节点 Token",
    "node.delete": "删除节点",
    "vulnerability.update": "更新漏洞",
    "vuln.retest": "发起复测",
    "sync.import_report": "导入报告",
}

RESOURCE_TYPE_LABELS: dict[str, str] = {
    "conversation": "会话",
    "asset": "资产",
    "node": "节点",
    "vulnerability": "漏洞",
    "user": "用户",
    "report": "报告",
}

# Map filter category → action prefixes / exact actions
CATEGORY_ACTIONS: dict[str, frozenset[str]] = {
    "auth": frozenset({"auth.login"}),
    "conversation": frozenset({
        "conversation.create",
        "conversation.update",
        "conversation.delete",
        "conversation.archive",
    }),
    "asset": frozenset({"asset.create", "asset.update", "asset.delete"}),
    "node": frozenset({
        "node.register",
        "node.update",
        "node.regenerate_token",
        "node.delete",
    }),
    "vulnerability": frozenset({"vulnerability.update", "vuln.retest"}),
    "sync": frozenset({"sync.import_report"}),
}


class AuditOut(BaseModel):
    id: str
    timestamp: str
    actor_type: str
    actor_id: str
    actor_name: str | None = None
    actor_display: str
    action: str
    action_label: str
    resource_type: str | None = None
    resource_type_label: str | None = None
    resource_id: str | None = None
    resource_label: str | None = None
    conversation_id: str | None = None
    status: str
    status_label: str
    summary: str
    detail: dict = Field(default_factory=dict)
    # Legacy fields kept for any older clients
    activity: str
    result: str
    node_id: str | None = None
    node_name: str | None = None
    model_config = {"from_attributes": True}


@router.get("", response_model=list[AuditOut])
async def list_audit_logs(
    limit: int = Query(100, le=200),
    offset: int = 0,
    scope: str = Query("system", description="system (default) | all"),
    category: str | None = Query(None, description="auth|conversation|asset|node|vulnerability|sync"),
    status: str | None = Query(None),
    action: str | None = Query(None),
    conversation_id: str | None = Query(None),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    q = select(AuditLog)

    if current_user.get("role") != "admin":
        owned_conversations = select(Conversation.id).where(Conversation.user_id == user_id)
        q = q.where(or_(AuditLog.actor_id == user_id, AuditLog.conversation_id.in_(owned_conversations)))

    scope_norm = (scope or "system").strip().lower()
    if scope_norm != "all":
        q = q.where(AuditLog.action.in_(SYSTEM_ACTIONS))

    if category:
        cat = category.strip().lower()
        allowed = CATEGORY_ACTIONS.get(cat)
        if allowed:
            q = q.where(AuditLog.action.in_(allowed))
        else:
            return []

    if status:
        q = q.where(AuditLog.status == status.strip().lower())

    if action:
        q = q.where(AuditLog.action == action.strip())

    if conversation_id:
        q = q.where(AuditLog.conversation_id == uuid.UUID(conversation_id))

    q = q.order_by(AuditLog.timestamp.desc()).offset(offset).limit(limit)
    result = await db.execute(q)
    rows = result.scalars().all()
    ctx = await _resolve_context(db, rows)
    return [_out(row, ctx) for row in rows]


class AuditContext:
    def __init__(self) -> None:
        self.users: dict[uuid.UUID, User] = {}
        self.nodes: dict[uuid.UUID, Node] = {}
        self.conversations: dict[uuid.UUID, Conversation] = {}
        self.assets: dict[uuid.UUID, Asset] = {}
        self.vulns: dict[uuid.UUID, Vulnerability] = {}


async def _resolve_context(db: AsyncSession, rows: list[AuditLog]) -> AuditContext:
    ctx = AuditContext()
    user_ids: set[uuid.UUID] = set()
    node_ids: set[uuid.UUID] = set()
    conv_ids: set[uuid.UUID] = set()
    asset_ids: set[uuid.UUID] = set()
    vuln_ids: set[uuid.UUID] = set()

    for row in rows:
        if row.actor_type == "user" and row.actor_id:
            user_ids.add(row.actor_id)
        if row.conversation_id:
            conv_ids.add(row.conversation_id)
        if row.resource_type == "node" and row.resource_id:
            node_ids.add(row.resource_id)
        if row.resource_type == "conversation" and row.resource_id:
            conv_ids.add(row.resource_id)
        if row.resource_type == "asset" and row.resource_id:
            asset_ids.add(row.resource_id)
        if row.resource_type == "vulnerability" and row.resource_id:
            vuln_ids.add(row.resource_id)
        detail = row.detail if isinstance(row.detail, dict) else {}
        nid = _uuid(detail.get("node_id"))
        if nid:
            node_ids.add(nid)

    if user_ids:
        result = await db.execute(select(User).where(User.id.in_(user_ids)))
        ctx.users = {u.id: u for u in result.scalars().all()}
    if node_ids:
        result = await db.execute(select(Node).where(Node.id.in_(node_ids)))
        ctx.nodes = {n.id: n for n in result.scalars().all()}
    if conv_ids:
        result = await db.execute(select(Conversation).where(Conversation.id.in_(conv_ids)))
        ctx.conversations = {c.id: c for c in result.scalars().all()}
    if asset_ids:
        result = await db.execute(select(Asset).where(Asset.id.in_(asset_ids)))
        ctx.assets = {a.id: a for a in result.scalars().all()}
    if vuln_ids:
        result = await db.execute(select(Vulnerability).where(Vulnerability.id.in_(vuln_ids)))
        ctx.vulns = {v.id: v for v in result.scalars().all()}
    return ctx


def _out(row: AuditLog, ctx: AuditContext) -> AuditOut:
    detail = row.detail if isinstance(row.detail, dict) else {}
    action_label = ACTION_LABELS.get(row.action, row.action)
    resource_type_label = (
        RESOURCE_TYPE_LABELS.get(row.resource_type or "", row.resource_type) if row.resource_type else None
    )
    actor_display = _actor_display(row, ctx)
    resource_label = _resource_label(row, detail, ctx)
    summary = _summary(row.action, detail, resource_label)
    status_label = _status_label(row.status)
    node_id = None
    node_name = None
    if row.resource_type == "node" and row.resource_id and row.resource_id in ctx.nodes:
        node_id = row.resource_id
        node_name = ctx.nodes[node_id].name
    else:
        maybe = _uuid(detail.get("node_id"))
        if maybe and maybe in ctx.nodes:
            node_id = maybe
            node_name = ctx.nodes[maybe].name

    return AuditOut(
        id=str(row.id),
        timestamp=row.timestamp.isoformat(),
        actor_type=row.actor_type,
        actor_id=str(row.actor_id),
        actor_name=row.actor_name,
        actor_display=actor_display,
        action=row.action,
        action_label=action_label,
        resource_type=row.resource_type,
        resource_type_label=resource_type_label,
        resource_id=str(row.resource_id) if row.resource_id else None,
        resource_label=resource_label,
        conversation_id=str(row.conversation_id) if row.conversation_id else None,
        status=row.status,
        status_label=status_label,
        summary=summary,
        detail=detail,
        activity=action_label,
        result=status_label,
        node_id=str(node_id) if node_id else None,
        node_name=node_name,
    )


def _actor_display(row: AuditLog, ctx: AuditContext) -> str:
    if row.actor_name:
        return str(row.actor_name)
    if row.actor_type == "user" and row.actor_id in ctx.users:
        user = ctx.users[row.actor_id]
        return (user.display_name or user.email or str(row.actor_id)[:8]).strip()
    if row.actor_type == "system":
        return "系统"
    if row.actor_type == "node" and row.actor_id in ctx.nodes:
        return ctx.nodes[row.actor_id].name
    return row.actor_type or "—"


def _resource_label(row: AuditLog, detail: dict, ctx: AuditContext) -> str | None:
    rtype = row.resource_type or ""
    rid = row.resource_id

    if rtype == "conversation":
        title = detail.get("title")
        if isinstance(title, str) and title.strip():
            return title.strip()
        if rid and rid in ctx.conversations:
            return ctx.conversations[rid].title or str(rid)[:8]
        if row.conversation_id and row.conversation_id in ctx.conversations:
            return ctx.conversations[row.conversation_id].title or str(row.conversation_id)[:8]

    if rtype == "asset":
        address = detail.get("address")
        if isinstance(address, str) and address.strip():
            return address.strip()
        if rid and rid in ctx.assets:
            a = ctx.assets[rid]
            return a.name or a.address or str(rid)[:8]

    if rtype == "node":
        name = detail.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
        if rid and rid in ctx.nodes:
            return ctx.nodes[rid].name

    if rtype == "vulnerability":
        title = detail.get("title")
        if isinstance(title, str) and title.strip():
            return title.strip()
        if rid and rid in ctx.vulns:
            return ctx.vulns[rid].title or str(rid)[:8]

    if rtype == "user":
        email = detail.get("email")
        if isinstance(email, str) and email.strip():
            return email.strip()

    if rid:
        return str(rid)[:8]
    return None


def _summary(action: str, detail: dict, resource_label: str | None) -> str:
    label = ACTION_LABELS.get(action, action)
    if action == "auth.login":
        reason = detail.get("reason")
        email = detail.get("email")
        parts = [label]
        if email:
            parts.append(str(email))
        if reason and reason != "password":
            parts.append(str(reason))
        return " · ".join(parts)
    if action == "node.update":
        fields = detail.get("fields")
        if isinstance(fields, list) and fields:
            return f"{label} · {', '.join(str(f) for f in fields[:6])}"
    if action in {"conversation.update", "asset.update", "vulnerability.update"}:
        fields = detail.get("fields")
        if isinstance(fields, list) and fields:
            base = f"{label}" + (f" · {resource_label}" if resource_label else "")
            return f"{base} · {', '.join(str(f) for f in fields[:6])}"
    if resource_label:
        return f"{label} · {resource_label}"
    return label


def _status_label(status: str) -> str:
    mapping = {
        "success": "成功",
        "failed": "失败",
        "error": "错误",
        "blocked": "已拦截",
    }
    return mapping.get(status, status or "—")


def _uuid(value: object) -> uuid.UUID | None:
    if isinstance(value, uuid.UUID):
        return value
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None
