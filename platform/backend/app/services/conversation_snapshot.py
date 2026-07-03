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


PHASES = ["intake", "recon", "analysis", "verify", "report", "complete"]
SNAPSHOT_MESSAGE_LIMIT = 120
SNAPSHOT_TEXT_LIMIT = 2000
SNAPSHOT_TOOL_STDOUT_LIMIT = 800
PHASE_LABELS = {
    "intake": "\u76ee\u6807\u4e0e\u6388\u6743\u8303\u56f4\u68c0\u67e5",
    "recon": "\u653b\u51fb\u9762\u53d1\u73b0",
    "analysis": "\u8986\u76d6\u5206\u6790\u4e0e\u6d4b\u8bd5\u8ba1\u5212",
    "verify": "\u9a8c\u8bc1\u4e0e\u8bc1\u636e\u786e\u8ba4",
    "report": "\u62a5\u544a\u6574\u7406",
    "complete": "\u4efb\u52a1\u5b8c\u6210",
}



def plan_node_level(kind: str) -> str:
    if kind == "phase":
        return "phase"
    if kind == "objective":
        return "objective"
    return "work_item"


def phase_node_id(phase: str) -> str:
    return f"plan-phase-{phase}"


def objective_node_id(phase: str, key: str) -> str:
    return f"plan-objective-{phase}-{key}"


def objective_title(phase: str, key: str) -> str:
    titles = {
        ("recon", "attack_surface"): "\u53d1\u73b0\u53ef\u6d4b\u8bd5\u653b\u51fb\u9762",
        ("recon", "traffic"): "\u6574\u7406\u9ad8\u4ef7\u503c\u8bf7\u6c42",
        ("analysis", "test_plan"): "\u5206\u6790\u653b\u51fb\u9762\u98ce\u9669",
    }
    return titles.get((phase, key), key.replace("_", " ").title())


def ensure_plan_tree_shape(items: list[dict], phase: str | None, completed: set[str], status: str) -> list[dict]:
    nodes = [dict(item) for item in items if isinstance(item, dict)]
    by_id = {str(item.get("node_id") or item.get("id") or ""): item for item in nodes if item.get("node_id") or item.get("id")}
    current_index = PHASES.index(phase) if phase in PHASES else (-1 if status != "running" else 0)

    for index, key in enumerate(PHASES):
        node_id = phase_node_id(key)
        if node_id not in by_id:
            node = {
                "node_id": node_id,
                "title": PHASE_LABELS[key],
                "kind": "phase",
                "level": "phase",
                "parent_id": None,
                "status": "pending",
                "priority": index * 100,
                "source": "runtime",
            }
            nodes.append(node)
            by_id[node_id] = node
        phase_status = "pending"
        if status == "completed" or key in completed or index < current_index:
            phase_status = "done"
        elif index == current_index:
            phase_status = "running"
        by_id[node_id]["status"] = phase_status
        by_id[node_id]["level"] = "phase"
        by_id[node_id]["kind"] = "phase"
        by_id[node_id]["priority"] = by_id[node_id].get("priority", index * 100)

    def ensure_objective(phase_key: str, objective_key: str, priority: int) -> str:
        node_id = objective_node_id(phase_key, objective_key)
        if node_id not in by_id:
            node = {
                "node_id": node_id,
                "title": objective_title(phase_key, objective_key),
                "kind": "objective",
                "level": "objective",
                "parent_id": phase_node_id(phase_key),
                "status": "pending",
                "priority": PHASES.index(phase_key) * 100 + priority,
                "source": "runtime",
            }
            nodes.append(node)
            by_id[node_id] = node
        return node_id

    for node in nodes:
        kind = str(node.get("kind") or "task")
        node["level"] = str(node.get("level") or plan_node_level(kind))
        if node["level"] != "work_item":
            continue
        parent_id = str(node.get("parent_id") or "")
        if parent_id and parent_id in by_id:
            continue
        if kind in {"surface", "request"}:
            node["parent_id"] = ensure_objective("recon", "attack_surface", 10)
        elif kind == "test":
            node["parent_id"] = ensure_objective("analysis", "test_plan", 10)
        else:
            node["parent_id"] = ensure_objective("analysis", "test_plan", 10)

    return sorted(nodes, key=lambda item: (int(item.get("priority") or 50), str(item.get("created_at") or ""), str(item.get("node_id") or "")))


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
    context = conversation.context if isinstance(conversation.context, dict) else {}
    checkpoint = (context.get("checkpoint") if isinstance(context, dict) else {}) or {}
    task_context = context.get("task") if isinstance(context.get("task"), dict) else {}
    agent_state = agent_state_from_checkpoint(checkpoint, conversation.status) if checkpoint else agent_state_from_messages(messages, evidence, conversation.status)
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
    attack_surface_items = snapshot_list(checkpoint.get("attack_surface")) or snapshot_list(context.get("attack_surface"))
    coverage_items = snapshot_list(checkpoint.get("coverage")) or snapshot_list(context.get("coverage"))
    captured_traffic_items = snapshot_list(checkpoint.get("captured_traffic")) or snapshot_list(context.get("captured_traffic"))
    raw_plan_tree = checkpoint_plan_tree(checkpoint) or context.get("exploration_plan_tree") or context.get("plan_tree") or []
    plan_tree = ensure_plan_tree_shape(raw_plan_tree, agent_state.get("phase"), checkpoint_completed(checkpoint), conversation.status)
    todos = todos_for_plan_tree(plan_tree) or (todos_for_checkpoint(checkpoint, conversation.status) if checkpoint else todos_for_phase(agent_state.get("phase"), conversation.status))
    evidence_items = merge_many_by_key([
        [evidence_summary(e) for e in evidence],
        explicit_evidence,
        fallback_tool_evidence,
    ], "evidence_id")
    snapshot_message_items, omitted = snapshot_messages(messages)
    agent_items = agents_from_messages(messages)

    return {
        "conversation": conversation_summary(conversation),
        "messages": snapshot_message_items,
        "agents": agent_items,
        "agent_state": agent_state,
        "progress": progress,
        "todos": todos,
        "findings": findings,
        "assets": asset_items,
        "checkpoint": checkpoint or {},
        "task_context": task_context,
        "attack_surface": attack_surface_items,
        "coverage": coverage_items,
        "plan_tree": plan_tree,
        "captured_traffic": captured_traffic_items,
        "pending_approvals": pending,
        "evidence": evidence_items,
        "read_model_errors": read_model_errors,
        "omitted": omitted,
        "counts": {
            "assets": len(asset_items),
            "findings": len(findings),
            "pending": len(pending),
            "evidence": len(evidence_items),
            "attack_surface": len(attack_surface_items),
            "coverage": len(coverage_items),
            "captured_traffic": len(captured_traffic_items),
            "plan_tree": len(plan_tree),
            "messages": len(snapshot_message_items),
            "agents": len(agent_items),
            "has_task_context": bool(task_context),
        },
    }



