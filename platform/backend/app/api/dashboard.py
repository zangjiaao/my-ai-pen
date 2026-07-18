"""Global operations dashboard — information hub (user-scoped).

Card layout (frontend):
  1. KPI strip
  2. 每日未修复漏洞 (2/3 stacked bar) | 新增漏洞列表 (1/3)
  3. 节点 | 专家 | 任务
"""
from __future__ import annotations

import os
import uuid
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
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
from app.models.expert import Expert
from app.models.node import PLATFORM_AGENT_NODE_ID, Node
from app.models.vulnerability import Vulnerability
from app.services.conversation_state import reconcile_conversation_status_from_checkpoint
from app.services.schedule_tasks import get_schedule_store

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

_SEVERITIES = ("critical", "high", "medium", "low", "info")
_STATUSES = ("to_fix", "fixing", "fixed")
_SEV_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
_DAILY_OPEN_DAYS = 14

_STATUS_LABEL = {
    "to_fix": "待修复",
    "fixing": "修复中",
    "fixed": "已修复",
}


def _schedule_store():
    path = os.environ.get("NODE4_SCHEDULE_STORE")
    return get_schedule_store(Path(path) if path else None)


class FindingItem(BaseModel):
    id: str
    title: str
    severity: str
    status: str
    status_label: str
    discovered_at: str | None = None
    conversation_id: str | None = None
    asset_id: str | None = None


class VulnSection(BaseModel):
    total: int = 0
    open_total: int = 0
    by_status: dict[str, int] = Field(default_factory=dict)
    by_severity: dict[str, int] = Field(default_factory=dict)
    recent: list[FindingItem] = Field(default_factory=list)


class DailyOpenPoint(BaseModel):
    """One day of currently unrepaired findings, stacked by severity."""

    date: str
    critical: int = 0
    high: int = 0
    medium: int = 0
    low: int = 0
    info: int = 0
    total: int = 0


class OpenFindingPoint(BaseModel):
    """Unrepaired finding point for client-side daily chart + asset filter."""

    date: str
    severity: str
    asset_id: str | None = None


class DailyOpenSection(BaseModel):
    """Daily unrepaired counts (bucketed by first_seen/discovered date)."""

    days: int = _DAILY_OPEN_DAYS
    series: list[DailyOpenPoint] = Field(default_factory=list)
    open_points: list[OpenFindingPoint] = Field(default_factory=list)


class ChartAssetOption(BaseModel):
    id: str
    name: str
    address: str


class AssetRiskItem(BaseModel):
    """Asset with open vulnerability stats (kept for KPI / future cards)."""

    id: str
    name: str
    address: str
    type: str
    open_vulns: int = 0
    total_vulns: int = 0
    highest_severity: str | None = None
    tags: list[str] = Field(default_factory=list)
    updated_at: str | None = None


class AssetSection(BaseModel):
    total: int = 0
    with_open_vulns: int = 0
    items: list[AssetRiskItem] = Field(default_factory=list)
    # Full list for chart asset filter (id / name / address)
    chart_options: list[ChartAssetOption] = Field(default_factory=list)


class NodeItem(BaseModel):
    id: str
    name: str
    status: str
    type: str
    current_sessions: int = 0
    last_heartbeat: str | None = None
    offers: list[str] = Field(default_factory=list)


class NodeSection(BaseModel):
    total: int = 0
    online: int = 0
    offline: int = 0
    items: list[NodeItem] = Field(default_factory=list)


class ExpertItem(BaseModel):
    id: str
    name: str
    pack_id: str
    node_id: str
    node_name: str | None = None
    enabled: bool = True


