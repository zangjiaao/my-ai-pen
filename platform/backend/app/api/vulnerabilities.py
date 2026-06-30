"""Vulnerability API."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.audit import AuditLog
from app.models.evidence import Evidence
from app.models.vulnerability import Vulnerability

router = APIRouter(prefix="/api/vulnerabilities", tags=["vulnerabilities"])

STATUSES = {"pending", "confirmed", "reported", "fixed", "accepted", "false_positive"}
TRANSITIONS = {
    "pending": {"confirmed", "accepted", "false_positive"},
    "confirmed": {"reported", "fixed", "accepted", "false_positive", "pending"},
    "reported": {"fixed", "accepted", "confirmed"},
    "fixed": {"confirmed", "reported"},
    "accepted": {"confirmed", "fixed"},
    "false_positive": {"pending", "confirmed"},
}


class AssetSummaryOut(BaseModel):
    id: str
    name: str
    address: str
    type: str


class EvidenceOut(BaseModel):
    id: str
    evidence_id: str
    type: str
    source_tool: str | None = None
    tool_run_id: str | None = None
    raw_ref: str | None = None
    summary: str | None = None
    hash: str | None = None
    created_at: str | None = None


class VulnOut(BaseModel):
    id: str
    user_id: str | None = None
    conversation_id: str | None = None
    node_id: str | None = None
    title: str
    severity: str
    cvss: float | None
    cve_id: str | None
    asset_id: str | None
    asset: AssetSummaryOut | None = None
    confidence: str
    status: str
    description: str | None
    poc: str | None
    remediation: str | None
    evidence_ids: list[str] = Field(default_factory=list)
    evidence: list[EvidenceOut] = Field(default_factory=list)
    discovered_at: str | None
    updated_at: str | None
    model_config = {"from_attributes": True}


@router.get("", response_model=list[VulnOut])
async def list_vulns(
    severity: str | None = Query(None),
    status: str | None = Query(None),
    limit: int = 50,
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    q = select(Vulnerability).where(Vulnerability.user_id == user_id)
    if severity:
        q = q.where(Vulnerability.severity == severity)
    if status:
        q = q.where(Vulnerability.status == status)
    q = q.order_by(Vulnerability.discovered_at.desc()).offset(offset).limit(limit)
    result = await db.execute(q)
    vulns = result.scalars().all()
    assets = await _assets_by_id(db, user_id, [v.asset_id for v in vulns if v.asset_id])
    return [_out(v, asset=assets.get(v.asset_id)) for v in vulns]


@router.get("/{vuln_id}", response_model=VulnOut)
async def get_vuln(
    vuln_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    v = await _get(vuln_id, current_user, db)
    asset = None
    if v.asset_id:
        assets = await _assets_by_id(db, user_id, [v.asset_id])
        asset = assets.get(v.asset_id)
    evidence = await _evidence_for(db, user_id, v.evidence_ids or [])
    return _out(v, asset=asset, evidence=evidence)


@router.patch("/{vuln_id}", response_model=VulnOut)
async def update_vuln(
    vuln_id: str,
    body: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    v = await _get(vuln_id, current_user, db)
    before_status = v.status
    if "status" in body:
        next_status = str(body["status"])
        if next_status not in STATUSES:
            raise HTTPException(400, f"Unsupported vulnerability status: {next_status}")
        if next_status != v.status and next_status not in TRANSITIONS.get(v.status, set()):
            raise HTTPException(400, f"Invalid vulnerability status transition: {v.status} -> {next_status}")
        v.status = next_status
    for k in ("severity", "remediation", "description", "confidence"):
        if k in body:
            setattr(v, k, body[k])
    await _audit(db, user_id, "vulnerability.update", "vulnerability", v.id, v.conversation_id, {
        "fields": sorted(body.keys()),
        "before_status": before_status,
        "after_status": v.status,
    })
    await db.commit()
    await db.refresh(v)
    asset = None
    if v.asset_id:
        assets = await _assets_by_id(db, user_id, [v.asset_id])
        asset = assets.get(v.asset_id)
    evidence = await _evidence_for(db, user_id, v.evidence_ids or [])
    return _out(v, asset=asset, evidence=evidence)


async def _get(vuln_id: str, current_user: dict, db: AsyncSession) -> Vulnerability:
    result = await db.execute(
        select(Vulnerability).where(
            Vulnerability.id == uuid.UUID(vuln_id),
            Vulnerability.user_id == uuid.UUID(current_user["user_id"]),
        )
    )
    v = result.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Vulnerability not found")
    return v


async def _assets_by_id(db: AsyncSession, user_id: uuid.UUID, asset_ids: list[uuid.UUID]) -> dict[uuid.UUID, Asset]:
    if not asset_ids:
        return {}
    result = await db.execute(select(Asset).where(Asset.user_id == user_id, Asset.id.in_(asset_ids)))
    return {a.id: a for a in result.scalars().all()}


async def _evidence_for(db: AsyncSession, user_id: uuid.UUID, evidence_ids: list[str]) -> list[Evidence]:
    if not evidence_ids:
        return []
    result = await db.execute(
        select(Evidence).where(
            Evidence.user_id == user_id,
            Evidence.evidence_id.in_(evidence_ids),
        ).order_by(Evidence.created_at.desc())
    )
    return result.scalars().all()


async def _audit(db: AsyncSession, user_id: uuid.UUID, action: str, resource_type: str, resource_id: uuid.UUID, conversation_id: uuid.UUID | None, detail: dict) -> None:
    db.add(AuditLog(
        actor_type="user",
        actor_id=user_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        conversation_id=conversation_id,
        detail=detail,
        status="success",
    ))


def _asset_out(a: Asset | None) -> AssetSummaryOut | None:
    if not a:
        return None
    return AssetSummaryOut(id=str(a.id), name=a.name, address=a.address, type=a.type)


def _evidence_out(e: Evidence) -> EvidenceOut:
    return EvidenceOut(
        id=str(e.id),
        evidence_id=e.evidence_id,
        type=e.type,
        source_tool=e.source_tool,
        tool_run_id=e.tool_run_id,
        raw_ref=e.raw_ref,
        summary=e.summary,
        hash=e.hash,
        created_at=e.created_at.isoformat() if e.created_at else None,
    )


def _out(v: Vulnerability, *, asset: Asset | None = None, evidence: list[Evidence] | None = None) -> VulnOut:
    return VulnOut(
        id=str(v.id),
        user_id=str(v.user_id) if v.user_id else None,
        conversation_id=str(v.conversation_id) if v.conversation_id else None,
        node_id=str(v.node_id) if v.node_id else None,
        title=v.title,
        severity=v.severity,
        cvss=v.cvss,
        cve_id=v.cve_id,
        asset_id=str(v.asset_id) if v.asset_id else None,
        asset=_asset_out(asset),
        confidence=v.confidence,
        status=v.status,
        description=v.description,
        poc=v.poc,
        remediation=v.remediation,
        evidence_ids=v.evidence_ids or [],
        evidence=[_evidence_out(e) for e in (evidence or [])],
        discovered_at=v.discovered_at.isoformat() if v.discovered_at else None,
        updated_at=v.updated_at.isoformat() if v.updated_at else None,
    )
