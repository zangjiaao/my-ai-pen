"""Global operations dashboard — information hub (user-scoped).

Sections: vulnerabilities, assets, nodes, tasks (conversations), schedules.
Conversation remains the product home; this is a status board only.
"""
from __future__ import annotations

import os
import uuid
from collections import Counter
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.vulnerabilities import normalize_status
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.conversation import Conversation
from app.models.node import PLATFORM_AGENT_NODE_ID, Node
from app.models.vulnerability import Vulnerability
from app.services.conversation_state import reconcile_conversation_status_from_checkpoint
from app.services.schedule_tasks import get_schedule_store

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

_SEVERITIES = ("critical", "high", "medium", "low", "info")
_STATUSES = ("to_fix", "fixing", "fixed")

_STATUS_LABEL = {
    "to_fix": "待修复",
    "fixing": "修复中",
    "fixed": "已修复",
}


def _schedule_store():
    path = os.environ.get("NODE4_SCHEDULE_STORE")
    return get_schedule_store(Path(path) if path else None)


# ----- section models -----


class FindingItem(BaseModel):
    id: str
    title: str
    severity: str
    status: str
    status_label: str
    discovered_at: str | None = None
    conversation_id: str | None = None


class VulnSection(BaseModel):
    total: int = 0
    open_total: int = 0
    by_status: dict[str, int] = Field(default_factory=dict)
    by_severity: dict[str, int] = Field(default_factory=dict)
    recent: list[FindingItem] = Field(default_factory=list)


class AssetItem(BaseModel):
    id: str
    name: str
    address: str
    type: str
    tags: list[str] = Field(default_factory=list)
    updated_at: str | None = None


class AssetSection(BaseModel):
    total: int = 0
    recent: list[AssetItem] = Field(default_factory=list)


class NodeItem(BaseModel):
    id: str
    name: str
    status: str
    type: str
    current_sessions: int = 0
    last_heartbeat: str | None = None


class NodeSection(BaseModel):
    total: int = 0
    online: int = 0
    offline: int = 0
    items: list[NodeItem] = Field(default_factory=list)


class TaskItem(BaseModel):
    id: str
    title: str
    status: str
    working: bool = False
    last_active_at: str | None = None
    node_id: str | None = None


class TaskSection(BaseModel):
    total: int = 0
    by_status: dict[str, int] = Field(default_factory=dict)
    running: int = 0
    recent: list[TaskItem] = Field(default_factory=list)


class ScheduleItem(BaseModel):
    id: str
    target: str
    engagement: str
    interval_seconds: int
    enabled: bool
    next_fire_at: str | None = None
    last_fire_at: str | None = None


class ScheduleSection(BaseModel):
    total: int = 0
    enabled: int = 0
    items: list[ScheduleItem] = Field(default_factory=list)


class DashboardSummaryOut(BaseModel):
    """Aggregated hub payload."""

    vulnerabilities: VulnSection = Field(default_factory=VulnSection)
    assets: AssetSection = Field(default_factory=AssetSection)
    nodes: NodeSection = Field(default_factory=NodeSection)
    tasks: TaskSection = Field(default_factory=TaskSection)
    schedules: ScheduleSection = Field(default_factory=ScheduleSection)

    # Back-compat flat fields (older frontend / bookmarks)
    assets_total: int = 0
    conversations_total: int = 0
    nodes_online: int = 0
    nodes_total: int = 0
    vulns_total: int = 0
    by_status: dict[str, int] = Field(default_factory=dict)
    by_severity: dict[str, int] = Field(default_factory=dict)
    open_total: int = 0
    recent_findings: list[FindingItem] = Field(default_factory=list)


def _conv_working(status: str) -> bool:
    s = (status or "").lower()
    return s in {"running", "working", "busy"}


