"""Conversation detection reports — multi-revision delivery exports.

Product UI lists agent/ledger-generated report revisions and downloads MD/HTML.
Live ledger snapshot export remains available as a one-shot draft path.
"""
from __future__ import annotations

import re
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.conversation import Conversation
from app.models.evidence import Evidence
from app.models.vulnerability import Vulnerability
from app.services.conversation_reports import (
    content_disposition_attachment,
    create_report,
    delete_report,
    get_report,
    list_reports,
    render_report_download,
    report_to_dict,
)
from app.services.conversation_snapshot import build_conversation_snapshot
from app.services.delivery_findings import map_vulnerability_orm
from app.services.engagement_report import (
    build_engagement_report_html,
    build_engagement_report_markdown,
)

router = APIRouter(prefix="/api/reports", tags=["reports"])


async def _get_owned_conversation(
    db: AsyncSession, conv_id: str, user_id: uuid.UUID
) -> Conversation:
    try:
        cid = uuid.UUID(conv_id)
    except ValueError as e:
        raise HTTPException(400, "invalid conversation id") from e
    result = await db.execute(
        select(Conversation).where(Conversation.id == cid, Conversation.user_id == user_id)
    )
    conversation = result.scalar_one_or_none()
    if not conversation:
        raise HTTPException(404, "Conversation not found")
    return conversation


async def _load_delivery_context(
    db: AsyncSession,
    *,
    conversation: Conversation,
    user_id: uuid.UUID,
) -> dict[str, Any]:
    """Load booked findings + evidence (ledger only — no candidate snapshot)."""
    snapshot = await build_conversation_snapshot(db, conversation, user_id)

    vulns_result = await db.execute(
        select(Vulnerability).where(
            Vulnerability.conversation_id == conversation.id,
            Vulnerability.user_id == user_id,
        )
    )
    vulns = list(vulns_result.scalars().all())

    asset_ids = [v.asset_id for v in vulns if getattr(v, "asset_id", None)]
    assets_by_id: dict[Any, Asset] = {}
    if asset_ids:
        assets_result = await db.execute(select(Asset).where(Asset.id.in_(asset_ids)))
        for a in assets_result.scalars().all():
            assets_by_id[a.id] = a

    findings: list[dict[str, Any]] = []
    for v in vulns:
        asset = assets_by_id.get(v.asset_id) if v.asset_id else None
        mapped = map_vulnerability_orm(v, asset)
        if mapped:
            findings.append(mapped)

    ev_result = await db.execute(
        select(Evidence).where(
            Evidence.conversation_id == conversation.id,
            Evidence.user_id == user_id,
        )
    )
    evidence_by_id: dict[str, Any] = {}
    for e in ev_result.scalars().all():
        key = str(e.evidence_id or e.id)
        evidence_by_id[key] = {"id": key, "summary": e.summary, "type": e.type}

    ctx = conversation.context if isinstance(conversation.context, dict) else {}
    task = ctx.get("task") if isinstance(ctx.get("task"), dict) else {}
    target = str(task.get("target") or snapshot.get("target") or "")
    scope_raw = task.get("scope")
    if isinstance(scope_raw, dict):
        allow = scope_raw.get("allow") if isinstance(scope_raw.get("allow"), list) else []
        deny = scope_raw.get("deny") if isinstance(scope_raw.get("deny"), list) else []
        parts = []
        if allow:
            parts.append("allow=" + ", ".join(map(str, allow)))
        if deny:
            parts.append("deny=" + ", ".join(map(str, deny)))
        scope = "; ".join(parts) if parts else str(target or "")
    else:
        scope = str(scope_raw or target or "")

    return {
        "title": conversation.title or "Security Assessment Report",
        "target": target,
        "scope": scope,
        "engagement": str(task.get("engagement") or task.get("role") or "pentest"),
        "conversation_id": str(conversation.id),
        "findings": findings,
        "evidence_by_id": evidence_by_id,
    }


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-._")
    return cleaned[:120] or "detection-report"


# --- Multi-report revisions (primary product path) ---


