"""Conversation snapshot assembly.

This module is the backend source of truth for restoring a conversation view.
It deliberately combines the durable message log, read models, and checkpoint
state so refreshes and page switches do not depend on whichever message page
the frontend has loaded.
"""
from __future__ import annotations

import re
import uuid

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.conversation import Conversation
from app.models.evidence import Evidence
from app.models.message import Message
from app.models.vulnerability import Vulnerability


PHASES = ["precheck", "plan", "recon", "scan", "verify", "report"]
PHASE_LABELS = {
    "precheck": "目标与授权范围检查",
    "plan": "生成测试计划",
    "recon": "资产与服务探测",
    "scan": "漏洞扫描与候选发现",
    "verify": "复现验证与授权确认",
    "report": "同步结果与整理证据",
}


def conversation_summary(c: Conversation) -> dict:
    return {
        "id": str(c.id),
        "title": c.title,
        "node_id": str(c.node_id) if c.node_id else None,
        "status": c.status,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "last_active_at": c.last_active_at.isoformat() if c.last_active_at else None,
    }


async def get_message_page(db: AsyncSession, conversation_id: uuid.UUID, *, limit: int, offset: int, order: str) -> list[dict]:
    sort_columns = (Message.created_at.desc(), Message.id.desc()) if order == "desc" else (Message.created_at, Message.id)
    result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(*sort_columns)
        .offset(offset)
        .limit(limit)
    )
    messages = result.scalars().all()
    if order == "desc":
        messages = list(reversed(messages))
    return [message_summary(m) for m in messages]


async def build_conversation_snapshot(db: AsyncSession, conversation: Conversation, user_id: uuid.UUID) -> dict:
    messages = (await db.execute(
        select(Message).where(Message.conversation_id == conversation.id).order_by(Message.created_at, Message.id)
    )).scalars().all()
    read_model_errors = []

    try:
        assets = (await db.execute(
            select(Asset)
            .where(Asset.user_id == user_id, Asset.conversation_id == conversation.id)
            .order_by(Asset.updated_at.desc())
        )).scalars().all()
    except SQLAlchemyError as exc:
        assets = []
        read_model_errors.append({"model": "assets", "error": str(exc)})
        await db.rollback()

    try:
        vulns = (await db.execute(
            select(Vulnerability)
            .where(Vulnerability.user_id == user_id, Vulnerability.conversation_id == conversation.id)
            .order_by(Vulnerability.discovered_at.desc())
        )).scalars().all()
    except SQLAlchemyError as exc:
        vulns = []
        read_model_errors.append({"model": "vulnerabilities", "error": str(exc)})
        await db.rollback()

    try:
        evidence = (await db.execute(
            select(Evidence)
            .where(Evidence.user_id == user_id, Evidence.conversation_id == conversation.id)
            .order_by(Evidence.created_at.desc())
        )).scalars().all()
    except SQLAlchemyError as exc:
        evidence = []
        read_model_errors.append({"model": "evidence", "error": str(exc)})
        await db.rollback()

    pending = pending_approvals_from_messages(messages)
    checkpoint = ((conversation.context or {}).get("checkpoint") if isinstance(conversation.context, dict) else {}) or {}
    agent_state = agent_state_from_checkpoint(checkpoint, conversation.status) if checkpoint else agent_state_from_messages(messages, evidence, conversation.status)
    todos = todos_for_checkpoint(checkpoint, conversation.status) if checkpoint else todos_for_phase(agent_state.get("phase"), conversation.status)
    progress = progress_for_checkpoint(checkpoint, conversation.status) if checkpoint else progress_for_phase(agent_state.get("phase"), conversation.status)
    findings = merge_many_by_key([
        [vuln_summary(v) for v in vulns],
        message_findings(messages),
        checkpoint_findings(checkpoint),
    ], "title")
    asset_items = merge_many_by_key([
        [asset_summary(a) for a in assets],
        message_assets(messages),
        checkpoint_assets(checkpoint),
    ], "address")
    explicit_evidence = message_evidence(messages, include_tool_calls=False)
    fallback_tool_evidence = [] if evidence or explicit_evidence else message_evidence(messages, include_tool_calls=True)
    evidence_items = merge_many_by_key([
        [evidence_summary(e) for e in evidence],
        explicit_evidence,
        fallback_tool_evidence,
    ], "evidence_id")

    return {
        "conversation": conversation_summary(conversation),
        "agent_state": agent_state,
        "progress": progress,
        "todos": todos,
        "findings": findings,
        "assets": asset_items,
        "checkpoint": checkpoint or {},
        "pending_approvals": pending,
        "evidence": evidence_items,
        "read_model_errors": read_model_errors,
        "counts": {
            "assets": len(asset_items),
            "findings": len(findings),
            "pending": len(pending),
            "evidence": len(evidence_items),
        },
    }