@router.get("/summary", response_model=DashboardSummaryOut)
async def dashboard_summary(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(str(current_user["user_id"]))
    uid_str = str(current_user["user_id"])

    # --- assets ---
    assets = (
        await db.execute(
            select(Asset)
            .where(Asset.user_id == user_id)
            .order_by(Asset.updated_at.desc())
            .limit(8)
        )
    ).scalars().all()
    assets_total = int(
        (
            await db.execute(select(func.count()).select_from(Asset).where(Asset.user_id == user_id))
        ).scalar_one()
        or 0
    )
    asset_section = AssetSection(
        total=assets_total,
        recent=[
            AssetItem(
                id=str(a.id),
                name=a.name,
                address=a.address,
                type=a.type,
                tags=list(a.tags or []),
                updated_at=a.updated_at.isoformat() if a.updated_at else None,
            )
            for a in assets
        ],
    )

    # --- nodes (worker only) ---
    nodes = (
        await db.execute(
            select(Node)
            .where(Node.type != "platform", Node.id != PLATFORM_AGENT_NODE_ID)
            .order_by(Node.registered_at.desc())
        )
    ).scalars().all()
    online = sum(1 for n in nodes if (n.status or "").lower() == "online")
    node_section = NodeSection(
        total=len(nodes),
        online=online,
        offline=max(0, len(nodes) - online),
        items=[
            NodeItem(
                id=str(n.id),
                name=n.name,
                status=n.status or "offline",
                type=n.type or "pentest",
                current_sessions=int(n.current_sessions or 0),
                last_heartbeat=n.last_heartbeat.isoformat() if n.last_heartbeat else None,
            )
            for n in nodes[:12]
        ],
    )

    # --- tasks / conversations ---
    convs = (
        await db.execute(
            select(Conversation)
            .where(Conversation.user_id == user_id)
            .order_by(Conversation.last_active_at.desc())
            .limit(40)
        )
    ).scalars().all()
    healed = False
    for c in convs:
        if reconcile_conversation_status_from_checkpoint(c):
            healed = True
    if healed:
        await db.commit()

    conv_total = int(
        (
            await db.execute(
                select(func.count()).select_from(Conversation).where(Conversation.user_id == user_id)
            )
        ).scalar_one()
        or 0
    )
    by_task_status: Counter[str] = Counter()
    for c in convs:
        by_task_status[str(c.status or "unknown")] += 1
    # Approximate global by_status from recent page if total > sample — better query all statuses lightly
    all_status_rows = (
        await db.execute(
            select(Conversation.status, func.count())
            .where(Conversation.user_id == user_id)
            .group_by(Conversation.status)
        )
    ).all()
    by_task_status = Counter({str(s or "unknown"): int(n) for s, n in all_status_rows})
    # Active tasks only (running / working / busy)
    active_running = sum(
        n for s, n in by_task_status.items() if str(s).lower() in {"running", "working", "busy"}
    )
    task_section = TaskSection(
        total=conv_total,
        by_status=dict(by_task_status),
        running=active_running,
        recent=[
            TaskItem(
                id=str(c.id),
                title=c.title or "会话",
                status=c.status or "unknown",
                working=_conv_working(c.status or ""),
                last_active_at=c.last_active_at.isoformat() if c.last_active_at else None,
                node_id=str(c.node_id) if c.node_id else None,
            )
            for c in convs[:10]
        ],
    )

    # --- vulnerabilities ---
    vulns = (
        await db.execute(select(Vulnerability).where(Vulnerability.user_id == user_id))
    ).scalars().all()
    by_status = Counter({s: 0 for s in _STATUSES})
    by_severity = Counter({s: 0 for s in _SEVERITIES})
    for v in vulns:
        st = normalize_status(v.status)
        by_status[st] = by_status.get(st, 0) + 1
        sev = str(v.severity or "info").strip().lower() or "info"
        if sev not in by_severity:
            sev = "info"
        by_severity[sev] = by_severity.get(sev, 0) + 1
    open_total = int(by_status.get("to_fix", 0) + by_status.get("fixing", 0))
    sorted_vulns = sorted(
        vulns,
        key=lambda v: v.discovered_at or v.updated_at,
        reverse=True,
    )[:10]
    recent_findings = [
        FindingItem(
            id=str(v.id),
            title=v.title,
            severity=str(v.severity or "info").lower(),
            status=normalize_status(v.status),
            status_label=_STATUS_LABEL.get(normalize_status(v.status), normalize_status(v.status)),
            discovered_at=v.discovered_at.isoformat() if v.discovered_at else None,
            conversation_id=str(v.conversation_id) if v.conversation_id else None,
        )
        for v in sorted_vulns
    ]
    vuln_section = VulnSection(
        total=len(vulns),
        open_total=open_total,
        by_status=dict(by_status),
        by_severity=dict(by_severity),
        recent=recent_findings,
    )

    # --- schedules ---
    store = _schedule_store()
    schedules = store.list_for_user(uid_str)
    schedule_section = ScheduleSection(
        total=len(schedules),
        enabled=sum(1 for s in schedules if s.enabled),
        items=[
            ScheduleItem(
                id=s.id,
                target=s.target,
                engagement=s.engagement,
                interval_seconds=int(s.interval_seconds),
                enabled=bool(s.enabled),
                next_fire_at=s.next_fire_at,
                last_fire_at=s.last_fire_at,
            )
            for s in sorted(
                schedules,
                key=lambda x: x.next_fire_at or x.created_at or "",
            )[:10]
        ],
    )

    return DashboardSummaryOut(
        vulnerabilities=vuln_section,
        assets=asset_section,
        nodes=node_section,
        tasks=task_section,
        schedules=schedule_section,
        assets_total=assets_total,
        conversations_total=conv_total,
        nodes_online=online,
        nodes_total=len(nodes),
        vulns_total=len(vulns),
        by_status=dict(by_status),
        by_severity=dict(by_severity),
        open_total=open_total,
        recent_findings=recent_findings,
    )