class ExpertSection(BaseModel):
    total: int = 0
    items: list[ExpertItem] = Field(default_factory=list)


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
    vulnerabilities: VulnSection = Field(default_factory=VulnSection)
    daily_open: DailyOpenSection = Field(default_factory=DailyOpenSection)
    assets: AssetSection = Field(default_factory=AssetSection)
    nodes: NodeSection = Field(default_factory=NodeSection)
    experts: ExpertSection = Field(default_factory=ExpertSection)
    tasks: TaskSection = Field(default_factory=TaskSection)
    schedules: ScheduleSection = Field(default_factory=ScheduleSection)

    # flat KPI helpers
    assets_total: int = 0
    conversations_total: int = 0
    nodes_online: int = 0
    nodes_total: int = 0
    vulns_total: int = 0
    by_status: dict[str, int] = Field(default_factory=dict)
    by_severity: dict[str, int] = Field(default_factory=dict)
    open_total: int = 0
    recent_findings: list[FindingItem] = Field(default_factory=list)
    experts_total: int = 0
    schedules_total: int = 0


def _conv_working(status: str) -> bool:
    return (status or "").lower() in {"running", "working", "busy"}


def _highest_sev(sevs: list[str]) -> str | None:
    if not sevs:
        return None
    return min(sevs, key=lambda s: _SEV_RANK.get(s, 9))


def _vuln_day(v: Vulnerability) -> date | None:
    """Calendar day for chart bucketing (first_seen preferred, else discovered)."""
    raw = v.first_seen_at or v.discovered_at
    if raw is None:
        return None
    if raw.tzinfo is None:
        raw = raw.replace(tzinfo=timezone.utc)
    return raw.astimezone(timezone.utc).date()


def _build_daily_open(open_points: list[OpenFindingPoint], days: int = _DAILY_OPEN_DAYS) -> list[DailyOpenPoint]:
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=days - 1)
    buckets: dict[str, Counter[str]] = {
        (start + timedelta(days=i)).isoformat(): Counter({s: 0 for s in _SEVERITIES})
        for i in range(days)
    }
    for p in open_points:
        if p.date not in buckets:
            continue
        sev = p.severity if p.severity in buckets[p.date] else "info"
        buckets[p.date][sev] += 1
    out: list[DailyOpenPoint] = []
    for i in range(days):
        d = (start + timedelta(days=i)).isoformat()
        c = buckets[d]
        total = sum(c.values())
        out.append(
            DailyOpenPoint(
                date=d,
                critical=int(c.get("critical", 0)),
                high=int(c.get("high", 0)),
                medium=int(c.get("medium", 0)),
                low=int(c.get("low", 0)),
                info=int(c.get("info", 0)),
                total=total,
            )
        )
    return out


