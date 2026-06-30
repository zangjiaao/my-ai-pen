"""Vulnerability API."""
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.conversation import Conversation
from app.models.message import Message
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
    properties: dict = Field(default_factory=dict)
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


class RetestOut(BaseModel):
    conversation_id: str
    started: bool
    target: dict
    scope: dict
    instruction: str
    message: str


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


@router.post("/{vuln_id}/retest", response_model=RetestOut)
async def retest_vuln(
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

    target_value = _retest_target(v, asset)
    if not target_value:
        raise HTTPException(400, "Cannot retest vulnerability without an affected asset or target")

    target = {"type": "url" if str(target_value).startswith(("http://", "https://")) else "host", "value": target_value}
    scope = {"allow": [target_value], "deny": []}
    instruction = _retest_instruction(v, asset, target_value)
    context = {
        "task": {"target": target, "scope": scope, "instruction": instruction},
        "retest": {
            "source_vulnerability_id": str(v.id),
            "source_conversation_id": str(v.conversation_id),
            "asset_id": str(v.asset_id) if v.asset_id else None,
            "title": v.title,
            "severity": v.severity,
            "status_before_retest": v.status,
            "evidence_ids": v.evidence_ids or [],
        },
    }
    conv = Conversation(
        id=uuid.uuid4(),
        user_id=user_id,
        title=f"Retest: {v.title}"[:255],
        status="created",
        context=context,
    )
    db.add(conv)
    await db.flush()
    db.add(Message(
        id=uuid.uuid4(),
        conversation_id=conv.id,
        role="user",
        msg_type="text",
        content={"text": instruction, "retest": context["retest"]},
    ))
    await _audit(db, user_id, "vuln.retest", "vulnerability", v.id, conv.id, {
        "source_conversation_id": str(v.conversation_id),
        "target": target,
    })
    await db.commit()
    await db.refresh(conv)

    started = await _dispatch_retest_if_possible(str(conv.id), target, scope, instruction)
    return RetestOut(
        conversation_id=str(conv.id),
        started=started,
        target=target,
        scope=scope,
        instruction=instruction,
        message="Retest started" if started else "Retest conversation created; no online node was available",
    )


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


def _retest_target(v: Vulnerability, asset: Asset | None) -> str:
    if asset and asset.address:
        return asset.address
    poc = v.poc or ""
    for token in poc.split():
        if token.startswith(("http://", "https://")):
            return token.strip("'\"` ,")
    return ""


def _retest_instruction(v: Vulnerability, asset: Asset | None, target_value: str) -> str:
    asset_line = f"Asset: {asset.address} ({asset.type})" if asset else f"Target: {target_value}"
    evidence = ", ".join(v.evidence_ids or []) or "none"
    return (
        "Retest the previously reported vulnerability and determine whether it is still reproducible.\n"
        f"{asset_line}\n"
        f"Vulnerability: {v.title}\n"
        f"Severity: {v.severity}\n"
        f"Current status: {v.status}\n"
        f"Original reproduction/location: {v.poc or '-'}\n"
        f"Original evidence ids: {evidence}\n"
        f"Remediation guidance: {v.remediation or '-'}\n\n"
        "Focus on replaying or minimally revalidating this exact finding. Do not broaden into a full new assessment unless required to validate the fix. "
        "If it is still exploitable, produce fresh evidence and confirm the finding. If it is fixed or not reproducible, report that clearly with evidence."
    )


async def _dispatch_retest_if_possible(conv_id: str, target: dict, scope: dict, instruction: str) -> bool:
    try:
        from app.ws import router as ws_router

        node_ids = sorted(ws_router.node_connections.keys())
        if not node_ids:
            return False
        node_id = node_ids[0]
        task_msg = {
            "type": "task_assign",
            "conversation_id": conv_id,
            "task_id": str(uuid.uuid4()),
            "target": target,
            "scope": scope,
            "initial_instruction": instruction,
            "checkpoint": {},
        }
        await ws_router._bind_conversation_to_node(conv_id, node_id)
        await ws_router._incr_sessions(node_id, 1)
        await ws_router.node_connections[node_id].send_text(json.dumps(task_msg, ensure_ascii=False))
        return True
    except Exception as exc:
        print(f"[API] retest dispatch error: {exc}")
        return False


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
        properties=e.properties or {},
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
