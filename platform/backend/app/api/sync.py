"""Import standalone report packages into platform read models."""
from __future__ import annotations

import json
import tarfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import PurePosixPath
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.audit import AuditLog
from app.models.conversation import Conversation
from app.models.evidence import Evidence
from app.models.message import Message
from app.models.vulnerability import Vulnerability

router = APIRouter(prefix="/api/sync", tags=["sync"])

FORMAT_VERSION = "mvp-demo-v1"


@dataclass
class ReportPackage:
    manifest: dict[str, Any]
    messages: list[dict[str, Any]]
    assets: list[dict[str, Any]]
    vulnerabilities: list[dict[str, Any]]
    evidence: list[dict[str, Any]]
    attack_surface: list[dict[str, Any]]
    coverage: list[dict[str, Any]]
    checkpoint: dict[str, Any]
    evidence_files: list[str]


@router.post("/import")
async def import_report(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Import a standalone Node report.tar.gz package."""
    package = load_report_package(await file.read())
    user_id = uuid.UUID(current_user["user_id"])
    conv = Conversation(
        id=uuid.uuid4(),
        user_id=user_id,
        title=_conversation_title(package.manifest),
        status=_conversation_status(str(package.manifest.get("status") or "completed")),
        context={
            "imported_from": "standalone_report",
            "import_manifest": package.manifest,
            "checkpoint": package.checkpoint,
            "attack_surface": package.attack_surface,
            "coverage": package.coverage,
            "evidence_files": package.evidence_files,
        },
    )
    db.add(conv)
    await db.flush()

    messages_imported = _add_messages(db, conv.id, package.messages)
    asset_map, assets_imported = await _add_assets(db, user_id, conv.id, package.assets)
    evidence_imported = await _add_evidence(db, user_id, conv.id, package.evidence, package.evidence_files)
    vulns_imported = await _add_vulnerabilities(db, user_id, conv.id, package.vulnerabilities, asset_map)

    stats = {
        "messages_imported": messages_imported,
        "assets_imported": assets_imported,
        "vulns_imported": vulns_imported,
        "evidence_imported": evidence_imported,
        "attack_surface_imported": len(package.attack_surface),
        "coverage_imported": len(package.coverage),
        "warnings": [],
    }
    conv.context = {**(conv.context or {}), "import_stats": stats}
    db.add(AuditLog(
        actor_type="user",
        actor_id=user_id,
        action="sync.import_report",
        resource_type="conversation",
        resource_id=conv.id,
        conversation_id=conv.id,
        detail={"manifest": package.manifest, "stats": stats},
        status="success",
    ))
    await db.commit()
    return {"conversation_id": str(conv.id), **stats}


def load_report_package(raw: bytes) -> ReportPackage:
    try:
        with tarfile.open(fileobj=BytesIO(raw), mode="r:gz") as tar:
            members = {member.name: member for member in tar.getmembers() if member.isfile()}
            for name in members:
                _validate_member_name(name)
            manifest = _read_json(tar, members, "manifest.json")
            if manifest.get("format_version") != FORMAT_VERSION:
                raise HTTPException(400, f"Unsupported report format: {manifest.get('format_version')}")
            return ReportPackage(
                manifest=manifest,
                messages=_read_jsonl(tar, members, "conversation.jsonl"),
                assets=_read_json(tar, members, "assets.json"),
                vulnerabilities=_read_json(tar, members, "vulnerabilities.json"),
                evidence=_read_json(tar, members, "evidence.json"),
                attack_surface=_read_json(tar, members, "attack_surface.json"),
                coverage=_read_json(tar, members, "coverage.json"),
                checkpoint=_read_json(tar, members, "checkpoints/latest.json"),
                evidence_files=sorted(name for name in members if name.startswith("evidence/")),
            )
    except HTTPException:
        raise
    except (tarfile.TarError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(400, f"Invalid report package: {exc}") from exc


def _validate_member_name(name: str) -> None:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise HTTPException(400, f"Unsafe report member path: {name}")


def _read_json(tar: tarfile.TarFile, members: dict[str, tarfile.TarInfo], name: str, *, default: Any | None = None) -> Any:
    member = members.get(name)
    if not member:
        if default is not None:
            return default
        raise HTTPException(400, f"Missing report member: {name}")
    extracted = tar.extractfile(member)
    if extracted is None:
        raise HTTPException(400, f"Unreadable report member: {name}")
    return json.loads(extracted.read().decode("utf-8"))


def _read_jsonl(tar: tarfile.TarFile, members: dict[str, tarfile.TarInfo], name: str) -> list[dict[str, Any]]:
    member = members.get(name)
    if not member:
        raise HTTPException(400, f"Missing report member: {name}")
    extracted = tar.extractfile(member)
    if extracted is None:
        raise HTTPException(400, f"Unreadable report member: {name}")
    rows = []
    for line in extracted.read().decode("utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def _add_messages(db: AsyncSession, conversation_id: uuid.UUID, messages: list[dict[str, Any]]) -> int:
    for message in messages:
        content = dict(message.get("content") or {})
        content.setdefault("source_message_id", message.get("id"))
        content.setdefault("source_session_id", message.get("session_id"))
        kwargs = {
            "id": uuid.uuid4(),
            "conversation_id": conversation_id,
            "role": str(message.get("role") or "agent"),
            "msg_type": str(message.get("msg_type") or "text"),
            "content": content,
        }
        created_at = _timestamp(message.get("created_at"))
        if created_at:
            kwargs["created_at"] = created_at
        db.add(Message(**kwargs))
    return len(messages)


async def _add_assets(db: AsyncSession, user_id: uuid.UUID, conversation_id: uuid.UUID, assets: list[dict[str, Any]]) -> tuple[dict[str, uuid.UUID], int]:
    asset_map: dict[str, uuid.UUID] = {}
    imported = 0
    for item in assets:
        address = str(item.get("address") or item.get("affected_asset") or item.get("target") or "unknown")
        asset_id = uuid.uuid4()
        asset_map[address] = asset_id
        if item.get("id"):
            asset_map[str(item.get("id"))] = asset_id
        db.add(Asset(
            id=asset_id,
            user_id=user_id,
            conversation_id=conversation_id,
            name=str(item.get("name") or address),
            address=address,
            type=str(item.get("asset_type") or item.get("type") or "host"),
            source="standalone_import",
            properties={**item, "source": "standalone_import"},
        ))
        imported += 1
    return asset_map, imported


async def _add_evidence(db: AsyncSession, user_id: uuid.UUID, conversation_id: uuid.UUID, evidence: list[dict[str, Any]], evidence_files: list[str]) -> int:
    imported = 0
    available_files = set(evidence_files)
    for item in evidence:
        evidence_id = str(item.get("evidence_id") or item.get("id") or "")
        if not evidence_id:
            continue
        existing = (await db.execute(select(Evidence).where(Evidence.evidence_id == evidence_id))).scalar_one_or_none()
        if existing:
            continue
        raw_ref = str(item.get("raw_ref") or "")
        db.add(Evidence(
            id=uuid.uuid4(),
            evidence_id=evidence_id,
            user_id=user_id,
            conversation_id=conversation_id,
            type=str(item.get("evidence_type") or item.get("type") or "unknown"),
            source_tool=item.get("source_tool"),
            tool_run_id=item.get("tool_run_id") or item.get("related_tool_run_id"),
            raw_ref=raw_ref,
            summary=item.get("summary"),
            hash=item.get("hash"),
            properties={**item, "source": "standalone_import", "files": sorted(path for path in available_files if evidence_id in path)},
        ))
        imported += 1
    return imported


async def _add_vulnerabilities(db: AsyncSession, user_id: uuid.UUID, conversation_id: uuid.UUID, vulnerabilities: list[dict[str, Any]], asset_map: dict[str, uuid.UUID]) -> int:
    imported = 0
    for item in vulnerabilities:
        if str(item.get("status") or "confirmed") not in {"confirmed", "done", "verified"}:
            continue
        affected = str(item.get("affected_asset") or item.get("asset") or item.get("target") or "")
        asset_id = asset_map.get(str(item.get("asset_id") or "")) or asset_map.get(affected)
        evidence_ids = item.get("evidence_ids") if isinstance(item.get("evidence_ids"), list) else []
        db.add(Vulnerability(
            id=uuid.uuid4(),
            user_id=user_id,
            title=str(item.get("title") or "Untitled vulnerability"),
            severity=str(item.get("severity") or "info"),
            cvss=item.get("cvss"),
            cve_id=item.get("cve_id"),
            asset_id=asset_id,
            conversation_id=conversation_id,
            description=str(item.get("description") or item.get("summary") or item.get("impact") or ""),
            poc=str(item.get("poc") or item.get("reproduction") or item.get("location") or ""),
            remediation=str(item.get("remediation") or item.get("recommendation") or ""),
            confidence=str(item.get("confidence") or "medium"),
            status="confirmed",
            evidence_ids=[str(eid) for eid in evidence_ids],
        ))
        imported += 1
    return imported


def _conversation_title(manifest: dict[str, Any]) -> str:
    target = manifest.get("target") if isinstance(manifest.get("target"), dict) else {}
    target_value = target.get("value") or manifest.get("session_id") or "standalone report"
    return f"Standalone Import: {target_value}"


def _conversation_status(status: str) -> str:
    normalized = status.lower()
    if normalized in {"completed", "complete"}:
        return "completed"
    if normalized in {"failed", "blocked", "canceled"}:
        return normalized
    return "created"


def _timestamp(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if isinstance(value, str):
        try:
            if value.endswith("Z"):
                value = value[:-1] + "+00:00"
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None
