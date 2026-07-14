"""Conversation snapshot assembly.

This module is the backend source of truth for restoring a conversation view.
It deliberately combines the durable message log, read models, and checkpoint
state so refreshes and page switches do not depend on whichever message page
the frontend has loaded.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
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
KANBAN_BUCKET_TITLES = {
    "task-confirmation": "\u4efb\u52a1\u786e\u8ba4",
    "attack-surface": "\u653b\u51fb\u9762\u8bc6\u522b",
    "vulnerability-discovery": "\u6f0f\u6d1e\u53d1\u73b0",
    "vulnerability-verification": "\u6f0f\u6d1e\u9a8c\u8bc1",
    "task-summary": "\u4efb\u52a1\u603b\u7ed3",
}
TERMINAL_PLAN_STATUSES = {"done", "blocked", "failed", "skipped"}



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


def ensure_plan_tree_shape(items: list[dict], phase: str | None, completed: set[str], status: str, workflow_kind: str | None = None) -> list[dict]:
    nodes = [dict(item) for item in items if isinstance(item, dict)]
    if workflow_kind == "strix":
        return sorted(nodes, key=lambda item: (int(item.get("priority") or 50), str(item.get("created_at") or ""), str(item.get("node_id") or "")))
    if workflow_kind == "pentest":
        return normalize_pentest_plan_tree(nodes)

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


def normalize_pentest_plan_tree(nodes: list[dict]) -> list[dict]:
    normalized: list[dict] = []
    for node in nodes:
        if is_legacy_runtime_phase_node(node):
            continue
        item = dict(node)
        kind = str(item.get("kind") or "task")
        item["level"] = str(item.get("level") or plan_node_level(kind))
        parent_id = str(item.get("parent_id") or "")
        if parent_id.startswith("plan-phase-") or parent_id.startswith("plan-objective-"):
            item["parent_id"] = None
        normalized.append(item)
    return sorted(normalized, key=lambda item: (int(item.get("priority") or 50), str(item.get("created_at") or ""), str(item.get("node_id") or "")))


def is_legacy_runtime_phase_node(node: dict) -> bool:
    node_id = str(node.get("node_id") or node.get("id") or "")
    level = str(node.get("level") or "")
    kind = str(node.get("kind") or "")
    parent_id = str(node.get("parent_id") or "")
    if level == "phase" or kind == "phase" or node_id.startswith("plan-phase-"):
        return True
    if level == "objective" or kind == "objective":
        return node_id.startswith("plan-objective-") or parent_id.startswith("plan-phase-") or str(node.get("source") or "") == "runtime"
    return False


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
    findings = merge_many_by_key([
        message_findings(messages),
        checkpoint_findings(checkpoint),
        [vuln_summary(v) for v in vulns],
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
    checkpoint_tree = checkpoint_plan_tree(checkpoint)
    strix_todo_tree = strix_todos_plan_tree(checkpoint)
    raw_plan_tree = checkpoint_tree + [item for item in strix_todo_tree if item.get("node_id") not in {node.get("node_id") for node in checkpoint_tree}]
    if not raw_plan_tree:
        raw_plan_tree = message_plan_tree(messages) or context.get("exploration_plan_tree") or context.get("plan_tree") or []
    workflow_kind = workflow_kind_for_checkpoint(checkpoint)
    plan_tree = ensure_plan_tree_shape(raw_plan_tree, agent_state.get("phase"), checkpoint_completed(checkpoint), conversation.status, workflow_kind)
    if conversation.status in {"completed", "incomplete"} and workflow_kind == "pentest":
        plan_tree = normalize_terminal_pentest_plan_tree(plan_tree, conversation.status)
    kanban = kanban_for_snapshot(checkpoint, plan_tree, agent_state.get("phase"), conversation.status, elapsed_seconds_for_conversation(conversation))
    progress = progress_for_kanban(kanban) or (progress_for_checkpoint(checkpoint, conversation.status) if checkpoint else progress_for_phase(agent_state.get("phase"), conversation.status))
    todos = todos_for_kanban(kanban) or todos_for_plan_tree(plan_tree) or (todos_for_checkpoint(checkpoint, conversation.status) if checkpoint else todos_for_phase(agent_state.get("phase"), conversation.status))
    evidence_items = merge_many_by_key([
        [evidence_summary(e) for e in evidence],
        explicit_evidence,
        fallback_tool_evidence,
    ], "evidence_id")
    snapshot_message_items, omitted = snapshot_messages(messages)
    agent_items = agents_from_messages(messages)
    strix_agent_items = strix_agents_from_checkpoint(checkpoint, conversation.status)
    strix_note_items = strix_notes_from_checkpoint(checkpoint)
    strix_run = strix_run_from_checkpoint(checkpoint)

    return {
        "conversation": conversation_summary(conversation),
        "messages": snapshot_message_items,
        "agents": agent_items,
        "strix_agents": strix_agent_items,
        "strix_notes": strix_note_items,
        "strix_run": strix_run,
        "agent_state": agent_state,
        "progress": progress,
        "kanban": kanban,
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
            "strix_agents": len(strix_agent_items),
            "strix_notes": len(strix_note_items),
            "has_strix_run": bool(strix_run),
            "has_task_context": bool(task_context),
        },
    }



def snapshot_list(value) -> list:
    return list(value) if isinstance(value, list) else []


def strix_agents_from_checkpoint(checkpoint: dict, conversation_status: str | None = None) -> list[dict]:
    if not isinstance(checkpoint, dict):
        return []
    node3 = checkpoint.get("node3_strix") if isinstance(checkpoint.get("node3_strix"), dict) else {}
    agents = node3.get("agents") if isinstance(node3.get("agents"), list) else []
    if not agents:
        # Node2 panel parity: checkpoint.panel_agents synthesized by the runtime.
        agents = checkpoint.get("panel_agents") if isinstance(checkpoint.get("panel_agents"), list) else []
    if not agents:
        agents = agents_from_pentest_diagnostics(checkpoint, conversation_status)
    normalized = []
    for item in agents:
        if not isinstance(item, dict):
            continue
        agent_id = str(item.get("id") or item.get("agent_id") or "").strip()
        if not agent_id:
            continue
        skills = item.get("skills") if isinstance(item.get("skills"), list) else []
        parent_id = str(item.get("parent_id") or "").strip()
        normalized.append({
            "id": agent_id,
            "name": str(item.get("name") or agent_id),
            "status": str(item.get("status") or "running"),
            "parent_id": parent_id or None,
            "task": str(item.get("task") or ""),
            "skills": [str(skill) for skill in skills if str(skill).strip()][:12],
            "pending_count": int(item.get("pending_count") or 0),
            "role": str(item.get("role") or ("child" if parent_id else "main")),
            "current_tool": str(item.get("current_tool") or ""),
            "current_action": str(item.get("current_action") or ""),
        })
    return normalize_agents_for_conversation_status(normalized, conversation_status)


def normalize_agents_for_conversation_status(agents: list[dict], conversation_status: str | None) -> list[dict]:
    """When the conversation is terminal, open agent rows must not stay 'running'."""
    status = str(conversation_status or "").strip().lower()
    if status not in {"completed", "incomplete", "failed", "canceled", "cancelled"}:
        return agents
    if status in {"failed"}:
        terminal_status = "failed"
        terminal_action = "failed"
    elif status in {"canceled", "cancelled"}:
        terminal_status = "stopped"
        terminal_action = "stopped"
    else:
        # completed / incomplete — collaboration tree shows finished work.
        terminal_status = "completed"
        terminal_action = "done"
    open_statuses = {"running", "pending", "todo", "llm_waiting", "tool_running", ""}
    out: list[dict] = []
    for item in agents:
        agent = dict(item)
        current = str(agent.get("status") or "").strip().lower()
        if current in open_statuses or current in {"working"}:
            agent["status"] = terminal_status
            action = str(agent.get("current_action") or "").strip().lower()
            if not action or action in open_statuses | {"working", "starting"}:
                agent["current_action"] = terminal_action
            # Clear in-progress tool chrome when the conversation already ended.
            if current in open_statuses | {"working"}:
                agent["current_tool"] = ""
            agent["pending_count"] = 0
        out.append(agent)
    return out


def agents_from_pentest_diagnostics(checkpoint: dict, conversation_status: str | None = None) -> list[dict]:
    """Build a Node3-shaped main agent row from Node2 diagnostics when multi-agent data is absent."""
    if str(checkpoint.get("runtime") or "") not in {"node2-pi", "node2"} and workflow_kind_for_checkpoint(checkpoint) != "pentest":
        return []
    diag = checkpoint.get("diagnostics") if isinstance(checkpoint.get("diagnostics"), dict) else {}
    phase = str(diag.get("phase") or "")
    conv = str(conversation_status or "").strip().lower()
    if conv in {"completed", "incomplete"}:
        status = "completed"
        action = "done"
        tool = ""
    elif conv in {"failed", "canceled", "cancelled"}:
        status = "failed" if conv == "failed" else "stopped"
        action = status
        tool = ""
    else:
        status = "completed" if phase in {"finished", "agent_end"} else "failed" if phase in {"error", "aborted"} else "running"
        action = phase
        tool = str(diag.get("activeTool") or diag.get("lastTool") or "")
    return [{
        "id": "node2-main",
        "name": "Main Agent",
        "status": status,
        "parent_id": None,
        "task": "",
        "skills": [],
        "pending_count": 0,
        "role": "main",
        "current_tool": tool,
        "current_action": action,
    }]


def strix_todos_from_checkpoint(checkpoint: dict) -> list[dict]:
    if not isinstance(checkpoint, dict):
        return []
    node3 = checkpoint.get("node3_strix") if isinstance(checkpoint.get("node3_strix"), dict) else {}
    todos = node3.get("todos") if isinstance(node3.get("todos"), list) else []
    normalized = []
    for item in todos:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id") or item.get("title") or "").strip()
        if not item_id:
            continue
        normalized.append({
            "id": item_id,
            "agent_id": str(item.get("agent_id") or ""),
            "title": str(item.get("title") or "Untitled task"),
            "description": str(item.get("description") or ""),
            "priority": str(item.get("priority") or "normal"),
            "status": normalize_plan_status(item.get("status")),
            "created_at": str(item.get("created_at") or ""),
            "updated_at": str(item.get("updated_at") or ""),
            "completed_at": str(item.get("completed_at") or ""),
            "started_at": str(item.get("started_at") or ""),
            "linked_agent_id": str(item.get("linked_agent_id") or ""),
        })
    return normalized


def strix_todos_plan_tree(checkpoint: dict) -> list[dict]:
    nodes = []
    for index, item in enumerate(strix_todos_from_checkpoint(checkpoint)):
        todo_id = item.get("id") or f"todo-{index}"
        nodes.append({
            "node_id": f"strix-todo-{todo_id}",
            "id": str(todo_id),
            "title": item.get("title") or "Untitled task",
            "status": item.get("status") or "pending",
            "parent_id": None,
            "kind": "task",
            "level": "work_item",
            "target": None,
            "method": None,
            "endpoint": None,
            "parameter": None,
            "parameters": [],
            "vuln_type": None,
            "result": None,
            "notes": item.get("description") or "",
            "evidence_ids": [],
            "source": "strix_todo",
            "priority": strix_priority(item.get("priority"), index),
            "agent_id": item.get("agent_id") or "",
            "linked_agent_id": item.get("linked_agent_id") or "",
            "created_at": item.get("created_at") or "",
            "updated_at": item.get("updated_at") or "",
        })
    return nodes


def strix_notes_from_checkpoint(checkpoint: dict) -> list[dict]:
    if not isinstance(checkpoint, dict):
        return []
    node3 = checkpoint.get("node3_strix") if isinstance(checkpoint.get("node3_strix"), dict) else {}
    notes = node3.get("notes") if isinstance(node3.get("notes"), list) else []
    normalized = []
    for item in notes:
        if not isinstance(item, dict):
            continue
        note_id = str(item.get("id") or item.get("title") or "").strip()
        if not note_id:
            continue
        tags = item.get("tags") if isinstance(item.get("tags"), list) else []
        normalized.append({
            "id": note_id,
            "title": str(item.get("title") or "Untitled note"),
            "content": str(item.get("content") or ""),
            "category": str(item.get("category") or ""),
            "tags": [str(tag) for tag in tags if str(tag).strip()][:12],
            "created_at": str(item.get("created_at") or ""),
            "updated_at": str(item.get("updated_at") or ""),
        })
    return normalized


def strix_run_from_checkpoint(checkpoint: dict) -> dict:
    if not isinstance(checkpoint, dict):
        return {}
    node3 = checkpoint.get("node3_strix") if isinstance(checkpoint.get("node3_strix"), dict) else {}
    run = node3.get("run") if isinstance(node3.get("run"), dict) else {}
    if not run:
        run = strix_run_from_run_dir(str(node3.get("run_dir") or ""))
    if not run:
        run = pentest_run_from_checkpoint(checkpoint)
    if not run:
        return {}
    targets = run.get("targets_info") if isinstance(run.get("targets_info"), list) else []
    usage = run.get("llm_usage") if isinstance(run.get("llm_usage"), dict) else {}
    return {
        "run_id": str(run.get("run_id") or ""),
        "run_name": str(run.get("run_name") or node3.get("run_name") or ""),
        "status": str(run.get("status") or ""),
        "start_time": str(run.get("start_time") or ""),
        "end_time": str(run.get("end_time") or ""),
        "scan_mode": str(run.get("scan_mode") or ""),
        "targets_info": [strix_target_summary(item) for item in targets if isinstance(item, dict)][:12],
        "llm_usage": {
            "requests": safe_int(usage.get("requests")),
            "input_tokens": safe_int(usage.get("input_tokens")),
            "cached_tokens": safe_int(usage.get("cached_tokens")),
            "output_tokens": safe_int(usage.get("output_tokens")),
            "reasoning_tokens": safe_int(usage.get("reasoning_tokens")),
            "total_tokens": safe_int(usage.get("total_tokens")),
            "cost": safe_float(usage.get("cost")),
            "agent_count": safe_int(usage.get("agent_count")),
        },
    }


def _is_pentest_runtime(runtime: object) -> bool:
    """Node2/Node4 pi workers share the right-panel run summary shape."""
    value = str(runtime or "").strip().lower()
    return value in {"node2", "node2-pi", "node4", "node4-pi"} or value.startswith("node2") or value.startswith("node4")


def pentest_run_from_checkpoint(checkpoint: dict) -> dict:
    """Synthesize Node3-shaped run summary from Node2/Node4/pi checkpoints for right-panel parity."""
    if not isinstance(checkpoint, dict):
        return {}
    runtime = str(checkpoint.get("runtime") or "")
    if not _is_pentest_runtime(runtime) and workflow_kind_for_checkpoint(checkpoint) != "pentest":
        return {}
    diag = checkpoint.get("diagnostics") if isinstance(checkpoint.get("diagnostics"), dict) else {}
    lifecycle = checkpoint.get("lifecycle") if isinstance(checkpoint.get("lifecycle"), dict) else {}
    finish = lifecycle.get("finishScan") if isinstance(lifecycle.get("finishScan"), dict) else {}
    usage = checkpoint.get("llm_usage") if isinstance(checkpoint.get("llm_usage"), dict) else {}
    targets = checkpoint.get("targets_info") if isinstance(checkpoint.get("targets_info"), list) else []
    if not targets:
        task_target = checkpoint.get("task_target") if isinstance(checkpoint.get("task_target"), dict) else {}
        value = task_target.get("value") or task_target.get("url") or ""
        if value:
            targets = [{"type": "url", "target": value, "original": value}]
    start_time = str(checkpoint.get("started_at") or diag.get("startedAt") or "")
    end_time = str(
        checkpoint.get("end_time")
        or finish.get("calledAt")
        or ""
    )
    if not end_time and str(diag.get("phase") or "") in {"finished", "error", "aborted"}:
        end_time = str(diag.get("updatedAt") or "")
    if not end_time and str(checkpoint.get("status") or "") in {"completed", "incomplete", "failed", "blocked"}:
        # Node4 terminal checkpoints put end_time on the root; status alone is enough to stop the clock.
        end_time = str(checkpoint.get("end_time") or "")
    phase = str(diag.get("phase") or checkpoint.get("agent_phase") or "")
    status = str(finish.get("status") or checkpoint.get("status") or "")
    if not status:
        status = (
            "completed"
            if phase in {"finished", "agent_end"}
            else "failed"
            if phase in {"error", "aborted"}
            else "running"
        )
    run_name = "node4" if _is_pentest_runtime(runtime) and str(runtime).startswith("node4") else "node2"
    return {
        "run_id": str(diag.get("taskId") or checkpoint.get("task_id") or ""),
        "run_name": run_name,
        "status": status,
        "start_time": start_time,
        "end_time": end_time,
        "scan_mode": str(checkpoint.get("scan_mode") or checkpoint.get("engagement") or ""),
        "targets_info": targets,
        "llm_usage": {
            "requests": safe_int(usage.get("requests") or diag.get("llmTurnCount")),
            "input_tokens": safe_int(usage.get("input_tokens")),
            "cached_tokens": safe_int(usage.get("cached_tokens")),
            "output_tokens": safe_int(usage.get("output_tokens")),
            "reasoning_tokens": safe_int(usage.get("reasoning_tokens")),
            "total_tokens": safe_int(usage.get("total_tokens")),
            "cost": safe_float(usage.get("cost")),
            "agent_count": safe_int(usage.get("agent_count") or 1),
        },
    }


def strix_run_from_run_dir(run_dir: str) -> dict:
    if not run_dir:
        return {}
    try:
        path = Path(run_dir) / "run.json"
        if not path.exists():
            return {}
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    usage = raw.get("llm_usage") if isinstance(raw.get("llm_usage"), dict) else {}
    return {
        "run_id": str(raw.get("run_id") or ""),
        "run_name": str(raw.get("run_name") or ""),
        "status": str(raw.get("status") or ""),
        "start_time": str(raw.get("start_time") or ""),
        "end_time": str(raw.get("end_time") or ""),
        "scan_mode": str(raw.get("scan_mode") or ""),
        "targets_info": [strix_target_from_raw(item) for item in raw.get("targets_info", []) if isinstance(item, dict)][:12],
        "llm_usage": {
            "requests": safe_int(usage.get("requests")),
            "input_tokens": safe_int(usage.get("input_tokens")),
            "cached_tokens": usage_detail_total(usage.get("input_tokens_details"), "cached_tokens"),
            "output_tokens": safe_int(usage.get("output_tokens")),
            "reasoning_tokens": usage_detail_total(usage.get("output_tokens_details"), "reasoning_tokens"),
            "total_tokens": safe_int(usage.get("total_tokens")),
            "cost": safe_float(usage.get("cost")),
            "agent_count": len([item for item in usage.get("agent_usages", []) if isinstance(item, dict)]) if isinstance(usage.get("agent_usages"), list) else 0,
        },
    }


def strix_target_summary(item: dict) -> dict:
    return {
        "type": str(item.get("type") or "target"),
        "target": str(item.get("target") or item.get("original") or ""),
        "original": str(item.get("original") or item.get("target") or ""),
    }


def strix_target_from_raw(item: dict) -> dict:
    details = item.get("details") if isinstance(item.get("details"), dict) else {}
    target = details.get("target_url") or details.get("target_repo") or details.get("target_path") or details.get("target_host") or item.get("original") or ""
    return {
        "type": str(item.get("type") or "target"),
        "target": str(target),
        "original": str(item.get("original") or target),
    }


def usage_detail_total(raw, key: str) -> int:
    if isinstance(raw, dict):
        return safe_int(raw.get(key))
    if isinstance(raw, list):
        return sum(safe_int(item.get(key)) for item in raw if isinstance(item, dict))
    return 0


def safe_int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def safe_float(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def normalize_plan_status(value) -> str:
    status = str(value or "pending").strip().lower()
    if status in {"complete", "completed"}:
        return "done"
    if status in {"in_progress", "working"}:
        return "running"
    if status in {"todo", "pending", "running", "done", "blocked", "failed", "skipped"}:
        return status
    return "pending"


def strix_priority(value, index: int) -> int:
    base = {
        "critical": 0,
        "high": 10,
        "medium": 20,
        "normal": 30,
        "low": 40,
    }.get(str(value or "").lower(), 30)
    return base + index

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


def elapsed_seconds_for_conversation(c: Conversation) -> int:
    if not c.created_at:
        return 0
    end = datetime.now(timezone.utc) if c.status == "running" else (c.last_active_at or datetime.now(timezone.utc))
    start = c.created_at
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    return max(0, int((end - start).total_seconds()))


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


def kanban_for_snapshot(checkpoint: dict, plan_tree: list[dict], phase: str | None, status: str, elapsed_seconds: int) -> dict:
    checkpoint_kanban = checkpoint.get("kanban") if isinstance(checkpoint, dict) and isinstance(checkpoint.get("kanban"), dict) else None
    checkpoint_kind = workflow_kind_for_checkpoint(checkpoint)
    if status in {"completed", "incomplete"} and checkpoint_kind == "pentest":
        plan_tree = normalize_terminal_pentest_plan_tree(plan_tree, status)
    if checkpoint_kanban and not should_recompute_terminal_kanban(checkpoint_kanban, checkpoint_kind, status):
        kanban = dict(checkpoint_kanban)
        kanban["workflow_kind"] = str(kanban.get("workflow_kind") or checkpoint_kind or "")
        totals = dict(kanban.get("totals") or {})
        totals["percent"] = int(totals.get("percent") or safe_percent(totals.get("processed"), totals.get("discovered")))
        kanban["totals"] = totals
        kanban["buckets"] = normalize_kanban_buckets(kanban.get("buckets") or [], kanban.get("workflow_kind"))
        kanban["elapsed_seconds"] = elapsed_seconds
        kanban["current_stage"] = current_kanban_stage(phase, status, checkpoint, kanban.get("current_stage"))
        return kanban

    work = [node for node in plan_tree or [] if isinstance(node, dict) and str(node.get("level") or "work_item") == "work_item"]
    if checkpoint_kind == "strix":
        done = sum(1 for node in work if is_terminal_plan_node(node))
        running = sum(1 for node in work if str(node.get("status") or "") == "running")
        pending = sum(1 for node in work if str(node.get("status") or "pending") in {"todo", "pending"})
        total = len(work)
        return {
            "workflow_kind": "strix",
            "elapsed_seconds": elapsed_seconds,
            "current_stage": "completed" if status == "completed" else "executing" if status == "running" else "idle",
            "totals": {
                "discovered": total,
                "processed": done,
                "pending": pending,
                "running": running,
                "confirmed": 0,
                "negative": 0,
                "blocked": sum(1 for node in work if str(node.get("status") or "") == "blocked"),
                "inconclusive": 0,
                "percent": safe_percent(done, total),
            },
            "buckets": [],
        }
    surfaces = [node for node in work if str(node.get("kind") or "") in {"surface", "request"}]
    tests = [node for node in work if is_concrete_test_node(node)]
    verification = [node for node in work if str(node.get("kind") or "") == "finding" or (str(node.get("kind") or "") == "test" and is_terminal_plan_node(node))]
    if not checkpoint_kind == "pentest" and not surfaces and not tests and not verification:
        return {
            "elapsed_seconds": elapsed_seconds,
            "current_stage": current_kanban_stage(phase, status, checkpoint, None),
            "totals": {"discovered": 0, "processed": 0, "pending": 0, "running": 0, "confirmed": 0, "negative": 0, "blocked": 0, "inconclusive": 0, "percent": 0},
            "buckets": [],
        }
    processed = sum(1 for node in tests if is_terminal_plan_node(node))
    discovered = len(tests) or len(surfaces)
    phase_index = PHASES.index(phase) if phase in PHASES else -1
    task_confirmed = status in {"completed", "incomplete"} or phase_index > 0
    summary_total = 1 if tests or verification else 0
    summary_done = status in {"completed", "incomplete"}
    totals = {
        "discovered": discovered,
        "processed": processed,
        "pending": sum(1 for node in tests if str(node.get("status") or "pending") in {"todo", "pending"}),
        "running": sum(1 for node in tests if str(node.get("status") or "") == "running"),
        "confirmed": result_count(tests, "confirmed"),
        "negative": result_count(tests, "negative"),
        "blocked": result_count(tests, "blocked"),
        "inconclusive": result_count(tests, "inconclusive"),
        "percent": safe_percent(processed, discovered),
    }
    return {
        "workflow_kind": "pentest",
        "elapsed_seconds": elapsed_seconds,
        "current_stage": current_kanban_stage(phase, status, checkpoint, None),
        "totals": totals,
        "buckets": [
            {"id": "task-confirmation", "title": KANBAN_BUCKET_TITLES["task-confirmation"], "done": 1 if task_confirmed else 0, "total": 1, "status": "done" if task_confirmed else "running" if phase == "intake" else "pending"},
            {"id": "attack-surface", "title": KANBAN_BUCKET_TITLES["attack-surface"], "done": sum(1 for node in surfaces if is_terminal_plan_node(node)), "total": len(surfaces), "status": bucket_status(surfaces, phase == "recon")},
            {"id": "vulnerability-discovery", "title": KANBAN_BUCKET_TITLES["vulnerability-discovery"], "done": processed, "total": len(tests), "status": bucket_status(tests, phase in {"analysis", "verify"})},
            {"id": "vulnerability-verification", "title": KANBAN_BUCKET_TITLES["vulnerability-verification"], "done": sum(1 for node in verification if is_terminal_plan_node(node)), "total": len(verification), "status": bucket_status(verification, phase == "verify")},
            {"id": "task-summary", "title": KANBAN_BUCKET_TITLES["task-summary"], "done": summary_total if summary_done else 0, "total": summary_total, "status": "done" if summary_done else "running" if phase == "report" else "pending"},
        ],
    }


def should_recompute_terminal_kanban(kanban: dict, workflow_kind: str, status: str) -> bool:
    if status not in {"completed", "incomplete"} or workflow_kind != "pentest":
        return False
    current_stage = str(kanban.get("current_stage") or "")
    buckets = kanban.get("buckets") if isinstance(kanban.get("buckets"), list) else []
    summary_bucket = next((item for item in buckets if isinstance(item, dict) and item.get("id") == "task-summary"), {})
    totals = kanban.get("totals") if isinstance(kanban.get("totals"), dict) else {}
    has_open_totals = int(totals.get("pending") or 0) > 0 or int(totals.get("running") or 0) > 0
    summary_pending = str(summary_bucket.get("status") or "pending") == "pending"
    return current_stage == "executing" or summary_pending or has_open_totals


def normalize_terminal_pentest_plan_tree(
    plan_tree: list[dict],
    conversation_status: str | None = None,
) -> list[dict]:
    """Close stale open plan rows when the conversation lifecycle already ended.

    Agent-authored intentional TODOs (Tasks panel) are often left pending after
    finish_scan/task_complete because the model never coverage(mark)s them done.
    For completed conversations, treat remaining open checklist items as done so
    the UI matches the terminal lifecycle. Incomplete keeps open work visible.
    """
    conv = str(conversation_status or "").strip().lower()
    close_open_checklist = conv == "completed"
    open_statuses = {"todo", "pending", "running"}
    checklist_sources = {"agent", "plan", "strix_todo"}
    checklist_kinds = {"plan", "summary", "task", "work", "work_item", "package", "objective", "stage"}
    normalized = []
    for node in plan_tree or []:
        if not isinstance(node, dict):
            continue
        item = dict(node)
        if is_legacy_resolved_test_node(item):
            if notes_imply_not_applicable(item):
                item["status"] = "skipped"
                item["result"] = "negative"
            else:
                item["status"] = "done"
                item["result"] = item.get("result") or "inconclusive"
        elif close_open_checklist and str(item.get("status") or "").lower() in open_statuses:
            source = str(item.get("source") or "").lower()
            kind = str(item.get("kind") or "").lower()
            if source in checklist_sources or kind in checklist_kinds:
                item["status"] = "done"
                if not item.get("result"):
                    item["result"] = "completed"
        normalized.append(item)
    return normalized


def is_legacy_resolved_test_node(node: dict) -> bool:
    if str(node.get("kind") or "") != "test":
        return False
    if str(node.get("status") or "") not in {"todo", "pending", "running"}:
        return False
    source = str(node.get("source") or "")
    notes = str(node.get("notes") or "").strip()
    if source == "coverage" and notes:
        return True
    if source == "auditor" and notes.startswith("Inferred from observed request/form parameter."):
        return True
    return notes_imply_not_applicable(node)


def notes_imply_not_applicable(node: dict) -> bool:
    notes = str(node.get("notes") or "").lower()
    return "not applicable" in notes or notes.startswith("no ")


def normalize_kanban_buckets(items, workflow_kind: str | None = None) -> list[dict]:
    if workflow_kind != "pentest":
        return [
            {
                "id": str(item.get("id") or item.get("title") or index),
                "title": str(item.get("title") or item.get("id") or "Task"),
                "done": int(item.get("done") or 0),
                "total": int(item.get("total") or 0),
                "status": str(item.get("status") or "pending"),
            }
            for index, item in enumerate(items if isinstance(items, list) else [])
            if isinstance(item, dict)
        ]
    buckets = []
    seen = set()
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        bucket_id = str(item.get("id") or "")
        if bucket_id not in KANBAN_BUCKET_TITLES:
            continue
        seen.add(bucket_id)
        buckets.append({
            "id": bucket_id,
            "title": KANBAN_BUCKET_TITLES[bucket_id],
            "done": int(item.get("done") or 0),
            "total": int(item.get("total") or 0),
            "status": str(item.get("status") or "pending"),
        })
    for bucket_id, title in KANBAN_BUCKET_TITLES.items():
        if bucket_id not in seen:
            buckets.append({"id": bucket_id, "title": title, "done": 0, "total": 0, "status": "pending"})
    return buckets


def workflow_kind_for_checkpoint(checkpoint: dict) -> str:
    direct_kind = str(checkpoint.get("workflow_kind") or "") if isinstance(checkpoint, dict) else ""
    if direct_kind:
        return direct_kind
    if isinstance(checkpoint, dict) and isinstance(checkpoint.get("node3_strix"), dict):
        return "strix"
    kanban = checkpoint.get("kanban") if isinstance(checkpoint, dict) and isinstance(checkpoint.get("kanban"), dict) else {}
    kanban_kind = str(kanban.get("workflow_kind") or "")
    if kanban_kind:
        return kanban_kind
    runtime = str(checkpoint.get("runtime") or "") if isinstance(checkpoint, dict) else ""
    if runtime.startswith("node2") or runtime.startswith("node4"):
        return "pentest"
    # Node4 also stamps scan_mode / engagement without relying on runtime alone.
    if isinstance(checkpoint, dict) and (
        str(checkpoint.get("scan_mode") or "").strip()
        or str(checkpoint.get("engagement") or "").strip()
        or str(checkpoint.get("role_pack") or "").strip()
    ):
        return "pentest"
    return ""


def current_kanban_stage(phase: str | None, status: str, checkpoint: dict, fallback) -> str:
    if status == "completed":
        return "completed"
    if status == "incomplete":
        return "incomplete"
    if phase == "intake":
        return "confirming"
    if phase == "report":
        return "summarizing"
    if fallback in {"confirming", "executing", "summarizing", "completed", "incomplete"}:
        return str(fallback)
    return "executing"


def progress_for_kanban(kanban: dict) -> dict:
    totals = kanban.get("totals") if isinstance(kanban, dict) else {}
    if not isinstance(totals, dict):
        return {}
    current = int(totals.get("processed") or 0)
    total = int(totals.get("discovered") or 0)
    return {"current": current, "total": total, "percent": safe_percent(current, total)}


def todos_for_kanban(kanban: dict) -> list[dict]:
    buckets = kanban.get("buckets") if isinstance(kanban, dict) else []
    if not isinstance(buckets, list):
        return []
    return [
        {"id": str(item.get("id") or ""), "title": str(item.get("title") or ""), "status": str(item.get("status") or "pending")}
        for item in buckets
        if isinstance(item, dict)
    ]


def is_terminal_plan_node(node: dict) -> bool:
    return str(node.get("status") or "") in TERMINAL_PLAN_STATUSES


def is_gateable_plan_node(node: dict) -> bool:
    if str(node.get("source") or "") == "pi_tool":
        return False
    if str(node.get("kind") or "") in {"surface", "finding"}:
        return False
    return str(node.get("level") or "work_item") == "work_item"


def is_concrete_test_node(node: dict) -> bool:
    if not is_gateable_plan_node(node):
        return False
    if str(node.get("kind") or "") == "test":
        return True
    if node.get("vuln_type"):
        return True
    return bool(node.get("endpoint") and node.get("parameter"))


def bucket_status(nodes: list[dict], running: bool) -> str:
    if not nodes:
        return "running" if running else "pending"
    if any(str(node.get("status") or "") == "running" for node in nodes):
        return "running"
    if all(is_terminal_plan_node(node) for node in nodes):
        return "done"
    return "running" if running else "pending"


def result_count(nodes: list[dict], result: str) -> int:
    count = 0
    for node in nodes:
        node_result = str(node.get("result") or "")
        if node_result == result:
            count += 1
        elif result == "blocked" and str(node.get("status") or "") == "blocked":
            count += 1
        elif result == "negative" and str(node.get("status") or "") == "skipped":
            count += 1
        elif result == "inconclusive" and not node_result and not is_terminal_plan_node(node):
            count += 1
    return count


def safe_percent(current, total) -> int:
    try:
        current_value = int(current or 0)
        total_value = int(total or 0)
    except (TypeError, ValueError):
        return 0
    return round((current_value / total_value) * 100) if total_value else 0


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
            "method": item.get("method"),
            "endpoint": item.get("endpoint"),
            "parameter": item.get("parameter"),
            "parameters": item.get("parameters") or [],
            "vuln_type": item.get("vuln_type"),
            "result": item.get("result"),
            "notes": item.get("notes"),
            "evidence_ids": item.get("evidence_ids") or [],
            "source": item.get("source") or "agent",
            "priority": item.get("priority", 50),
        })
    return out


def message_plan_tree(messages: list[Message]) -> list[dict]:
    for message in reversed(messages):
        if message.msg_type != "plan_tree_updated" or not isinstance(message.content, dict):
            continue
        items = message.content.get("plan_tree")
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
    return []


def checkpoint_findings(checkpoint: dict) -> list[dict]:
    if not isinstance(checkpoint, dict):
        return []
    items = []
    node3 = checkpoint.get("node3_strix") if isinstance(checkpoint.get("node3_strix"), dict) else {}
    for item in node3.get("vulnerabilities") or []:
        if not isinstance(item, dict):
            continue
        items.append(strix_vulnerability_finding(item))
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


def strix_vulnerability_finding(item: dict) -> dict:
    target = item.get("target") or item.get("affected_asset") or ""
    endpoint = item.get("endpoint") or ""
    poc = item.get("poc") or item.get("poc_description") or item.get("poc_script_code") or ""
    return {
        "id": str(item.get("id") or item.get("vulnerability_id") or item.get("title") or ""),
        "vulnerability_id": str(item.get("vulnerability_id") or item.get("id") or ""),
        "strix_vulnerability_id": str(item.get("strix_vulnerability_id") or item.get("id") or ""),
        "title": item.get("title") or "Untitled finding",
        "severity": item.get("severity") or "medium",
        "location": endpoint or item.get("location") or target,
        "confidence": item.get("confidence") or "high",
        "status": item.get("status") or "confirmed",
        "affected_asset": target,
        "target": target,
        "url": target,
        "description": item.get("description") or "",
        "impact": item.get("impact") or "",
        "technical_analysis": item.get("technical_analysis") or "",
        "poc": poc,
        "poc_description": item.get("poc_description") or "",
        "poc_script_code": item.get("poc_script_code") or "",
        "remediation": item.get("remediation") or item.get("remediation_steps") or "",
        "remediation_steps": item.get("remediation_steps") or "",
        "evidence_ids": item.get("evidence_ids") or [],
        "cvss": item.get("cvss"),
        "cvss_breakdown": item.get("cvss_breakdown") if isinstance(item.get("cvss_breakdown"), dict) else {},
        "cve_id": item.get("cve_id") or item.get("cve"),
        "cwe": item.get("cwe"),
        "endpoint": endpoint,
        "method": item.get("method"),
        "agent_id": item.get("agent_id"),
        "agent_name": item.get("agent_name"),
        "timestamp": item.get("timestamp"),
        "source": "strix",
    }


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
            "strix_vulnerability_id": content.get("strix_vulnerability_id"),
            "title": content.get("title") or "Untitled finding",
            "severity": content.get("severity") or "medium",
            "location": content.get("location") or content.get("url") or content.get("affected_asset") or content.get("poc") or "",
            "confidence": content.get("confidence"),
            "status": content.get("status") or "pending",
            "asset_id": str(content.get("asset_id")) if content.get("asset_id") else None,
            "affected_asset": content.get("affected_asset") or content.get("url") or content.get("target") or "",
            "description": content.get("description") or content.get("impact") or "",
            "impact": content.get("impact") or "",
            "technical_analysis": content.get("technical_analysis") or "",
            "poc": content.get("poc") or content.get("reproduction") or "",
            "poc_description": content.get("poc_description") or "",
            "poc_script_code": content.get("poc_script_code") or "",
            "remediation": content.get("remediation") or "",
            "remediation_steps": content.get("remediation_steps") or "",
            "cvss": content.get("cvss"),
            "cvss_breakdown": content.get("cvss_breakdown") if isinstance(content.get("cvss_breakdown"), dict) else {},
            "cve_id": content.get("cve_id") or content.get("cve"),
            "cwe": content.get("cwe"),
            "endpoint": content.get("endpoint"),
            "method": content.get("method"),
            "agent_id": content.get("agent_id"),
            "agent_name": content.get("agent_name"),
            "timestamp": content.get("timestamp"),
            "evidence_ids": content.get("evidence_ids") or [],
            "finding_kind": content.get("finding_kind") or content.get("kind") or content.get("category"),
            "kind": content.get("kind") or content.get("finding_kind") or content.get("category"),
            "category": content.get("category") or content.get("finding_kind") or content.get("kind"),
            "flag_value": content.get("flag_value"),
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
    """Asset card for agent/session snapshot; include port notes for service context."""
    props = a.properties if isinstance(a.properties, dict) else {}
    services = props.get("services") if isinstance(props.get("services"), list) else []
    port_notes = {}
    for svc in services:
        if not isinstance(svc, dict):
            continue
        port = str(svc.get("port") or "").strip()
        note = str(svc.get("note") or svc.get("remark") or "").strip()
        if port and note:
            port_notes[port] = note
    return {
        "id": str(a.id),
        "name": a.name,
        "address": a.address,
        "type": a.type,
        "tags": list(a.tags or []),
        "properties": props,
        # Flattened for agents: "52799": "CTF web, 9 levels · flag-based"
        "port_notes": port_notes,
        "services": services,
    }


def vuln_summary(v: Vulnerability) -> dict:
    # Lazy import avoids circular import with api package during app boot.
    from app.api.vulnerabilities import classify_finding_kind

    kind = classify_finding_kind(v)
    return {
        "id": str(v.id),
        "vulnerability_id": str(v.id),
        "title": v.title,
        "severity": v.severity,
        "location": v.poc or "",
        "confidence": v.confidence,
        "status": v.status,
        "asset_id": str(v.asset_id) if v.asset_id else None,
        "description": v.description,
        "poc": v.poc,
        "remediation": v.remediation,
        "evidence_ids": v.evidence_ids or [],
        "finding_kind": kind,
        "kind": kind,
        "category": kind,
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