def snapshot_list(value) -> list:
    return list(value) if isinstance(value, list) else []

def message_summary(m: Message) -> dict:
    return {
        "id": str(m.id),
        "conversation_id": str(m.conversation_id),
        "role": m.role,
        "msg_type": m.msg_type,
        "content": m.content,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def snapshot_messages(messages: list[Message], limit: int = SNAPSHOT_MESSAGE_LIMIT) -> tuple[list[dict], dict]:
    total = len(messages)
    selected = messages[-limit:] if limit > 0 and total > limit else list(messages)
    omitted = {
        "messages": max(0, total - len(selected)),
        "tool_stdout_chars": 0,
        "large_text_chars": 0,
    }
    compacted = []
    for message in selected:
        item, stats = compact_message_summary(message)
        omitted["tool_stdout_chars"] += stats.get("tool_stdout_chars", 0)
        omitted["large_text_chars"] += stats.get("large_text_chars", 0)
        compacted.append(item)
    return compacted, {key: value for key, value in omitted.items() if value}


def compact_message_summary(message: Message) -> tuple[dict, dict]:
    content = message.content if isinstance(message.content, dict) else {}
    stats = {"tool_stdout_chars": 0, "large_text_chars": 0}
    compact_content = compact_message_content(message.msg_type, content, stats)
    return {
        "id": str(message.id),
        "conversation_id": str(message.conversation_id),
        "role": message.role,
        "msg_type": message.msg_type,
        "content": compact_content,
        "created_at": message.created_at.isoformat() if message.created_at else None,
    }, stats


def compact_message_content(msg_type: str, content: dict, stats: dict) -> dict:
    if msg_type == "tool_call":
        result = {
            "tool_name": content.get("tool_name"),
            "tool_run_id": content.get("tool_run_id"),
            "status": content.get("status"),
            "command": truncate_text(content.get("command"), SNAPSHOT_TEXT_LIMIT, stats, "large_text_chars"),
            "evidence_id": content.get("evidence_id"),
        }
        stdout = str(content.get("stdout") or "")
        if stdout:
            result["stdout"] = truncate_text(stdout, SNAPSHOT_TOOL_STDOUT_LIMIT, stats, "tool_stdout_chars")
        if isinstance(content.get("tool_items"), list):
            result["tool_items"] = [compact_tool_item(item, stats) for item in content.get("tool_items")[:20] if isinstance(item, dict)]
            omitted_items = max(0, len(content.get("tool_items") or []) - len(result["tool_items"]))
            if omitted_items:
                result["omitted_tool_items"] = omitted_items
        return {key: value for key, value in result.items() if value not in (None, "", [])}
    if msg_type == "status":
        keys = ("text", "phase", "iteration", "active_tool", "status", "summary", "agent_source", "agent_node_id")
        return {key: compact_value(content.get(key), stats) for key in keys if key in content and content.get(key) is not None}
    if msg_type in {"text", "thinking", "reasoning", "agent_thinking"}:
        keys = ("text", "agent_source", "agent_node_id", "agent_mode", "agent_target", "client_message_id")
        return {key: compact_value(content.get(key), stats) for key in keys if key in content and content.get(key) is not None}
    return {key: compact_value(value, stats) for key, value in content.items() if key != "stdout"}


def compact_tool_item(item: dict, stats: dict) -> dict:
    keys = ("tool_name", "tool_run_id", "status", "command", "evidence_id", "summary")
    result = {key: compact_value(item.get(key), stats) for key in keys if key in item and item.get(key) is not None}
    stdout = str(item.get("stdout") or "")
    if stdout:
        result["stdout"] = truncate_text(stdout, SNAPSHOT_TOOL_STDOUT_LIMIT, stats, "tool_stdout_chars")
    return result


def compact_value(value, stats: dict):
    if isinstance(value, str):
        return truncate_text(value, SNAPSHOT_TEXT_LIMIT, stats, "large_text_chars")
    if isinstance(value, list):
        return [compact_value(item, stats) for item in value[:50]]
    if isinstance(value, dict):
        return {str(key): compact_value(val, stats) for key, val in list(value.items())[:80]}
    return value


def truncate_text(value, limit: int, stats: dict, stat_key: str) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    omitted = len(text) - limit
    stats[stat_key] = stats.get(stat_key, 0) + omitted
    return f"{text[:limit]}...<truncated {omitted} chars>"


def agents_from_messages(messages: list[Message]) -> list[dict]:
    agents: dict[tuple[str, str], dict] = {}
    for message in messages:
        content = message.content if isinstance(message.content, dict) else {}
        source = str(content.get("agent_source") or content.get("agent_target") or ("user" if message.role == "user" else "agent"))
        node_id = str(content.get("agent_node_id") or "")
        key = (source, node_id)
        item = agents.setdefault(key, {
            "agent_source": source,
            "agent_node_id": node_id or None,
            "messages": 0,
            "first_seen_at": message.created_at.isoformat() if message.created_at else None,
            "last_seen_at": None,
        })
        item["messages"] += 1
        item["last_seen_at"] = message.created_at.isoformat() if message.created_at else item.get("last_seen_at")
    return list(agents.values())

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
        phase = "complete" if status == "completed" else "intake" if status == "running" else None
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




def todos_for_plan_tree(plan_tree: list[dict]) -> list[dict]:
    by_phase: dict[str, dict] = {}
    for node in plan_tree or []:
        if not isinstance(node, dict):
            continue
        if node.get("level") != "phase" and node.get("kind") != "phase":
            continue
        node_id = str(node.get("node_id") or "")
        phase = node_id.removeprefix("plan-phase-") if node_id.startswith("plan-phase-") else str(node.get("phase") or "")
        if phase in PHASES:
            by_phase[phase] = node
    if not by_phase:
        return []
    return [
        {
            "id": phase,
            "title": str(by_phase.get(phase, {}).get("title") or PHASE_LABELS[phase]),
            "status": str(by_phase.get(phase, {}).get("status") or "pending"),
        }
        for phase in PHASES
    ]


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



def checkpoint_plan_tree(checkpoint: dict) -> list[dict]:
    if not isinstance(checkpoint, dict):
        return []
    items = checkpoint.get("exploration_plan_tree") or checkpoint.get("plan_tree") or []
    if not isinstance(items, list):
        return []
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        out.append({
            "node_id": str(item.get("node_id") or item.get("id") or ""),
            "title": item.get("title") or "Untitled plan node",
            "status": item.get("status") or "pending",
            "parent_id": item.get("parent_id"),
            "kind": item.get("kind") or "task",
            "level": item.get("level") or plan_node_level(str(item.get("kind") or "task")),
            "target": item.get("target"),
            "endpoint": item.get("endpoint"),
            "parameter": item.get("parameter"),
            "vuln_type": item.get("vuln_type"),
            "notes": item.get("notes"),
            "evidence_ids": item.get("evidence_ids") or [],
            "source": item.get("source") or "agent",
            "priority": item.get("priority", 50),
        })
    return out
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
