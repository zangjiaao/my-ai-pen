from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, Callable

from strix.report.state import ReportState
from strix.tools.run_memory.tools import attack_surface_from_file, coverage_from_file, evidence_from_file, hypotheses_from_file


MAX_TOOL_OUTPUT_CHARS = 4000
TERMINAL_AGENT_ACTIVITY_STATUSES = {"completed", "failed", "stopped", "crashed"}


class PlatformEventSink:
    def __init__(self, ws: Any, task: dict[str, Any]) -> None:
        self.ws = ws
        self.task = task
        self.queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self.sent_vulnerability_ids: set[str] = set()
        self.tool_names_by_call_id: dict[str, str] = {}
        self.tool_args_by_call_id: dict[str, dict[str, Any]] = {}
        self.tool_agent_by_call_id: dict[str, str] = {}
        self.agents_by_id: dict[str, dict[str, Any]] = {}
        self.run_name = ""
        self.run_dir = ""
        self.scan_completed_callback: Callable[[], None] | None = None
        self.forward_raw_messages = not falsey(os.getenv("NODE3_FORWARD_STRIX_MESSAGES", "1"))
        self._closed = False

    def set_run_context(self, run_name: str, run_dir: str) -> None:
        self.run_name = run_name
        self.run_dir = run_dir

    async def pump(self) -> None:
        while True:
            message = await self.queue.get()
            if message is None:
                return
            await send(self.ws, message)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self.queue.put(None)

    async def flush(self) -> None:
        while not self.queue.empty():
            await asyncio.sleep(0)

    def emit(self, message: dict[str, Any]) -> None:
        if not self._closed:
            self.queue.put_nowait(message)

    def emit_agent_checkpoint(self) -> None:
        if self.run_name and self.run_dir and self.agents_by_id:
            self.emit(runtime_checkpoint(
                self.task,
                self.run_name,
                self.run_dir,
                fallback_agents=list(self.agents_by_id.values()),
            ))

    def sdk_event(self, agent_id: str, event: Any) -> None:
        self.ensure_agent(agent_id)
        event_type = getattr(event, "type", "")
        if event_type != "run_item_stream_event":
            return

        item = getattr(event, "item", None)
        item_type = getattr(item, "type", "")
        if item_type == "message_output_item":
            content = sdk_message_text(item).strip()
            if content and self.forward_raw_messages:
                self.emit(text(self.task, content, metadata={"agent_id": agent_id}))
            return
        if item_type == "tool_call_item":
            call = sdk_tool_call_data(item)
            call_id = call["call_id"]
            self.tool_names_by_call_id[call_id] = call["tool_name"]
            self.tool_args_by_call_id[call_id] = call["args"]
            self.tool_agent_by_call_id[call_id] = agent_id
            self.update_agent_activity(agent_id, call["tool_name"], call["args"], "running")
            progress = tool_start_progress(call["tool_name"], call["args"])
            if progress:
                self.emit(text(self.task, progress, metadata={"agent_id": agent_id, "tool_name": call["tool_name"]}))
            if should_emit_tool_output(call["tool_name"], "running"):
                self.emit(tool_output(
                    self.task,
                    tool_name=call["tool_name"],
                    tool_run_id=call_id,
                    status_value="running",
                    line=tool_call_summary(call["tool_name"], call["args"]),
                    metadata={"agent_id": agent_id, "args": call["args"]},
                ))
            self.emit_agent_checkpoint()
            return
        if item_type == "tool_call_output_item":
            output = sdk_tool_output_data(item)
            call_id = output["call_id"]
            tool_name = self.tool_names_by_call_id.get(call_id) or output["tool_name"]
            args = self.tool_args_by_call_id.get(call_id, {})
            event_agent_id = self.tool_agent_by_call_id.get(call_id, agent_id)
            parsed_output = parse_json_value(output["output"])
            status_value = tool_status_value(parsed_output)
            self.update_agent_activity(event_agent_id, tool_name, args, status_value, parsed_output)
            if (
                tool_name == "finish_scan"
                and status_value == "done"
                and isinstance(parsed_output, dict)
                and parsed_output.get("scan_completed")
                and self.scan_completed_callback is not None
            ):
                self.scan_completed_callback()
            if should_emit_tool_output(tool_name, status_value):
                self.emit(tool_output(
                    self.task,
                    tool_name=tool_name,
                    tool_run_id=call_id,
                    status_value=status_value,
                    line=tool_result_summary(tool_name, parsed_output),
                    metadata={"agent_id": event_agent_id, "args": args, "result": parsed_output},
                ))
            self.emit_agent_checkpoint()

    def ensure_agent(self, agent_id: str, *, parent_id: str | None = None, name: str | None = None, task: str = "", skills: list[str] | None = None) -> dict[str, Any]:
        agent = self.agents_by_id.get(agent_id)
        if agent is None:
            agent = {
                "id": agent_id,
                "name": name or ("strix" if not parent_id else agent_id),
                "status": "running",
                "parent_id": parent_id,
                "task": task,
                "skills": list(skills or []),
                "pending_count": 0,
                "role": "child" if parent_id else "main",
                "current_tool": "",
                "current_action": "Starting scan" if not parent_id else "Starting task",
            }
            self.agents_by_id[agent_id] = agent
            return agent
        if name:
            agent["name"] = name
        if parent_id is not None:
            agent["parent_id"] = parent_id
            agent["role"] = "child"
        if task:
            agent["task"] = task
        if skills is not None:
            agent["skills"] = list(skills)
        return agent

    def update_agent_activity(self, agent_id: str, tool_name: str, args: dict[str, Any], status_value: str, result: Any = None) -> None:
        agent = self.ensure_agent(agent_id)
        agent["current_tool"] = tool_name
        agent["current_action"] = tool_call_summary(tool_name, args) if status_value == "running" else tool_result_summary(tool_name, result)
        if status_value == "skipped" and agent.get("status") not in TERMINAL_AGENT_ACTIVITY_STATUSES:
            agent["status"] = "running"
        elif tool_name == "agent_finish" and status_value == "done":
            agent["status"] = "completed"
        elif tool_name == "finish_scan" and status_value == "done":
            agent["status"] = "completed"
        elif agent.get("status") not in TERMINAL_AGENT_ACTIVITY_STATUSES:
            agent["status"] = "running"

        if tool_name == "create_agent" and status_value == "done" and isinstance(result, dict) and result.get("success") is not False:
            child_id = string_value(result.get("agent_id"))
            if child_id:
                self.ensure_agent(
                    child_id,
                    parent_id=agent_id,
                    name=first_present(args, "name") or string_value(result.get("name")) or child_id,
                    task=first_present(args, "task"),
                    skills=list(args.get("skills") or []) if isinstance(args.get("skills"), list) else [],
                )

    def vulnerability_found(self, report: dict[str, Any]) -> None:
        vuln_id = str(report.get("id") or "")
        if vuln_id and vuln_id in self.sent_vulnerability_ids:
            return
        if vuln_id:
            self.sent_vulnerability_ids.add(vuln_id)
        evidence_id = f"strix-{safe_id(self.task.get('task_id', 'task'))}-{safe_id(vuln_id or report.get('title') or 'finding')}"
        target = str(report.get("target") or extract_target(self.task) or "unknown")
        report_evidence_ids = [
            str(eid)
            for eid in (report.get("evidence_ids") if isinstance(report.get("evidence_ids"), list) else [])
            if str(eid).strip()
        ]
        validation_evidence_ids = [
            str(eid)
            for eid in (report.get("validation_evidence_ids") if isinstance(report.get("validation_evidence_ids"), list) else [])
            if str(eid).strip()
        ]
        self.emit({
            "type": "evidence_created",
            "conversation_id": self.task["conversation_id"],
            "task_id": self.task["task_id"],
            "evidence_id": evidence_id,
            "evidence_type": "strix_vulnerability_report",
            "source_tool": "strix",
            "content": json.dumps(report, ensure_ascii=False, indent=2),
            "metadata": {"strix_vulnerability": report},
        })
        self._emit_memory_evidence(report_evidence_ids + validation_evidence_ids)
        self.emit(text(
            self.task,
            f"发现并记录漏洞：{str(report.get('title') or 'Strix vulnerability')}（{normalize_severity(report.get('severity'))}）",
            metadata={"vulnerability_id": vuln_id},
        ))
        event_evidence_ids = report_evidence_ids or [evidence_id]
        self.emit({
            "type": "vuln_found",
            "conversation_id": self.task["conversation_id"],
            "task_id": self.task["task_id"],
            "vulnerability_id": evidence_id,
            "strix_vulnerability_id": vuln_id,
            "title": str(report.get("title") or "Strix vulnerability"),
            "severity": normalize_severity(report.get("severity")),
            "status": "confirmed",
            "target": target,
            "url": target,
            "location": str(report.get("endpoint") or target),
            "affected_asset": target,
            "description": first_text(report, "description", "technical_analysis", "impact", "poc_description"),
            "technical_analysis": str(report.get("technical_analysis") or ""),
            "impact": str(report.get("impact") or ""),
            "poc": first_text(report, "poc_description", "poc_script_code"),
            "poc_description": str(report.get("poc_description") or ""),
            "poc_script_code": str(report.get("poc_script_code") or ""),
            "remediation": first_text(report, "remediation", "remediation_steps"),
            "remediation_steps": str(report.get("remediation_steps") or ""),
            "evidence_ids": event_evidence_ids,
            "validation_agent_id": report.get("validation_agent_id"),
            "validation_evidence_ids": validation_evidence_ids,
            "cvss": report.get("cvss"),
            "cvss_breakdown": report.get("cvss_breakdown"),
            "cve_id": report.get("cve"),
            "cwe": report.get("cwe"),
            "endpoint": report.get("endpoint"),
            "method": report.get("method"),
            "agent_id": report.get("agent_id"),
            "agent_name": report.get("agent_name"),
            "timestamp": report.get("timestamp"),
        })

    def _emit_memory_evidence(self, evidence_ids: list[str]) -> None:
        if not self.run_dir:
            return
        wanted = {str(eid).strip() for eid in evidence_ids if str(eid).strip()}
        if not wanted:
            return
        records = {
            str(item.get("evidence_id") or ""): item
            for item in evidence_from_file(Path(self.run_dir) / ".state" / "evidence.json")
            if str(item.get("evidence_id") or "") in wanted
        }
        for evidence_id in sorted(wanted):
            item = records.get(evidence_id)
            if not item:
                continue
            metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            self.emit({
                "type": "evidence_created",
                "conversation_id": self.task["conversation_id"],
                "task_id": self.task["task_id"],
                "evidence_id": evidence_id,
                "evidence_type": str(item.get("evidence_type") or "other"),
                "source_tool": item.get("source_tool") or "strix_memory",
                "target": item.get("target"),
                "summary": str(item.get("summary") or ""),
                "content": str(item.get("content") or ""),
                "metadata": {**metadata, "strix_memory_evidence": item},
            })