@router.get("/conversations/{conv_id}/revisions")
async def list_conversation_report_revisions(
    conv_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List delivery report revisions for a Case/Session (newest first)."""
    user_id = uuid.UUID(current_user["user_id"])
    conversation = await _get_owned_conversation(db, conv_id, user_id)
    rows = await list_reports(db, conversation_id=conversation.id, user_id=user_id)
    return {
        "ok": True,
        "conversation_id": str(conversation.id),
        "reports": [report_to_dict(r) for r in rows],
        "count": len(rows),
    }


@router.post("/conversations/{conv_id}/revisions")
async def create_conversation_report_revision(
    conv_id: str,
    body: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a report revision.

    - source=agent (default): body must include agent-authored markdown.
    - source=ledger: synthesize from booked findings only (quick draft).
    """
    user_id = uuid.UUID(current_user["user_id"])
    conversation = await _get_owned_conversation(db, conv_id, user_id)
    body = body if isinstance(body, dict) else {}
    source = str(body.get("source") or "agent").strip().lower() or "agent"

    if source == "ledger":
        ctx = await _load_delivery_context(db, conversation=conversation, user_id=user_id)
        title = str(body.get("title") or ctx["title"] or "Security Assessment Report").strip()
        markdown = build_engagement_report_markdown(
            title=title,
            target=ctx["target"],
            scope=ctx["scope"],
            engagement=ctx["engagement"],
            conversation_id=ctx["conversation_id"],
            findings=ctx["findings"],
            evidence_by_id=ctx["evidence_by_id"],
        )
        finding_ids = [str(f.get("id")) for f in ctx["findings"] if f.get("id")]
        summary = f"Ledger snapshot · {len(finding_ids)} confirmed finding(s)"
        try:
            row = await create_report(
                db,
                conversation_id=conversation.id,
                user_id=user_id,
                title=title,
                markdown=markdown,
                summary=summary,
                source="ledger",
                created_by=str(body.get("created_by") or "ui-ledger"),
                finding_ids=finding_ids,
                meta={"kind": "ledger_snapshot"},
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        return {"ok": True, "report": report_to_dict(row, include_markdown=False)}

    title = str(body.get("title") or "").strip() or "Security Assessment Report"
    markdown = str(body.get("markdown") or body.get("body") or "").strip()
    summary = str(body.get("summary") or "").strip() or None
    finding_ids_raw = body.get("finding_ids") or body.get("vulnerability_ids") or []
    finding_ids = [str(x) for x in finding_ids_raw if x] if isinstance(finding_ids_raw, list) else []
    try:
        row = await create_report(
            db,
            conversation_id=conversation.id,
            user_id=user_id,
            title=title,
            markdown=markdown,
            summary=summary,
            source="agent" if source == "agent" else source[:32],
            created_by=str(body.get("created_by") or current_user.get("email") or "user")[:255],
            finding_ids=finding_ids,
            meta=body.get("meta") if isinstance(body.get("meta"), dict) else {},
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "report": report_to_dict(row, include_markdown=False)}


@router.get("/conversations/{conv_id}/revisions/{report_id}")
async def get_conversation_report_revision(
    conv_id: str,
    report_id: str,
    format: str = Query("json", pattern="^(json|markdown|md|html|htm)$"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Fetch one report revision as JSON metadata or download body."""
    user_id = uuid.UUID(current_user["user_id"])
    conversation = await _get_owned_conversation(db, conv_id, user_id)
    try:
        rid = uuid.UUID(report_id)
    except ValueError as e:
        raise HTTPException(400, "invalid report id") from e
    row = await get_report(db, report_id=rid, user_id=user_id, conversation_id=conversation.id)
    if not row:
        raise HTTPException(404, "Report not found")

    fmt = (format or "json").lower()
    if fmt == "json":
        return {"ok": True, "report": report_to_dict(row, include_markdown=True)}

    body, media, filename = render_report_download(row, fmt)
    # Encode as UTF-8 bytes so Chinese markdown/html never trips latin-1 defaults.
    payload = body if isinstance(body, (bytes, bytearray)) else str(body).encode("utf-8")
    return Response(
        content=payload,
        media_type=media,
        headers={"Content-Disposition": content_disposition_attachment(filename)},
    )


@router.delete("/conversations/{conv_id}/revisions/{report_id}")
async def delete_conversation_report_revision(
    conv_id: str,
    report_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete one delivery report revision owned by the current user."""
    user_id = uuid.UUID(current_user["user_id"])
    conversation = await _get_owned_conversation(db, conv_id, user_id)
    try:
        rid = uuid.UUID(report_id)
    except ValueError as e:
        raise HTTPException(400, "invalid report id") from e
    removed = await delete_report(
        db, report_id=rid, user_id=user_id, conversation_id=conversation.id
    )
    if not removed:
        raise HTTPException(404, "Report not found")
    return {"ok": True, "deleted": str(rid)}


# --- Live snapshot (one-shot, does not persist unless client POSTs source=ledger) ---


@router.get("/conversations/{conv_id}/findings")
@router.get("/conversations/{conv_id}")
async def export_live_findings_snapshot(
    conv_id: str,
    format: str = Query("markdown", pattern="^(markdown|md|html|htm)$"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """One-shot live ledger snapshot export (not stored as a revision)."""
    user_id = uuid.UUID(current_user["user_id"])
    conversation = await _get_owned_conversation(db, conv_id, user_id)
    ctx = await _load_delivery_context(db, conversation=conversation, user_id=user_id)
    basename = _safe_filename(f"{conversation.title or 'detection-report'}-{str(conversation.id)[:8]}-live")
    fmt = (format or "markdown").lower().strip()
    if fmt in ("html", "htm"):
        body = build_engagement_report_html(
            title=ctx["title"],
            target=ctx["target"],
            scope=ctx["scope"],
            engagement=ctx["engagement"],
            conversation_id=ctx["conversation_id"],
            findings=ctx["findings"],
            evidence_by_id=ctx["evidence_by_id"],
        )
        return Response(
            content=body,
            media_type="text/html; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{basename}.html"'},
        )
    markdown = build_engagement_report_markdown(
        title=ctx["title"],
        target=ctx["target"],
        scope=ctx["scope"],
        engagement=ctx["engagement"],
        conversation_id=ctx["conversation_id"],
        findings=ctx["findings"],
        evidence_by_id=ctx["evidence_by_id"],
    )
    return Response(
        content=markdown,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{basename}.md"'},
    )