@router.get("/summary", response_model=DashboardSummaryOut)
async def dashboard_summary(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(str(current_user["user_id"]))
    uid_str = str(current_user["user_id"])

    # --- vulnerabilities ---
    vulns = (
        await db.execute(select(Vulnerability).where(Vulnerability.user_id == user_id))
    ).scalars().all()
    by_status = Counter({s: 0 for s in _STATUSES})
    by_severity = Counter({s: 0 for s in _SEVERITIES})
    open_by_asset: dict[str, list[str]] = defaultdict(list)
    total_by_asset: Counter[str] = Counter()
    open_points: list[OpenFindingPoint] = []
    for v in vulns:
        st = normalize_status(v.status)
        by_status[st] = by_status.get(st, 0) + 1
        sev = str(v.severity or "info").strip().lower() or "info"
        if sev not in by_severity:
            sev = "info"
        by_severity[sev] = by_severity.get(sev, 0) + 1
        aid = str(v.asset_id) if v.asset_id else None
        if aid:
            total_by_asset[aid] += 1
            if st in ("to_fix", "fixing"):
                open_by_asset[aid].append(sev)
        if st in ("to_fix", "fixing"):
            day = _vuln_day(v)
            if day is not None:
                open_points.append(
                    OpenFindingPoint(
                        date=day.isoformat(),
                        severity=sev,
                        asset_id=aid,
                    )
                )
    open_total = int(by_status.get("to_fix", 0) + by_status.get("fixing", 0))
    sorted_vulns = sorted(
        vulns,
        key=lambda v: v.discovered_at or v.updated_at,
        reverse=True,
    )[:12]
    recent_findings = [
        FindingItem(
            id=str(v.id),
            title=v.title,
            severity=str(v.severity or "info").lower(),
            status=normalize_status(v.status),
            status_label=_STATUS_LABEL.get(normalize_status(v.status), normalize_status(v.status)),
            discovered_at=v.discovered_at.isoformat() if v.discovered_at else None,
            conversation_id=str(v.conversation_id) if v.conversation_id else None,
            asset_id=str(v.asset_id) if v.asset_id else None,
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
    daily_open_section = DailyOpenSection(
        days=_DAILY_OPEN_DAYS,
        series=_build_daily_open(open_points, _DAILY_OPEN_DAYS),
        open_points=open_points,
    )

    # --- assets + open vuln mapping ---
    assets = (
        await db.execute(
            select(Asset).where(Asset.user_id == user_id).order_by(Asset.updated_at.desc())
        )
    ).scalars().all()
    asset_items: list[AssetRiskItem] = []
    chart_options: list[ChartAssetOption] = []
    with_open = 0
    for a in assets:
        aid = str(a.id)
        open_sevs = open_by_asset.get(aid) or []
        open_n = len(open_sevs)
        if open_n:
            with_open += 1
        chart_options.append(
            ChartAssetOption(id=aid, name=a.name or a.address, address=a.address)
        )
        asset_items.append(
            AssetRiskItem(
                id=aid,
                name=a.name,
                address=a.address,
                type=a.type,
                open_vulns=open_n,
                total_vulns=int(total_by_asset.get(aid, 0)),
                highest_severity=_highest_sev(open_sevs),
                tags=list(a.tags or []),
                updated_at=a.updated_at.isoformat() if a.updated_at else None,
            )
        )
    # Prefer assets with open vulns first for the card
    asset_items.sort(key=lambda x: (-x.open_vulns, x.address))
    chart_options.sort(key=lambda x: x.address)
    asset_section = AssetSection(
        total=len(assets),
        with_open_vulns=with_open,
        items=asset_items[:12],
        chart_options=chart_options,
    )

    # --- nodes ---
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
                offers=list((n.config or {}).get("offers") or [])
                if isinstance(n.config, dict)
                else [],
            )
            for n in nodes[:12]
        ],
    )
    node_name_by_id = {str(n.id): n.name for n in nodes}

    # --- experts ---
    experts = (
        await db.execute(select(Expert).order_by(Expert.name.asc()).limit(40))
    ).scalars().all()
    expert_section = ExpertSection(
        total=len(experts),
        items=[
            ExpertItem(
                id=str(e.id),
                name=e.name,
                pack_id=e.pack_id,
                node_id=str(e.node_id),
                node_name=node_name_by_id.get(str(e.node_id)),
                enabled=bool(getattr(e, "enabled", True)),
            )
            for e in experts[:12]
        ],
    )

    # --- tasks ---
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
    all_status_rows = (
        await db.execute(
            select(Conversation.status, func.count())
            .where(Conversation.user_id == user_id)
            .group_by(Conversation.status)
        )
    ).all()
    by_task_status = Counter({str(s or "unknown"): int(n) for s, n in all_status_rows})
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

    # --- schedules (still in payload for task card footer / future) ---
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
            for s in sorted(schedules, key=lambda x: x.next_fire_at or x.created_at or "")[:8]
        ],
    )

    return DashboardSummaryOut(
        vulnerabilities=vuln_section,
        daily_open=daily_open_section,
        assets=asset_section,
        nodes=node_section,
        experts=expert_section,
        tasks=task_section,
        schedules=schedule_section,
        assets_total=len(assets),
        conversations_total=conv_total,
        nodes_online=online,
        nodes_total=len(nodes),
        vulns_total=len(vulns),
        by_status=dict(by_status),
        by_severity=dict(by_severity),
        open_total=open_total,
        recent_findings=recent_findings,
        experts_total=len(experts),
        schedules_total=len(schedules),
    )