def message_summary(m: Message) -> dict:
    return {
        "id": str(m.id),
        "conversation_id": str(m.conversation_id),
        "role": m.role,
        "msg_type": m.msg_type,
        "content": m.content,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def pending_approvals_from_messages(messages: list[Message]) -> list[dict]:
    decisions = {
        str(m.content.get("request_id"))
        for m in messages
        if m.msg_type == "decision" and isinstance(m.content, dict) and m.content.get("request_id")
    }
    pending = []
    seen_pending = set()
    for m in messages:
        if m.msg_type != "confirm_card" or not isinstance(m.content, dict):
            continue
        request_id = m.content.get("request_id")
        if not request_id or str(request_id) in decisions or str(request_id) in seen_pending:
            continue
        seen_pending.add(str(request_id))
        pending.append({**m.content, "message_id": str(m.id)})
    return pending


def checkpoint_completed(checkpoint: dict) -> set[str]:
    if not isinstance(checkpoint, dict):
        return set()
    state = checkpoint.get("state") if isinstance(checkpoint.get("state"), dict) else {}
    completed = state.get("phases_completed") or checkpoint.get("phases_completed") or []
    return {str(item) for item in completed if str(item) in PHASES}


def checkpoint_phase(checkpoint: dict, status: str) -> str | None:
    if not isinstance(checkpoint, dict):
        return "report" if status == "completed" else None
    state = checkpoint.get("state") if isinstance(checkpoint.get("state"), dict) else {}
    phase = state.get("phase") or checkpoint.get("phase")
    completed = checkpoint_completed(checkpoint)
    if status == "completed":
        return "report"
    if phase in PHASES and phase in completed and status == "running":
        next_index = PHASES.index(phase) + 1
        while next_index < len(PHASES) and PHASES[next_index] in completed:
            next_index += 1
        return PHASES[next_index] if next_index < len(PHASES) else phase
    return phase if phase in PHASES else None


def agent_state_from_checkpoint(checkpoint: dict, status: str = "running") -> dict:
    if not isinstance(checkpoint, dict):
        checkpoint = {}
    state = checkpoint.get("state") if isinstance(checkpoint.get("state"), dict) else {}
    phase = checkpoint_phase(checkpoint, status)
    recent_tools = state.get("recent_tool_runs") if isinstance(state.get("recent_tool_runs"), list) else []
    active_tool = None
    if recent_tools:
        last_tool = recent_tools[-1]
        if isinstance(last_tool, dict):
            active_tool = last_tool.get("tool_name")
    return {
        "phase": phase,
        "iteration": state.get("iteration", checkpoint.get("iteration")),
        "phaseIteration": state.get("phase_iteration", checkpoint.get("phase_iteration")),
        "activeTool": active_tool,
        "intakeResult": checkpoint.get("intake_result"),
        "intakeStatus": checkpoint.get("intake_status"),
        "checkpointReason": checkpoint.get("reason"),
    }


def agent_state_from_messages(messages: list[Message], evidence: list[Evidence], status: str) -> dict:
    phase = None
    iteration = None
    active_tool = None
    intake_result = None
    intake_status = None
    for m in reversed(messages):
        if m.msg_type == "status" and isinstance(m.content, dict):
            phase = m.content.get("phase") or parse_phase(str(m.content.get("text", "")))
            iteration = m.content.get("iteration")
            active_tool = m.content.get("active_tool")
            intake_result = m.content.get("intake_result")
            intake_status = m.content.get("status")
            break
    if not active_tool:
        for m in reversed(messages):
            if m.msg_type == "tool_call" and isinstance(m.content, dict) and m.content.get("tool_name"):
                active_tool = m.content.get("tool_name")
                break
    if not active_tool and evidence:
        active_tool = evidence[0].source_tool or evidence[0].type
    if not phase:
        phase = "report" if status == "completed" else "precheck" if status == "running" else None
    return {"phase": phase, "iteration": iteration, "activeTool": active_tool, "intakeResult": intake_result, "intakeStatus": intake_status}


def parse_phase(text: str) -> str | None:
    match = re.search(r"Phase:\s*([^\s(]+)", text)
    return match.group(1) if match else None


def progress_for_phase(phase: str | None, status: str) -> dict:
    total = len(PHASES)
    if status == "completed":
        current = total
    elif phase in PHASES:
        current = PHASES.index(phase) + 1
    elif status == "running":
        current = 1
    else:
        current = 0
    return {"current": current, "total": total, "percent": round((current / total) * 100) if total else 0}


def todos_for_phase(phase: str | None, status: str) -> list[dict]:
    current_index = PHASES.index(phase) if phase in PHASES else (-1 if status != "running" else 0)
    return [
        {
            "id": key,
            "title": PHASE_LABELS[key],
            "status": "done" if status == "completed" or index < current_index else "running" if index == current_index else "pending",
        }
        for index, key in enumerate(PHASES)
    ]


def progress_for_checkpoint(checkpoint: dict, status: str) -> dict:
    total = len(PHASES)
    phase = checkpoint_phase(checkpoint, status)
    completed = checkpoint_completed(checkpoint)
    if status == "completed":
        current = total
    elif completed:
        current = min(total, max(PHASES.index(item) + 1 for item in completed))
        if phase in PHASES and phase not in completed:
            current = max(current, PHASES.index(phase) + 1)
    elif phase in PHASES:
        current = PHASES.index(phase) + 1
    elif status == "running":
        current = 1
    else:
        current = 0
    current = max(0, min(total, current))
    return {"current": current, "total": total, "percent": round((current / total) * 100) if total else 0}


def todos_for_checkpoint(checkpoint: dict, status: str) -> list[dict]:
    phase = checkpoint_phase(checkpoint, status)
    completed = checkpoint_completed(checkpoint)
    current_index = PHASES.index(phase) if phase in PHASES else (-1 if status != "running" else 0)
    todos = []
    for index, key in enumerate(PHASES):
        if status == "completed" or key in completed or index < current_index:
            item_status = "done"
        elif index == current_index:
            item_status = "running"
        else:
            item_status = "pending"
        todos.append({"id": key, "title": PHASE_LABELS[key], "status": item_status})
    return todos


def checkpoint_findings(checkpoint: dict) -> list[dict]:
    if not isinstance(checkpoint, dict):
        return []
    items = []
    for source in ("candidate_findings", "confirmed_findings"):
        for item in checkpoint.get(source) or []:
            if not isinstance(item, dict):
                continue
            items.append({
                "id": str(item.get("id") or item.get("finding_id") or item.get("title") or ""),
                "title": item.get("title") or "Untitled finding",
                "severity": item.get("severity") or "medium",
                "location": item.get("location") or item.get("affected_asset") or "",
                "confidence": item.get("confidence"),
                "status": item.get("status") or ("confirmed" if source == "confirmed_findings" else "candidate"),
                "evidence_ids": item.get("evidence_ids") or [],
            })
    return items


def checkpoint_assets(checkpoint: dict) -> list[dict]:
    if not isinstance(checkpoint, dict):
        return []
    assets = []
    for item in checkpoint.get("discovered_assets") or []:
        if not isinstance(item, dict):
            continue
        address = item.get("address") or item.get("hostname") or "unknown"
        assets.append({
            "id": str(address),
            "name": item.get("hostname") or address,
            "address": address,
            "type": item.get("asset_type") or "host",
            "properties": {"open_ports": item.get("open_ports", []), "services": item.get("services", [])},
        })
    return assets


def merge_many_by_key(groups: list[list[dict]], key: str) -> list[dict]:
    merged: list[dict] = []
    seen: set[str] = set()
    for group in groups:
        for item in group:
            marker = str(item.get(key) or item.get("id") or item.get("title") or item.get("address") or "")
            if marker and marker in seen:
                continue
            if marker:
                seen.add(marker)
            merged.append(item)
    return merged


def message_findings(messages: list[Message]) -> list[dict]:
    findings = []
    for m in messages:
        if m.msg_type not in {"vuln_found", "vuln_card"} or not isinstance(m.content, dict):
            continue
        content = m.content
        finding_id = content.get("id") or content.get("vulnerability_id") or content.get("finding_id") or str(m.id)
        findings.append({
            "id": str(finding_id),
            "vulnerability_id": str(content.get("vulnerability_id") or content.get("id") or ""),
            "title": content.get("title") or "Untitled finding",
            "severity": content.get("severity") or "medium",
            "location": content.get("location") or content.get("affected_asset") or content.get("poc") or "",
            "confidence": content.get("confidence"),
            "status": content.get("status") or "pending",
            "asset_id": str(content.get("asset_id")) if content.get("asset_id") else None,
            "evidence_ids": content.get("evidence_ids") or [],
        })
    return findings


def message_assets(messages: list[Message]) -> list[dict]:
    assets = []
    for m in messages:
        if m.msg_type not in {"asset_discovered", "asset_card"} or not isinstance(m.content, dict):
            continue
        content = m.content
        properties = content.get("properties") if isinstance(content.get("properties"), dict) else {}
        open_ports = content.get("open_ports") or properties.get("open_ports") or []
        services = content.get("services") or properties.get("services") or []
        address = content.get("address") or content.get("name") or "unknown"
        assets.append({
            "id": str(content.get("id") or content.get("asset_id") or address),
            "asset_id": str(content.get("asset_id") or content.get("id") or ""),
            "name": content.get("name") or content.get("hostname") or address,
            "address": address,
            "type": content.get("asset_type") or content.get("type") or "host",
            "properties": {**properties, "open_ports": open_ports, "services": services},
        })
    return assets


def message_evidence(messages: list[Message], *, include_tool_calls: bool = True) -> list[dict]:
    evidence = []
    for m in messages:
        if not isinstance(m.content, dict):
            continue
        content = m.content
        if m.msg_type == "evidence_created":
            evidence_id = content.get("evidence_id") or content.get("id") or str(m.id)
            evidence.append({
                "id": str(content.get("id") or m.id),
                "evidence_id": str(evidence_id),
                "conversation_id": str(content.get("conversation_id") or m.conversation_id),
                "node_id": str(content.get("node_id")) if content.get("node_id") else None,
                "type": content.get("evidence_type") or content.get("type") or "evidence_created",
                "source_tool": content.get("source_tool"),
                "tool_run_id": content.get("tool_run_id"),
                "raw_ref": content.get("raw_ref"),
                "summary": content.get("summary") or content.get("raw_ref") or "",
                "hash": content.get("hash"),
                "properties": content.get("properties") if isinstance(content.get("properties"), dict) else {},
                "created_at": m.created_at.isoformat() if m.created_at else None,
            })
        elif include_tool_calls and m.msg_type == "tool_call" and content.get("stdout"):
            evidence_id = content.get("tool_run_id") or str(m.id)
            evidence.append({
                "id": str(m.id),
                "evidence_id": str(evidence_id),
                "conversation_id": str(m.conversation_id),
                "node_id": None,
                "type": "tool_output",
                "source_tool": content.get("tool_name"),
                "tool_run_id": content.get("tool_run_id"),
                "raw_ref": None,
                "summary": str(content.get("stdout") or "")[:2000],
                "hash": None,
                "properties": {"status": content.get("status")},
                "created_at": m.created_at.isoformat() if m.created_at else None,
            })
    return evidence


def asset_summary(a: Asset) -> dict:
    return {"id": str(a.id), "name": a.name, "address": a.address, "type": a.type, "properties": a.properties or {}}


def vuln_summary(v: Vulnerability) -> dict:
    return {
        "id": str(v.id),
        "title": v.title,
        "severity": v.severity,
        "location": v.poc or "",
        "confidence": v.confidence,
        "status": v.status,
        "asset_id": str(v.asset_id) if v.asset_id else None,
        "evidence_ids": v.evidence_ids or [],
    }


def evidence_summary(e: Evidence) -> dict:
    return {
        "id": str(e.id),
        "evidence_id": e.evidence_id,
        "conversation_id": str(e.conversation_id) if e.conversation_id else None,
        "node_id": str(e.node_id) if e.node_id else None,
        "type": e.type,
        "source_tool": e.source_tool,
        "tool_run_id": e.tool_run_id,
        "raw_ref": e.raw_ref,
        "summary": e.summary,
        "hash": e.hash,
        "properties": e.properties or {},
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }
