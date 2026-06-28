"""漏洞 API"""
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.vulnerability import Vulnerability

router = APIRouter(prefix="/api/vulnerabilities", tags=["vulnerabilities"])


class VulnOut(BaseModel):
    id: str; title: str; severity: str; cvss: float | None; cve_id: str | None
    asset_id: str; confidence: str; status: str
    description: str | None; poc: str | None; remediation: str | None
    discovered_at: str | None; updated_at: str | None
    model_config = {"from_attributes": True}


@router.get("", response_model=list[VulnOut])
async def list_vulns(severity: str | None = Query(None), status: str | None = Query(None),
                      limit: int = 50, offset: int = 0,
                      current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    q = select(Vulnerability)
    if severity: q = q.where(Vulnerability.severity == severity)
    if status: q = q.where(Vulnerability.status == status)
    q = q.offset(offset).limit(limit).order_by(Vulnerability.discovered_at.desc())
    result = await db.execute(q)
    return [_out(v) for v in result.scalars().all()]


@router.get("/{vuln_id}", response_model=VulnOut)
async def get_vuln(vuln_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    v = await _get(vuln_id, db)
    return _out(v)


@router.patch("/{vuln_id}")
async def update_vuln(vuln_id: str, body: dict, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    v = await _get(vuln_id, db)
    allowed = ("status", "severity", "remediation", "description", "confidence")
    for k in allowed:
        if k in body: setattr(v, k, body[k])
    await db.commit()
    return {"ok": True}


async def _get(vuln_id: str, db: AsyncSession) -> Vulnerability:
    result = await db.execute(select(Vulnerability).where(Vulnerability.id == uuid.UUID(vuln_id)))
    v = result.scalar_one_or_none()
    if not v: raise HTTPException(404, "Vulnerability not found")
    return v


def _out(v: Vulnerability) -> VulnOut:
    return VulnOut(id=str(v.id), title=v.title, severity=v.severity, cvss=v.cvss, cve_id=v.cve_id,
                   asset_id=str(v.asset_id), confidence=v.confidence, status=v.status,
                   description=v.description, poc=v.poc, remediation=v.remediation,
                   discovered_at=v.discovered_at.isoformat() if v.discovered_at else None,
                   updated_at=v.updated_at.isoformat() if v.updated_at else None)
