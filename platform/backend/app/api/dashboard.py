"""Global operations dashboard (user-scoped ledger summary).

Not the conversation engagement dashboard — conversation remains the product home.
"""
from __future__ import annotations

import uuid
from collections import Counter

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.vulnerabilities import normalize_status
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.conversation import Conversation
from app.models.node import Node
from app.models.vulnerability import Vulnerability

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

_SEVERITIES = ("critical", "high", "medium", "low", "info")
_STATUSES = ("to_fix", "fixing", "fixed")


class RecentFindingOut(BaseModel):
    id: str
    title: str
    severity: str
    status: str
    status_label: str
    discovered_at: str | None = None
    conversation_id: str | None = None


class DashboardSummaryOut(BaseModel):
    assets_total: int = 0
    conversations_total: int = 0
    nodes_online: int = 0
    nodes_total: int = 0
    vulns_total: int = 0
    by_status: dict[str, int] = Field(default_factory=dict)
    by_severity: dict[str, int] = Field(default_factory=dict)
    open_total: int = 0  # to_fix + fixing
    recent_findings: list[RecentFindingOut] = Field(default_factory=list)


_STATUS_LABEL = {
    "to_fix": "待修复",
    "fixing": "修复中",
    "fixed": "已修复",
}


@router.get("/summary", response_model=DashboardSummaryOut)
async def dashboard_summary(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(str(current_user["user_id"]))

    assets_total = int(
        (
            await db.execute(select(func.count()).select_from(Asset).where(Asset.user_id == user_id))
        ).scalar_one()
        or 0
    )
    conversations_total = int(
        (
            await db.execute(
                select(func.count()).select_from(Conversation).where(Conversation.user_id == user_id)
            )
        ).scalar_one()
        or 0
    )

    nodes_total = int((await db.execute(select(func.count()).select_from(Node))).scalar_one() or 0)
    nodes_online = int(
        (
            await db.execute(
                select(func.count()).select_from(Node).where(Node.status == "online")
            )
        ).scalar_one()
        or 0
    )

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

    # Recent by discovered_at desc
    sorted_vulns = sorted(
        vulns,
        key=lambda v: v.discovered_at or v.updated_at,
        reverse=True,
    )[:12]
    recent = [
        RecentFindingOut(
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

    return DashboardSummaryOut(
        assets_total=assets_total,
        conversations_total=conversations_total,
        nodes_online=nodes_online,
        nodes_total=nodes_total,
        vulns_total=len(vulns),
        by_status=dict(by_status),
        by_severity=dict(by_severity),
        open_total=open_total,
        recent_findings=recent,
    )