async def emit_final_artifacts(ws: Any, task: dict[str, Any], run_name: str, report_state: ReportState) -> None:
    run_dir = report_state.get_run_dir()
    report_path = run_dir / "penetration_test_report.md"
    content = ""
    if report_path.exists():
        content = report_path.read_text(encoding="utf-8", errors="replace")
    elif report_state.final_scan_result:
        content = report_state.final_scan_result
    if content:
        await send(ws, {
            "type": "evidence_created",
            "conversation_id": task["conversation_id"],
            "task_id": task["task_id"],
            "evidence_id": f"strix-{safe_id(run_name)}-report",
            "evidence_type": "strix_report",
            "source_tool": "strix",
            "content": content,
            "metadata": {"run_name": run_name, "run_dir": str(run_dir)},
        })


def text(task: dict[str, Any], value: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    content: dict[str, Any] = {"text": value}
    if metadata:
        content["metadata"] = metadata
    return {
        "type": "text",
        "conversation_id": task["conversation_id"],
        "task_id": task["task_id"],
        "content": content,
    }


def tool_output(
    task: dict[str, Any],
    *,
    tool_name: str,
    tool_run_id: str,
    status_value: str,
    line: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = metadata or {}
    args = metadata.get("args") if isinstance(metadata.get("args"), dict) else {}
    result = metadata.get("result")
    event: dict[str, Any] = {
        "type": "tool_output",
        "conversation_id": task["conversation_id"],
        "task_id": task["task_id"],
        "tool_name": tool_name,
        "tool_run_id": tool_run_id,
        "status": status_value,
        "line": line,
        "summary": line,
        "stdout": line if status_value != "running" else "",
        "display_title": friendly_tool_name(tool_name),
        "category": tool_category(tool_name),
        "metadata": metadata,
    }
    target = tool_target(tool_name, args, result)
    if target:
        event["target"] = target
    command = tool_command(tool_name, args, result)
    if command:
        event["command"] = command
    if args:
        event["args"] = args
    if isinstance(result, dict):
        event["result"] = summarize_result_payload(result)
    elif isinstance(result, str) and result.strip():
        event["result_text"] = result[:MAX_TOOL_OUTPUT_CHARS]
    return {
        **event,
    }


def checkpoint(
    task: dict[str, Any],
    run_name: str,
    run_dir: str,
    agents: list[dict[str, Any]] | None = None,
    todos: list[dict[str, Any]] | None = None,
    notes: list[dict[str, Any]] | None = None,
    attack_surface: list[dict[str, Any]] | None = None,
    hypotheses: list[dict[str, Any]] | None = None,
    coverage: list[dict[str, Any]] | None = None,
    evidence: list[dict[str, Any]] | None = None,
    vulnerabilities: list[dict[str, Any]] | None = None,
    run: dict[str, Any] | None = None,
) -> dict[str, Any]:
    node3_strix: dict[str, Any] = {"run_name": run_name, "run_dir": run_dir}
    if run:
        node3_strix["run"] = run
    if agents:
        node3_strix["agents"] = normalize_agent_graph(agents)
    if todos:
        node3_strix["todos"] = normalize_todos(todos)
    if notes:
        node3_strix["notes"] = normalize_notes(notes)
    if attack_surface:
        node3_strix["attack_surface"] = normalize_attack_surface(attack_surface)
    if hypotheses:
        node3_strix["hypotheses"] = normalize_hypotheses(hypotheses)
    if coverage:
        node3_strix["coverage"] = normalize_coverage(coverage)
    if evidence:
        node3_strix["evidence"] = normalize_evidence(evidence)
    if vulnerabilities:
        node3_strix["vulnerabilities"] = normalize_vulnerabilities(vulnerabilities)
    return {
        "type": "checkpoint_update",
        "conversation_id": task["conversation_id"],
        "task_id": task["task_id"],
        "checkpoint": {"node3_strix": node3_strix},
    }


def runtime_checkpoint(
    task: dict[str, Any],
    run_name: str,
    run_dir: str,
    *,
    fallback_agents: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    run_path = Path(run_dir)
    state_dir = run_path / ".state"
    snapshot_agents = agent_graph_from_file(state_dir / "agents.json")
    reconcile_terminal_bound_todos(state_dir, snapshot_agents)
    agents = merge_agent_activity(
        snapshot_agents,
        list(fallback_agents or []),
    )
    vulnerabilities = vulnerabilities_from_file(run_path / "vulnerabilities.json")
    run_summary = run_summary_from_file(run_path / "run.json")
    return checkpoint(
        task,
        run_name,
        run_dir,
        run=run_summary,
        agents=agents,
        todos=todos_from_file(
            state_dir / "todos.json",
            platform_visible=True,
            agents=agents,
        ),
        notes=notes_from_file(state_dir / "notes.json"),
        attack_surface=attack_surface_from_file(state_dir / "attack_surface.json"),
        hypotheses=hypotheses_from_file(state_dir / "hypotheses.json"),
        coverage=coverage_from_file(state_dir / "coverage.json"),
        evidence=evidence_from_file(state_dir / "evidence.json"),
        vulnerabilities=vulnerabilities,
    )


def reconcile_terminal_bound_todos(state_dir: Path, agents: list[dict[str, Any]]) -> None:
    agent_statuses = {
        string_value(agent.get("id") or agent.get("agent_id")): string_value(agent.get("status"))
        for agent in agents
        if string_value(agent.get("id") or agent.get("agent_id"))
    }
    if not agent_statuses:
        return
    try:
        from strix.tools.todo.tools import (
            hydrate_todos_from_disk,
            reconcile_bound_todos_with_agent_statuses,
        )

        hydrate_todos_from_disk(state_dir)
        reconcile_bound_todos_with_agent_statuses(agent_statuses)
    except Exception:
        return


def agent_graph_from_file(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(raw, dict):
        return []
    return normalize_agent_graph(raw)


def merge_agent_activity(
    snapshot_agents: list[dict[str, Any]],
    runtime_agents: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not snapshot_agents:
        return runtime_agents
    if not runtime_agents:
        return snapshot_agents
    runtime_by_id = {
        string_value(agent.get("id") or agent.get("agent_id")): agent
        for agent in runtime_agents
        if string_value(agent.get("id") or agent.get("agent_id"))
    }
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for agent in snapshot_agents:
        agent_id = string_value(agent.get("id") or agent.get("agent_id"))
        runtime = runtime_by_id.get(agent_id)
        if not runtime:
            merged.append(agent)
            if agent_id:
                seen.add(agent_id)
            continue
        item = dict(agent)
        for key in ("current_tool", "current_action", "pending_count"):
            value = runtime.get(key)
            if value not in (None, ""):
                item[key] = value
        runtime_status = string_value(runtime.get("status"))
        snapshot_status = string_value(item.get("status"))
        if runtime_status in {"crashed", "stopped"} or (
            snapshot_status not in TERMINAL_AGENT_ACTIVITY_STATUSES
            and runtime_status
            and runtime_status != "failed"
        ):
            if runtime_status:
                item["status"] = runtime_status
        for key in ("name", "task", "skills", "parent_id", "role"):
            if not item.get(key) and runtime.get(key) not in (None, ""):
                item[key] = runtime.get(key)
        merged.append(item)
        if agent_id:
            seen.add(agent_id)
    merged.extend(agent for agent_id, agent in runtime_by_id.items() if agent_id not in seen)
    return sort_agent_items([normalize_agent_item(agent) for agent in merged if isinstance(agent, dict)])


def todos_from_file(
    path: Path,
    *,
    platform_visible: bool = False,
    agents: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    raw = json_from_file(path)
    root_agent_ids: set[str] | None = None
    if platform_visible:
        graph = agents if agents is not None else agent_graph_from_file(path.with_name("agents.json"))
        root_agent_ids = {
            str(agent.get("id") or agent.get("agent_id") or "")
            for agent in graph
            if str(agent.get("id") or agent.get("agent_id") or "").strip()
            and not str(agent.get("parent_id") or "").strip()
        }
    return normalize_todos(raw, root_agent_ids=root_agent_ids, platform_visible=platform_visible)


def notes_from_file(path: Path) -> list[dict[str, Any]]:
    raw = json_from_file(path)
    return normalize_notes(raw)


def vulnerabilities_from_file(path: Path) -> list[dict[str, Any]]:
    raw = json_from_file(path)
    return normalize_vulnerabilities(raw)


def run_summary_from_file(path: Path) -> dict[str, Any]:
    raw = json_from_file(path)
    if not isinstance(raw, dict):
        return {}
    return normalize_run_summary(raw)


def json_from_file(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def normalize_agent_graph(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        items = [normalize_agent_item(item) for item in raw if isinstance(item, dict)]
        return sort_agent_items([item for item in items if item])
    if not isinstance(raw, dict):
        return []

    statuses = raw.get("statuses") if isinstance(raw.get("statuses"), dict) else {}
    parent_of = raw.get("parent_of") if isinstance(raw.get("parent_of"), dict) else {}
    names = raw.get("names") if isinstance(raw.get("names"), dict) else {}
    metadata = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
    pending_counts = raw.get("pending_counts") if isinstance(raw.get("pending_counts"), dict) else {}
    ids = set(statuses) | set(parent_of) | set(names) | set(metadata) | set(pending_counts)
    items = []
    for agent_id in ids:
        md = metadata.get(agent_id) if isinstance(metadata.get(agent_id), dict) else {}
        parent_id = parent_of.get(agent_id)
        items.append(normalize_agent_item({
            "id": agent_id,
            "name": names.get(agent_id) or agent_id,
            "status": statuses.get(agent_id) or "running",
            "parent_id": parent_id,
            "task": md.get("task") or "",
            "skills": md.get("skills") if isinstance(md.get("skills"), list) else [],
            "pending_count": pending_counts.get(agent_id) or 0,
            "role": "child" if parent_id else "main",
        }))
    return sort_agent_items([item for item in items if item])


def normalize_agent_item(item: dict[str, Any]) -> dict[str, Any]:
    agent_id = string_value(item.get("id") or item.get("agent_id"))
    if not agent_id:
        return {}
    parent_id = string_value(item.get("parent_id"))
    skills = item.get("skills") if isinstance(item.get("skills"), list) else []
    return {
        "id": agent_id,
        "name": string_value(item.get("name")) or agent_id,
        "status": string_value(item.get("status")) or "running",
        "parent_id": parent_id or None,
        "task": string_value(item.get("task")),
        "skills": [str(skill) for skill in skills[:12] if str(skill).strip()],
        "pending_count": int(item.get("pending_count") or 0),
        "role": string_value(item.get("role")) or ("child" if parent_id else "main"),
        "current_tool": string_value(item.get("current_tool")),
        "current_action": string_value(item.get("current_action")),
    }


def sort_agent_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {item["id"]: item for item in items}

    def depth(item: dict[str, Any]) -> int:
        count = 0
        parent_id = item.get("parent_id")
        seen = set()
        while parent_id and parent_id in by_id and parent_id not in seen:
            seen.add(parent_id)
            count += 1
            parent_id = by_id[parent_id].get("parent_id")
        return count

    return sorted(items, key=lambda item: (depth(item), str(item.get("parent_id") or ""), str(item.get("name") or ""), str(item.get("id") or "")))


def normalize_todos(
    raw: Any,
    *,
    root_agent_ids: set[str] | None = None,
    platform_visible: bool = False,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if isinstance(raw, list):
        candidates = [
            (index, None, item.get("id"), item)
            for index, item in enumerate(raw)
            if isinstance(item, dict)
        ]
    elif isinstance(raw, dict):
        candidates = []
        index = 0
        for agent_id, agent_todos in raw.items():
            if isinstance(agent_todos, dict):
                for todo_id, item in agent_todos.items():
                    if isinstance(item, dict):
                        candidates.append((index, str(agent_id), todo_id, item))
                        index += 1
            elif isinstance(agent_todos, list):
                for item in agent_todos:
                    if isinstance(item, dict):
                        candidates.append((index, str(agent_id), item.get("id"), item))
                        index += 1
    else:
        candidates = []

    for source_index, agent_id, todo_id, item in candidates:
        normalized_agent_id = string_value(item.get("agent_id") or agent_id)
        if platform_visible and root_agent_ids and normalized_agent_id not in root_agent_ids:
            continue
        if _is_internal_tracking_todo(item, platform_visible=platform_visible):
            continue
        raw_order = item.get("order_index")
        try:
            order_index = int(raw_order)
        except (TypeError, ValueError):
            order_index = source_index
        normalized = {
            "id": string_value(item.get("id") or todo_id) or safe_id(item.get("title") or "todo"),
            "agent_id": normalized_agent_id,
            "title": string_value(item.get("title")) or "Untitled task",
            "description": string_value(item.get("description")),
            "priority": string_value(item.get("priority")) or "normal",
            "status": normalize_todo_status(item.get("status")),
            "order_index": order_index,
            "created_at": string_value(item.get("created_at")),
            "updated_at": string_value(item.get("updated_at")),
            "completed_at": string_value(item.get("completed_at")),
            "started_at": string_value(item.get("started_at")),
            "linked_agent_id": string_value(item.get("linked_agent_id")),
            "parent_todo_id": string_value(item.get("parent_todo_id")),
            "resolution_reason": string_value(item.get("resolution_reason")),
            "surface_id": string_value(item.get("surface_id")),
            "endpoint": string_value(item.get("endpoint")),
            "method": string_value(item.get("method")),
            "parameter": string_value(item.get("parameter")),
            "vuln_type": string_value(item.get("vuln_type")),
            "auth_state": string_value(item.get("auth_state")),
            "archived_at": string_value(item.get("archived_at")),
        }
        items.append(normalized)
    return sorted(items, key=lambda item: (int(item.get("order_index") or 0), str(item.get("created_at") or ""), str(item.get("id") or "")))


def _is_internal_tracking_todo(item: dict[str, Any], *, platform_visible: bool = False) -> bool:
    if item.get("internal_tracking"):
        return True
    if platform_visible and string_value(item.get("linked_agent_id")):
        return True
    return bool(string_value(item.get("linked_agent_id"))) and bool(string_value(item.get("parent_todo_id")))


def normalize_notes(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        candidates = [(item.get("id"), item) for item in raw if isinstance(item, dict)]
    elif isinstance(raw, dict):
        candidates = [(note_id, item) for note_id, item in raw.items() if isinstance(item, dict)]
    else:
        candidates = []
    items = []
    for note_id, item in candidates:
        tags = item.get("tags") if isinstance(item.get("tags"), list) else []
        items.append({
            "id": string_value(item.get("id") or note_id) or safe_id(item.get("title") or "note"),
            "title": string_value(item.get("title")) or "Untitled note",
            "content": string_value(item.get("content")),
            "category": string_value(item.get("category")),
            "tags": [str(tag) for tag in tags[:12] if str(tag).strip()],
            "created_at": string_value(item.get("created_at")),
            "updated_at": string_value(item.get("updated_at")),
        })
    return sorted(items, key=lambda item: str(item.get("created_at") or ""))


def normalize_attack_surface(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, dict):
        raw_items = raw.get("attack_surface") or raw.get("items") or list(raw.values())
    else:
        raw_items = raw
    if not isinstance(raw_items, list):
        return []
    items = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        params = item.get("parameters") if isinstance(item.get("parameters"), list) else []
        evidence_ids = item.get("evidence_ids") if isinstance(item.get("evidence_ids"), list) else []
        items.append({
            "surface_id": string_value(item.get("surface_id") or item.get("id")) or safe_id(item.get("url") or item.get("address") or "surface"),
            "kind": string_value(item.get("kind")) or "other",
            "method": string_value(item.get("method")),
            "url": string_value(item.get("url")),
            "address": string_value(item.get("address")),
            "parameters": [str(param) for param in params[:30] if str(param).strip()],
            "auth_state": string_value(item.get("auth_state")),
            "role": string_value(item.get("role")),
            "source": string_value(item.get("source")),
            "evidence_ids": [str(eid) for eid in evidence_ids[:20] if str(eid).strip()],
            "phase": string_value(item.get("phase")),
            "notes": string_value(item.get("notes")),
            "agent_id": string_value(item.get("agent_id")),
            "created_at": string_value(item.get("created_at")),
            "updated_at": string_value(item.get("updated_at")),
        })
    return sorted(items, key=lambda item: str(item.get("created_at") or ""))


def normalize_hypotheses(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, dict):
        raw_items = raw.get("hypotheses") or raw.get("items") or list(raw.values())
    else:
        raw_items = raw
    if not isinstance(raw_items, list):
        return []
    items = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        evidence_ids = item.get("evidence_ids") if isinstance(item.get("evidence_ids"), list) else []
        coverage_ids = item.get("coverage_ids") if isinstance(item.get("coverage_ids"), list) else []
        items.append({
            "hypothesis_id": string_value(item.get("hypothesis_id") or item.get("id")) or safe_id(item.get("hypothesis") or "hypothesis"),
            "surface_id": string_value(item.get("surface_id")),
            "endpoint": string_value(item.get("endpoint")),
            "method": string_value(item.get("method")),
            "parameter": string_value(item.get("parameter")) or "<none>",
            "vuln_type": string_value(item.get("vuln_type")),
            "auth_state": string_value(item.get("auth_state")),
            "phase": string_value(item.get("phase")),
            "hypothesis": string_value(item.get("hypothesis")),
            "test_strategy": string_value(item.get("test_strategy")),
            "risk_reason": string_value(item.get("risk_reason")),
            "status": string_value(item.get("status")) or "planned",
            "evidence_ids": [str(eid) for eid in evidence_ids[:20] if str(eid).strip()],
            "coverage_ids": [str(cid) for cid in coverage_ids[:20] if str(cid).strip()],
            "notes": string_value(item.get("notes")),
            "agent_id": string_value(item.get("agent_id")),
            "created_at": string_value(item.get("created_at")),
            "updated_at": string_value(item.get("updated_at")),
        })
    return sorted(items, key=lambda item: str(item.get("created_at") or ""))


def normalize_coverage(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, dict):
        raw_items = raw.get("coverage") or raw.get("items") or list(raw.values())
    else:
        raw_items = raw
    if not isinstance(raw_items, list):
        return []
    items = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        evidence_ids = item.get("evidence_ids") if isinstance(item.get("evidence_ids"), list) else []
        items.append({
            "coverage_id": string_value(item.get("coverage_id") or item.get("id")) or safe_id(item.get("endpoint") or "coverage"),
            "endpoint": string_value(item.get("endpoint")),
            "parameter": string_value(item.get("parameter")) or "<none>",
            "vuln_type": string_value(item.get("vuln_type")),
            "status": string_value(item.get("status")) or "planned",
            "auth_state": string_value(item.get("auth_state")),
            "hypothesis_id": string_value(item.get("hypothesis_id")),
            "phase": string_value(item.get("phase")),
            "evidence_ids": [str(eid) for eid in evidence_ids[:20] if str(eid).strip()],
            "result": string_value(item.get("result")),
            "notes": string_value(item.get("notes")),
            "agent_id": string_value(item.get("agent_id")),
            "created_at": string_value(item.get("created_at")),
            "updated_at": string_value(item.get("updated_at")),
        })
    return sorted(items, key=lambda item: str(item.get("created_at") or ""))


def normalize_evidence(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, dict):
        raw_items = raw.get("evidence") or raw.get("items") or list(raw.values())
    else:
        raw_items = raw
    if not isinstance(raw_items, list):
        return []
    items = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        items.append({
            "evidence_id": string_value(item.get("evidence_id") or item.get("id")) or safe_id(item.get("summary") or "evidence"),
            "evidence_type": string_value(item.get("evidence_type")) or "other",
            "summary": string_value(item.get("summary")),
            "content": string_value(item.get("content"))[:MAX_TOOL_OUTPUT_CHARS],
            "source_tool": string_value(item.get("source_tool")),
            "target": string_value(item.get("target")),
            "phase": string_value(item.get("phase")),
            "metadata": item.get("metadata") if isinstance(item.get("metadata"), dict) else {},
            "agent_id": string_value(item.get("agent_id")),
            "created_at": string_value(item.get("created_at")),
            "updated_at": string_value(item.get("updated_at")),
        })
    return sorted(items, key=lambda item: str(item.get("created_at") or ""))


def normalize_vulnerabilities(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, dict):
        raw_items = raw.get("vulnerabilities") or raw.get("reports") or raw.get("items") or []
    else:
        raw_items = raw
    if not isinstance(raw_items, list):
        return []
    return [normalize_vulnerability(item) for item in raw_items if isinstance(item, dict)]


def normalize_vulnerability(item: dict[str, Any]) -> dict[str, Any]:
    evidence_ids = item.get("evidence_ids") if isinstance(item.get("evidence_ids"), list) else []
    validation_evidence_ids = item.get("validation_evidence_ids") if isinstance(item.get("validation_evidence_ids"), list) else []
    return {
        "id": string_value(item.get("id")) or safe_id(item.get("title") or "finding"),
        "title": string_value(item.get("title")) or "Untitled vulnerability",
        "severity": normalize_severity(item.get("severity")),
        "timestamp": string_value(item.get("timestamp")),
        "description": string_value(item.get("description")),
        "impact": string_value(item.get("impact")),
        "target": string_value(item.get("target")),
        "technical_analysis": string_value(item.get("technical_analysis")),
        "poc_description": string_value(item.get("poc_description")),
        "poc_script_code": string_value(item.get("poc_script_code")),
        "remediation_steps": string_value(item.get("remediation_steps")),
        "cvss": item.get("cvss"),
        "cvss_breakdown": item.get("cvss_breakdown") if isinstance(item.get("cvss_breakdown"), dict) else {},
        "endpoint": string_value(item.get("endpoint")),
        "method": string_value(item.get("method")),
        "cve_id": string_value(item.get("cve") or item.get("cve_id")),
        "cwe": string_value(item.get("cwe")),
        "evidence_ids": [str(eid) for eid in evidence_ids[:20] if str(eid).strip()],
        "validation_agent_id": string_value(item.get("validation_agent_id")),
        "validation_evidence_ids": [str(eid) for eid in validation_evidence_ids[:20] if str(eid).strip()],
        "agent_id": string_value(item.get("agent_id")),
        "agent_name": string_value(item.get("agent_name")),
    }


def normalize_run_summary(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "run_id": string_value(raw.get("run_id")),
        "run_name": string_value(raw.get("run_name")),
        "status": string_value(raw.get("status")),
        "start_time": string_value(raw.get("start_time")),
        "end_time": string_value(raw.get("end_time")),
        "scan_mode": string_value(raw.get("scan_mode")),
        "targets_info": normalize_targets_info(raw.get("targets_info")),
        "llm_usage": normalize_llm_usage(raw.get("llm_usage")),
    }


def normalize_targets_info(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    targets = []
    for item in raw[:12]:
        if not isinstance(item, dict):
            continue
        details = item.get("details") if isinstance(item.get("details"), dict) else {}
        target_value = first_present(details, "target_url", "target_repo", "target_path", "target_host") or string_value(item.get("original"))
        targets.append({
            "type": string_value(item.get("type")) or "target",
            "target": target_value,
            "original": string_value(item.get("original")) or target_value,
        })
    return targets


def normalize_llm_usage(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    agent_usages = raw.get("agent_usages") if isinstance(raw.get("agent_usages"), list) else []
    return {
        "requests": int(raw.get("requests") or 0),
        "input_tokens": int(raw.get("input_tokens") or 0),
        "cached_tokens": usage_detail_total(raw.get("input_tokens_details"), "cached_tokens"),
        "output_tokens": int(raw.get("output_tokens") or 0),
        "reasoning_tokens": usage_detail_total(raw.get("output_tokens_details"), "reasoning_tokens"),
        "total_tokens": int(raw.get("total_tokens") or 0),
        "cost": float(raw.get("cost") or 0),
        "agent_count": len([item for item in agent_usages if isinstance(item, dict)]),
    }


def usage_detail_total(raw: Any, key: str) -> int:
    if isinstance(raw, dict):
        return int(raw.get(key) or 0)
    if isinstance(raw, list):
        total = 0
        for item in raw:
            if isinstance(item, dict):
                total += int(item.get(key) or 0)
        return total
    return 0


def normalize_todo_status(value: Any) -> str:
    status = str(value or "pending").strip().lower()
    if status in {"done", "complete", "completed"}:
        return "done"
    if status in {"in_progress", "working"}:
        return "running"
    if status in {"blocked", "failed", "skipped", "running", "pending", "todo"}:
        return status
    return "pending"


def priority_rank(value: Any) -> int:
    return {"critical": 0, "high": 1, "medium": 2, "normal": 3, "low": 4}.get(str(value or "").lower(), 3)


async def send(ws: Any, message: dict[str, Any]) -> None:
    await ws.send(json.dumps(message, ensure_ascii=False))


def sdk_tool_call_data(item: Any) -> dict[str, Any]:
    raw = getattr(item, "raw_item", None)
    call_id = str(raw_field(raw, "call_id") or raw_field(raw, "id") or id(item))
    tool_name = str(raw_field(raw, "name") or raw_field(raw, "type") or getattr(item, "title", None) or "tool")
    return {"call_id": call_id, "tool_name": tool_name, "args": parse_json_object(raw_field(raw, "arguments"))}


def sdk_tool_output_data(item: Any) -> dict[str, Any]:
    raw = getattr(item, "raw_item", None)
    call_id = str(raw_field(raw, "call_id") or raw_field(raw, "id") or id(item))
    return {
        "call_id": call_id,
        "tool_name": str(raw_field(raw, "name") or raw_field(raw, "type") or "tool"),
        "output": getattr(item, "output", raw_field(raw, "output")),
    }


def sdk_message_text(item: Any) -> str:
    raw = getattr(item, "raw_item", None)
    return message_content_text(raw_field(raw, "content", []))


def message_content_text(content: Any) -> str:
    parts: list[str] = []
    content_items = content if isinstance(content, list) else [content]
    for part in content_items:
        if isinstance(part, str):
            parts.append(part)
            continue
        text_value = raw_field(part, "text")
        if isinstance(text_value, str):
            parts.append(text_value)
    return "".join(parts)


def raw_field(raw: Any, key: str, default: Any = None) -> Any:
    if isinstance(raw, dict):
        return raw.get(key, default)
    return getattr(raw, key, default)


def parse_json_object(value: Any) -> dict[str, Any]:
    parsed = parse_json_value(value)
    return parsed if isinstance(parsed, dict) else {}


def parse_json_value(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def tool_status_value(result: Any) -> str:
    if isinstance(result, dict) and result.get("success") is False:
        return "failed"
    status = str(result.get("status") or "").strip().lower() if isinstance(result, dict) else ""
    if status in {"skipped_duplicate", "skipped", "duplicate"}:
        return "skipped"
    return "done"


def should_emit_tool_output(tool_name: str, status_value: str) -> bool:
    if tool_name == "write_stdin" and status_value != "failed":
        return False
    return True


def short_value(value: Any) -> str:
    if isinstance(value, str):
        text_value = value
    else:
        text_value = json.dumps(value, ensure_ascii=False, default=str)
    return text_value[:MAX_TOOL_OUTPUT_CHARS]


def tool_call_summary(tool_name: str, args: dict[str, Any]) -> str:
    name = friendly_tool_name(tool_name)
    if tool_name == "exec_command":
        return "Running shell command"
    if tool_name == "write_stdin":
        return "Sending command input"
    if tool_name == "create_agent":
        return "Creating sub-agent"
    if tool_name == "load_skill":
        return "Loading selected skills"
    if tool_name == "create_vulnerability_report":
        return "Reporting finding"
    if tool_name == "agent_finish":
        return "Sub-agent finishing with results"
    if tool_name == "finish_scan":
        return "Preparing final Strix report"
    if tool_name in {"list_requests", "list_sitemap", "scope_rules", "view_agent_graph", "list_todos", "list_notes"}:
        return f"{name} started"
    return f"{name} started"


def tool_start_progress(tool_name: str, args: dict[str, Any]) -> str:
    return ""


def important_tool_progress(tool_name: str, args: dict[str, Any]) -> str:
    return ""


def tool_result_summary(tool_name: str, result: Any) -> str:
    name = friendly_tool_name(tool_name)
    if isinstance(result, dict):
        if result.get("status") in {"skipped_duplicate", "skipped", "duplicate"}:
            return f"{name} skipped: {first_present(result, 'message', 'reason', 'error') or 'duplicate'}"
        if result.get("success") is False:
            detail = first_present(result, "error", "message", "reason") or "see details"
            errors = result.get("errors")
            if isinstance(errors, list) and errors:
                detail = f"{detail}: {'; '.join(str(item) for item in errors[:3])}"
            return f"{name} failed: {detail}"
        if tool_name == "create_vulnerability_report":
            title = first_present(result, "message", "report_id")
            return f"Finding reported: {title}" if title else "Finding reported"
        if tool_name == "finish_scan":
            return "Final report generated"
        if tool_name == "create_agent":
            return f"Sub-agent created: {first_present(result, 'agent_id', 'name') or 'agent'}"
        if tool_name == "send_message_to_agent":
            return "Message sent to sub-agent"
        if tool_name == "wait_for_message":
            return first_present(result, "message", "wait_outcome") or "Sub-agent response received"
        if tool_name == "agent_finish":
            return f"Sub-agent finished: {first_present(result, 'summary', 'result_summary', 'message') or 'results returned'}"
        summary = first_present(result, "message", "summary", "status", "title")
        if summary:
            return f"{name}: {summary}"
    if isinstance(result, str) and result.strip():
        parsed = parse_json_value(result)
        if parsed is not result:
            return tool_result_summary(tool_name, parsed)
        if tool_name == "exec_command":
            return summarize_command_output(result)
        if tool_name == "write_stdin":
            return summarize_command_output(result, prefix="Command output")
        return f"{name}: {result.strip()[:240]}"
    return f"{name} completed"


def friendly_tool_name(tool_name: str) -> str:
    return {
        "exec_command": "Exec Command",
        "write_stdin": "Command Input",
        "think": "Planning",
        "load_skill": "Loading skill",
        "web_search": "Web search",
        "list_requests": "Reviewing traffic",
        "view_request": "Inspecting request",
        "repeat_request": "Repeating request",
        "list_sitemap": "Reviewing sitemap",
        "view_sitemap_entry": "Inspecting sitemap entry",
        "scope_rules": "Checking scope",
        "create_vulnerability_report": "Reporting finding",
        "finish_scan": "Finishing scan",
        "create_agent": "Creating sub-agent",
        "agent_finish": "Sub-agent report",
        "send_message_to_agent": "Messaging sub-agent",
        "wait_for_message": "Waiting for sub-agent",
        "view_agent_graph": "Reviewing agent graph",
        "create_todo": "Updating plan",
        "update_todo": "Updating plan",
        "mark_todo_done": "Updating plan",
        "list_todos": "Reviewing plan",
        "create_note": "Writing note",
        "update_note": "Updating note",
        "list_notes": "Reviewing notes",
        "record_evidence": "Recording evidence",
        "record_attack_surface": "Recording attack surface",
        "record_hypothesis": "Recording test hypothesis",
        "record_coverage": "Recording coverage",
        "list_memory": "Reviewing memory",
        "delete_todo": "Archiving todo",
    }.get(tool_name, tool_name.replace("_", " ").strip().title() or "Tool")


def tool_category(tool_name: str) -> str:
    lowered = tool_name.lower()
    if lowered in {"create_agent", "send_message_to_agent", "wait_for_message", "agent_finish", "view_agent_graph"}:
        return "agent"
    if "vulnerab" in lowered or "finding" in lowered or "finish_scan" == lowered:
        return "finding"
    if "request" in lowered or "sitemap" in lowered or "scope" in lowered:
        return "request"
    if "search" in lowered or "skill" in lowered:
        return "search"
    if "exec" in lowered or "stdin" in lowered or "shell" in lowered or "command" in lowered or "patch" in lowered:
        return "command"
    if "todo" in lowered or "note" in lowered or lowered == "think":
        return "planning"
    return "tool"


def tool_target(tool_name: str, args: dict[str, Any], result: Any) -> str:
    if tool_name == "create_agent":
        return first_present(args, "name")
    if tool_name == "create_vulnerability_report":
        return first_present(args, "title", "target", "endpoint")
    target = first_present(args, "url", "target", "endpoint", "path", "query", "message", "task")
    if target:
        return target
    if isinstance(result, dict):
        return first_present(result, "url", "target", "endpoint", "title", "message")
    return ""


def tool_command(tool_name: str, args: dict[str, Any], result: Any) -> str:
    if tool_name == "exec_command":
        return first_present(args, "cmd", "command")
    if tool_name == "write_stdin":
        session_id = first_present(args, "session_id")
        chars = first_present(args, "chars", "input")
        if session_id and chars:
            return f"stdin -> session {session_id}: {chars}"
        return chars or (f"stdin -> session {session_id}" if session_id else "")
    if isinstance(result, dict):
        return first_present(result, "command", "cmd")
    return ""


def summarize_result_payload(result: dict[str, Any]) -> dict[str, Any]:
    kept: dict[str, Any] = {}
    for key in (
        "success",
        "status",
        "status_code",
        "message",
        "summary",
        "title",
        "report_id",
        "agent_id",
        "name",
        "todo_id",
        "task_tracking",
        "completed_todo_ids",
        "wait_outcome",
        "result_summary",
        "findings",
        "error",
        "reason",
    ):
        value = result.get(key)
        if value is None:
            continue
        if isinstance(value, str):
            kept[key] = value[:MAX_TOOL_OUTPUT_CHARS]
        elif isinstance(value, (int, float, bool)):
            kept[key] = value
        elif isinstance(value, list):
            kept[key] = value[:20]
        elif isinstance(value, dict):
            kept[key] = {str(k): str(v)[:500] for k, v in list(value.items())[:20]}
    return kept


def summarize_command_output(output: str, prefix: str = "Command finished") -> str:
    clean = output.strip()
    code = ""
    match = re.search(r"Process exited with code\s+(-?\d+)", clean)
    if match:
        code = match.group(1)
    output_match = re.search(r"Output:\s*(.*)", clean, re.DOTALL)
    body = output_match.group(1).strip() if output_match else clean
    first_line = next((line.strip() for line in body.splitlines() if line.strip()), "")
    if code:
        return f"{prefix} (exit {code})" + (f": {first_line[:180]}" if first_line else "")
    if "Process running with session ID" in clean:
        session = re.search(r"session ID\s+(\d+)", clean)
        return f"Command still running" + (f" in session {session.group(1)}" if session else "")
    return f"{prefix}: {first_line[:180]}" if first_line else prefix


def first_present(mapping: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = mapping.get(key)
        if value is None:
            continue
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False, default=str)
        text_value = str(value).strip()
        if text_value:
            return text_value[:240]
    return ""


def extract_target(task: dict[str, Any]) -> str | None:
    target = task.get("target") if isinstance(task.get("target"), dict) else {}
    for key in ("value", "url", "address", "original"):
        value = string_value(target.get(key))
        if value:
            return value
    scope = task.get("scope") if isinstance(task.get("scope"), dict) else {}
    allow = scope.get("allow")
    if isinstance(allow, list):
        for item in allow:
            value = string_value(item)
            if value:
                return value
    snapshot = task.get("snapshot") if isinstance(task.get("snapshot"), dict) else {}
    checkpoint_data = snapshot.get("checkpoint") if isinstance(snapshot.get("checkpoint"), dict) else {}
    checkpoint_task = checkpoint_data.get("task") if isinstance(checkpoint_data.get("task"), dict) else {}
    checkpoint_target = checkpoint_task.get("target") if isinstance(checkpoint_task.get("target"), dict) else checkpoint_data.get("target")
    if isinstance(checkpoint_target, dict):
        value = string_value(checkpoint_target.get("value"))
        if value:
            return value
    for source in (checkpoint_task, checkpoint_data):
        if isinstance(source, dict):
            value = string_value(source.get("target_url") or source.get("target"))
            if value:
                return value
    match = re.search(r"https?://[^\s,;)\]}>'\"]+", str(task.get("instruction") or ""), re.IGNORECASE)
    return match.group(0).rstrip(".)]}") if match else None


def normalize_severity(value: Any) -> str:
    normalized = str(value or "medium").strip().lower()
    return normalized if normalized in {"critical", "high", "medium", "low", "info"} else "medium"


def first_text(mapping: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, list):
            value = "\n".join(str(item) for item in value)
        if value:
            return str(value)
    return ""


def string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def safe_id(value: Any) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(value)).strip("-")[:80] or "item"


def falsey(value: Any) -> bool:
    return str(value or "").strip().lower() in {"0", "false", "no", "off"}
