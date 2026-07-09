"""Multi-agent graph tools backed by AgentCoordinator."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, get_args
from urllib.parse import urlsplit, urlunsplit

from agents import RunContextWrapper, function_tool

from strix.core.agents import Status, coordinator_from_context
from strix.core.inputs import build_child_context_pack
from strix.core.task_shape import classify_child_task_shape, task_purpose_for_shape
from strix.skills import validate_requested_skills
from strix.tools.todo.tools import (
    active_parent_todo_id,
    bind_todo_to_agent,
    complete_bound_todos,
    create_bound_todo,
    get_todo,
    resolve_bound_todos,
    unfinished_todos_for_agent,
    validate_todo_exists,
)
from strix.tools.workflow import (
    is_recon_task,
    state_dir_from_raw,
    testing_preflight,
)


_ACTIVE_STATUSES: frozenset[str] = frozenset({"running", "waiting"})
_DUPLICATE_RELEVANT_STATUSES: frozenset[str] = frozenset({"running", "waiting", "completed", "failed", "crashed"})
_FAILED_RETRY_TERMS: tuple[str, ...] = (
    "after failure",
    "budget",
    "crashed",
    "failed",
    "follow-up",
    "narrower",
    "retry",
    "scoped",
    "smaller",
    "timeout",
    "token",
)


logger = logging.getLogger(__name__)


def _ctx(ctx: RunContextWrapper) -> dict[str, Any]:
    return ctx.context if isinstance(ctx.context, dict) else {}


def _normalize_task_signature(name: str, task: str) -> str:
    normalized = " ".join(f"{name} {task}".lower().split())
    return normalized[:4000]


_TASK_TARGET_RE = re.compile(
    r"(?:https?://[^\s,;)'\"`]+|/(?:[A-Za-z0-9_.~{}:-]+/?)+(?:\?[^\s,;)'\"`]+)?)",
)
_TASK_STOPWORDS = {
    "agent",
    "and",
    "any",
    "as",
    "at",
    "call",
    "candidate",
    "confirmed",
    "create",
    "evidence",
    "final",
    "finding",
    "findings",
    "for",
    "from",
    "get",
    "http",
    "https",
    "independently",
    "issue",
    "method",
    "new",
    "of",
    "on",
    "or",
    "post",
    "record",
    "report",
    "reporter",
    "reporting",
    "reproduce",
    "request",
    "response",
    "result",
    "same",
    "show",
    "status",
    "task",
    "test",
    "testing",
    "the",
    "this",
    "to",
    "tool",
    "url",
    "use",
    "validate",
    "validation",
    "validator",
    "verify",
    "with",
}
_VULN_TOPIC_ALIASES = {
    "sqli": {"sql", "injection"},
    "sql": {"sqli", "injection"},
    "xss": {"client", "script"},
    "idor": {"authorization", "access", "object"},
    "bfla": {"authorization", "access", "function"},
    "jwt": {"token", "session"},
    "xxe": {"xml", "parser", "file"},
    "ssrf": {"url", "server", "request"},
    "csrf": {"request", "forgery"},
}
_GENERIC_TOPIC_OVERLAP_TERMS = {
    "access",
    "authorization",
    "client",
    "evidence",
    "file",
    "function",
    "injection",
    "object",
    "parameter",
    "request",
    "response",
    "server",
    "validation",
    "vulnerability",
}


def _task_scope_signature(name: str, task: str) -> dict[str, Any]:
    text = " ".join([str(name or ""), str(task or "")]).lower()
    targets = _task_targets(text)
    target_terms = set()
    for target in targets:
        parsed = urlsplit(target if "://" in target else f"http://placeholder{target}")
        target_terms.update(
            token
            for token in re.split(r"[^a-z0-9]+", parsed.path.lower())
            if token
        )
    topic_terms = {
        token
        for token in re.split(r"[^a-z0-9]+", text)
        if len(token) >= 3
        and token not in _TASK_STOPWORDS
        and token not in target_terms
        and not token.isdigit()
    }
    topic_terms.update(_topic_alias_terms(topic_terms))
    return {
        "purpose": _task_purpose(text),
        "targets": targets,
        "topic_terms": topic_terms,
    }


def _task_targets(text: str) -> set[str]:
    targets: set[str] = set()
    for match in _TASK_TARGET_RE.finditer(text):
        raw = match.group(0).strip().rstrip(".,")
        target = _canonical_task_target(raw)
        if target:
            targets.add(target)
            targets.update(_target_variants(target))
    return targets


def _canonical_task_target(raw: str) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    parsed = urlsplit(text)
    if parsed.scheme and parsed.netloc:
        path = parsed.path or "/"
        if path != "/":
            path = path.rstrip("/")
        return urlunsplit(("", "", path, "", "")).lower()
    parsed = urlsplit(text if text.startswith("/") else f"/{text}")
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/")
    return path.lower()


def _target_variants(target: str) -> set[str]:
    parsed = urlsplit(target if target.startswith("/") else f"/{target}")
    segments = [segment for segment in parsed.path.split("/") if segment]
    if not segments:
        return set()
    generalized = [
        "{}"
        if segment.isdigit() or (segment.startswith("{") and segment.endswith("}"))
        else segment.lower()
        for segment in segments
    ]
    if generalized == [segment.lower() for segment in segments]:
        return set()
    return {"/" + "/".join(generalized)}


def _topic_alias_terms(topic_terms: set[str]) -> set[str]:
    aliases: set[str] = set()
    for term in topic_terms:
        aliases.update(_VULN_TOPIC_ALIASES.get(term, set()))
    return aliases


def _task_purpose(text: str) -> str:
    return task_purpose_for_shape(classify_child_task_shape(name="", task=text))


def _intentional_failed_retry(*, agent_id: str, requested_text: str) -> bool:
    text = requested_text.lower()
    return agent_id.lower() in text or any(term in text for term in _FAILED_RETRY_TERMS)


def _near_duplicate_task(
    requested: dict[str, Any],
    existing: dict[str, Any],
) -> bool:
    if not requested["targets"] or not existing["targets"]:
        return False
    if requested["purpose"] != existing["purpose"]:
        return False
    if not _target_overlap(requested["targets"], existing["targets"]):
        return False
    requested_terms = set(requested["topic_terms"])
    existing_terms = set(existing["topic_terms"])
    if requested_terms and existing_terms and not _specific_topic_overlap(requested_terms, existing_terms):
        return False
    return True


def _specific_targets(targets: set[str]) -> set[str]:
    return {target for target in targets if target != "/"}


def _target_overlap(requested_targets: set[str], existing_targets: set[str]) -> set[str]:
    requested_specific = _specific_targets(requested_targets)
    existing_specific = _specific_targets(existing_targets)
    specific_overlap = requested_specific.intersection(existing_specific)
    if specific_overlap:
        return specific_overlap
    if requested_specific or existing_specific:
        return set()
    return requested_targets.intersection(existing_targets)


def _specific_topic_overlap(requested_terms: set[str], existing_terms: set[str]) -> set[str]:
    overlap = requested_terms.intersection(existing_terms)
    specific = {term for term in overlap if term not in _GENERIC_TOPIC_OVERLAP_TERMS}
    return specific or (overlap if not requested_terms or not existing_terms else set())


def _reported_finding_overlap(
    *,
    state_dir: Path | None,
    requested_scope: dict[str, Any],
) -> dict[str, Any] | None:
    if state_dir is None or requested_scope["purpose"] not in {"validate", "report"}:
        return None
    if not requested_scope["targets"]:
        return None
    reports = _vulnerability_reports_for_state(state_dir)
    requested_terms = set(requested_scope["topic_terms"])
    for report in reports:
        existing_scope = _task_scope_signature(
            str(report.get("title") or ""),
            " ".join(
                str(report.get(key) or "")
                for key in (
                    "endpoint",
                    "method",
                    "description",
                    "technical_analysis",
                    "cwe",
                    "category",
                    "vulnerability_type",
                )
            ),
        )
        matched_targets = _target_overlap(requested_scope["targets"], existing_scope["targets"])
        if not matched_targets:
            continue
        existing_terms = set(existing_scope["topic_terms"])
        if requested_terms and existing_terms and not _specific_topic_overlap(requested_terms, existing_terms):
            continue
        return {
            "id": report.get("id"),
            "title": report.get("title"),
            "endpoint": report.get("endpoint"),
            "method": report.get("method"),
            "matched_targets": sorted(matched_targets),
        }
    return None


def _vulnerability_reports_for_state(state_dir: Path) -> list[dict[str, Any]]:
    candidates = []
    if state_dir.name == ".state":
        candidates.append(state_dir.parent / "vulnerabilities.json")
    candidates.append(state_dir / "vulnerabilities.json")
    for path in candidates:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
    return []


def _render_completion_report(
    *,
    agent_name: str,
    agent_id: str,
    task: str,
    success: bool,
    result_summary: str,
    findings: list[str],
    recommendations: list[str],
) -> str:
    """Render a child's completion report as plain structured text.

    Goes into the parent's SDK session with coordinator-added sender
    metadata, so this body just carries the contents. No XML — no
    escaping concerns, no parser ambiguity.
    """
    status = "SUCCESS" if success else "FAILED"
    completion_time = datetime.now(UTC).isoformat()

    lines: list[str] = [
        f"== Completion report from {agent_name} ({agent_id}) ==",
        f"Status: {status}",
        f"Time: {completion_time}",
    ]
    if task:
        lines.append(f"Task: {task}")
    lines.append("")
    lines.append("Summary:")
    lines.append(result_summary or "(none)")
    if findings:
        lines.append("")
        lines.append("Findings:")
        lines.extend(f"- {f}" for f in findings)
    if recommendations:
        lines.append("")
        lines.append("Recommendations:")
        lines.extend(f"- {r}" for r in recommendations)
    return "\n".join(lines)


@function_tool(timeout=30)
async def view_agent_graph(ctx: RunContextWrapper) -> str:
    """Print the multi-agent tree — every agent, its parent, its status.

    Use before spawning a new agent (don't duplicate work — check whether
    something specialized for that task already exists) and any time you
    want a snapshot of who's still ``running`` / ``waiting`` /
    ``completed`` / ``crashed`` / ``stopped``. Output is an indented
    bullet list with status in brackets; the agent that called this tool
    is marked ``← you``.
    """
    inner = _ctx(ctx)
    coordinator = coordinator_from_context(inner)
    me = inner.get("agent_id")
    if coordinator is None:
        return json.dumps(
            {"success": False, "error": "Agent coordinator not initialized in context"},
            ensure_ascii=False,
            default=str,
        )

    parent_of, statuses, names = await coordinator.graph_snapshot()

    lines: list[str] = []

    def render(aid: str, depth: int) -> None:
        status = statuses.get(aid, "?")
        marker = "  ← you" if aid == me else ""
        lines.append(f"{'  ' * depth}- {names.get(aid, aid)} ({aid}) [{status}]{marker}")
        for child, p in parent_of.items():
            if p == aid:
                render(child, depth + 1)

    roots = [aid for aid, parent in parent_of.items() if parent is None]
    for root in roots:
        render(root, 0)

    counts = Counter(statuses.values())
    summary: dict[str, int] = {"total": len(parent_of)}
    for status_name in get_args(Status):
        summary[status_name] = counts.get(status_name, 0)
    return json.dumps(
        {
            "success": True,
            "graph_structure": "\n".join(lines) or "(no agents)",
            "summary": summary,
        },
        ensure_ascii=False,
        default=str,
    )


@function_tool(timeout=30)
async def send_message_to_agent(
    ctx: RunContextWrapper,
    target_agent_id: str,
    message: str,
    message_type: Literal["query", "instruction", "information"] = "information",
    priority: Literal["low", "normal", "high", "urgent"] = "normal",
) -> str:
    """Send a message to another agent's inbox — sparingly.

    Inter-agent messages are appended to the target's SDK session and
    interrupt any active target turn so the next run cycle sees them.
    Use only when essential:

    - Sharing a discovered finding/credential another agent needs.
    - Asking a specialist a focused question.
    - Coordinating who covers what (avoid overlap).
    - Telling a child to wrap up or change course.

    **Don't** use for routine "hello/status" pings, for context the
    target already has (children inherit parent history), or when
    parent/child completion via ``agent_finish`` already covers the
    flow. Messages can only be delivered to active agents. If an agent
    is completed, stopped, crashed, or failed, create a new child agent
    for follow-up work instead of messaging the terminal one.

    Args:
        target_agent_id: Recipient's 8-char id.
        message: The full message body. Be specific — include payloads,
            URLs, or what you want them to do, not just headlines.
        message_type: ``query`` (you want a reply), ``instruction``
            (you're directing them), ``information`` (FYI, no reply
            expected). Default ``information``.
        priority: ``low`` / ``normal`` / ``high`` / ``urgent``.
    """
    inner = _ctx(ctx)
    coordinator = coordinator_from_context(inner)
    me = inner.get("agent_id")
    if coordinator is None or me is None:
        return json.dumps(
            {"success": False, "error": "Agent coordinator or agent_id missing in context"},
            ensure_ascii=False,
            default=str,
        )
    if target_agent_id == me:
        return json.dumps(
            {
                "success": False,
                "error": (
                    "Cannot send a message to yourself; use `think` to record a "
                    "private note, or `agent_finish` / `finish_scan` to terminate"
                ),
            },
            ensure_ascii=False,
            default=str,
        )

    msg_id = f"msg_{uuid.uuid4().hex[:8]}"
    delivered = await coordinator.send(
        target_agent_id,
        {
            "id": msg_id,
            "from": me,
            "content": message,
            "type": message_type,
            "priority": priority,
        },
    )
    if not delivered:
        return json.dumps(
            {
                "success": False,
                "error": f"Target agent '{target_agent_id}' not found or message delivery failed",
            },
            ensure_ascii=False,
            default=str,
        )
    return json.dumps(
        {
            "success": True,
            "message_id": msg_id,
            "target_agent_id": target_agent_id,
            "delivery_status": "delivered",
        },
        ensure_ascii=False,
        default=str,
    )


def _session_items_payload(items: list[Any]) -> list[dict[str, Any]]:
    payload: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, dict):
            role = item.get("role")
            content = item.get("content")
            payload.append({"role": role, "content": content})
        else:
            payload.append({"content": str(item)})
    return payload


@function_tool(timeout=601)
async def wait_for_message(  # noqa: PLR0911
    ctx: RunContextWrapper,
    reason: str = "Waiting for messages from other agents",
    timeout_seconds: int = 600,
) -> str:
    """Pause this agent until a message lands in its inbox (or timeout).

    Use when you have nothing useful to do until a child/peer responds
    — typically after spawning subagents and you want to wait for
    their completion reports. The agent automatically resumes when any
    message arrives.

    **Critical caveats:**

    - **Never** call this if you finished your own task and have **no**
      child agents running — that's a permanent stall. Call
      ``finish_scan`` (root) or ``agent_finish`` (subagent) instead.
    - If you're waiting on an agent that **isn't your child**, message
      it first asking it to ping you when done — otherwise it has no
      reason to send to your inbox and you'll wait the full timeout.
    - Children update the parent automatically via ``agent_finish``
      → no extra coordination needed.

    Args:
        reason: One-line note shown in graph snapshots while you're
            waiting (helps a human or sibling agent debug who's stuck
            on what).
        timeout_seconds: Hard cap (default 600s). On timeout the tool
            returns and you decide whether to keep working or wait
            again.
    """
    inner = _ctx(ctx)
    coordinator = coordinator_from_context(inner)
    me = inner.get("agent_id")
    interactive = bool(inner.get("interactive", False))
    if coordinator is None or me is None:
        return json.dumps(
            {"success": False, "error": "Agent coordinator or agent_id missing in context"},
            ensure_ascii=False,
            default=str,
        )

    async with coordinator._lock:
        stopped = coordinator.statuses.get(me) == "stopped"
    if stopped:
        return json.dumps(
            {
                "success": True,
                "wait_outcome": "stopped",
                "reason": reason,
                "note": "Wait ended because this agent is stopped.",
            },
            ensure_ascii=False,
            default=str,
        )

    pending, items = await coordinator.consume_pending(me, include_items=True)
    if pending > 0:
        await coordinator.mark_running(me)
        return json.dumps(
            {
                "success": True,
                "wait_outcome": "message_arrived",
                "pending_messages": pending,
                "messages": _session_items_payload(items),
                "reason": reason,
            },
            ensure_ascii=False,
            default=str,
        )

    if interactive:
        await coordinator.park_waiting(me)
        return json.dumps(
            {
                "success": True,
                "wait_outcome": "waiting",
                "reason": reason,
                "note": "Agent parked; execution will resume when a message arrives.",
            },
            ensure_ascii=False,
            default=str,
        )

    await coordinator.park_waiting(me)
    try:
        await asyncio.wait_for(coordinator.wait_for_message(me), timeout_seconds)
    except TimeoutError:
        await coordinator.mark_running(me)
        return json.dumps(
            {
                "success": True,
                "wait_outcome": "timeout",
                "timeout_seconds": timeout_seconds,
                "reason": reason,
                "note": "No messages within timeout — continue work or call agent_finish.",
            },
            ensure_ascii=False,
            default=str,
        )

    async with coordinator._lock:
        stopped = coordinator.statuses.get(me) == "stopped"
    if stopped:
        return json.dumps(
            {
                "success": True,
                "wait_outcome": "stopped",
                "reason": reason,
                "note": "Wait ended because this agent is stopped.",
            },
            ensure_ascii=False,
            default=str,
        )

    pending, items = await coordinator.consume_pending(me, include_items=True)
    await coordinator.mark_running(me)

    return json.dumps(
        {
            "success": True,
            "wait_outcome": "message_arrived",
            "pending_messages": pending,
            "messages": _session_items_payload(items),
            "reason": reason,
        },
        ensure_ascii=False,
        default=str,
    )


@function_tool(timeout=120)
async def create_agent(
    ctx: RunContextWrapper,
    name: str,
    task: str,
    inherit_context: bool = True,
    skills: list[str] | None = None,
    todo_id: str | None = None,
    parent_todo_id: str | None = None,
    task_priority: Literal["low", "normal", "high", "critical"] = "normal",
) -> str:
    """Spawn a specialist child agent to run in parallel.

    Decompose complex pentests by handing focused subtasks to dedicated
    children. The child runs asynchronously — the parent continues
    immediately and can ``wait_for_message`` later (or just keep
    working in parallel). When the child calls ``agent_finish``, its
    completion report lands in the parent's inbox.

    **Before spawning, call ``view_agent_graph``** to confirm no
    existing agent already covers this scope — duplicate specialists
    waste turns and create coordination headaches.

    **Specialization principles:**

    - Most agents need at least one ``skill`` to be useful.
    - Aim for **1-3 related skills** per agent. Up to 5 only when the
      task genuinely spans them.
    - Match the ``name`` to the current role: discovery/testing agents
      explore recorded surfaces or planned hypotheses; validator agents
      reproduce candidate vulnerabilities that already have evidence.
      After validation, the coordinating parent should usually call
      ``create_vulnerability_report`` directly with the validator's
      evidence; do not spawn a child just to file the report.
    - Good discovery/testing tasks cite recorded endpoints, methods,
      parameters, auth states, business flows, or hypothesis IDs, then
      ask the child to record hypotheses/coverage/evidence as it works.
    - Good discovery/testing tasks ask for a bounded batch script or
      established scanner pass with a compact result table, then
      evidence/coverage/reporting for confirmed issues. Avoid tasks
      that require one model turn per payload or vague category-only
      testing.
    - Good validator tasks cite the candidate evidence, affected
      surface, expected impact, and what proof would confirm or reject
      exploitability.

    **When to spawn vs do it yourself:**

    - Spawn when the subtask is large, parallelizable, or needs
      different specialization than what you're already doing.
    - Advance the root phase plan before delegation: finish the
      hypothesis/test-matrix phase before spawning discovery/testing
      children, and start validation/reporting before spawning validator
      or reporting children.
    - After reconnaissance, prefer discovery/testing children built from
      the attack-surface inventory and hypothesis matrix before creating
      validator work.
    - Create validator children only after discovery/testing work has
      produced candidate evidence; do not use validators as the first
      post-recon workstream.
    - Reporting-shaped agents should not spawn children. If validation
      evidence is missing, return that gap to the parent coordinator.
    - Don't spawn for trivial one-shot probes — just run the tool
      yourself.

    Args:
        name: Human-readable child name (used in graph views and
            ``send_message_to_agent`` flows).
        task: Specific objective. Be concrete — what to test, what
            success looks like, any constraints.
        inherit_context: Default ``True``. The child receives the
            parent's input history as background; only set ``False``
            when starting a clean-slate task.
        skills: List of skill names (e.g. ``["xss", "sql_injection"]``).
            Max 5; prefer 1-3.
        todo_id: Optional existing todo to bind to this child. Use only
            when the child owns that exact todo; it will be marked done
            when the child calls ``agent_finish(success=true)``.
        parent_todo_id: Optional existing parent/phase todo under which
            the platform should create a new child-tracking todo. Use this
            when delegating work that belongs to a specific phase. If
            omitted, and the parent has exactly one active unassigned
            phase todo, the new child-tracking todo is linked to that
            active phase.
        task_priority: Priority for the automatically created todo.
    """
    inner = _ctx(ctx)
    coordinator = coordinator_from_context(inner)
    parent_id = inner.get("agent_id")
    spawner = inner.get("spawn_child_agent")

    if coordinator is None or parent_id is None:
        return json.dumps(
            {"success": False, "error": "Agent coordinator or agent_id missing in context"},
            ensure_ascii=False,
            default=str,
        )
    if not callable(spawner):
        return json.dumps(
            {
                "success": False,
                "error": "Scan runner did not provide a child-agent spawner in context",
            },
            ensure_ascii=False,
            default=str,
        )

    skill_list = list(skills or [])
    skill_error = validate_requested_skills(skill_list)
    if skill_error:
        return json.dumps(
            {"success": False, "error": skill_error, "agent_id": None},
            ensure_ascii=False,
            default=str,
        )
    if todo_id and parent_todo_id:
        return json.dumps(
            {
                "success": False,
                "error": "Use either todo_id or parent_todo_id, not both",
                "agent_id": None,
            },
            ensure_ascii=False,
            default=str,
        )
    if todo_id:
        try:
            todo_id = validate_todo_exists(owner_agent_id=str(parent_id), todo_id=todo_id)
        except ValueError as e:
            return json.dumps(
                {"success": False, "error": f"Failed to bind todo: {e!s}", "agent_id": None},
                ensure_ascii=False,
                default=str,
            )
    if parent_todo_id:
        try:
            parent_todo_id = validate_todo_exists(
                owner_agent_id=str(parent_id),
                todo_id=parent_todo_id,
            )
        except ValueError as e:
            return json.dumps(
                {"success": False, "error": f"Failed to bind parent todo: {e!s}", "agent_id": None},
                ensure_ascii=False,
                default=str,
            )
        parent_todo = get_todo(owner_agent_id=str(parent_id), todo_id=parent_todo_id)
        parent_status = str((parent_todo or {}).get("status") or "").strip().lower()
        if parent_status != "in_progress":
            return json.dumps(
                {
                    "success": False,
                    "error": (
                        "Cannot create a child agent under a parent todo that is not in_progress. "
                        "Start the current phase or bind the child to an active todo before delegating."
                    ),
                    "agent_id": None,
                    "parent_todo_id": parent_todo_id,
                    "parent_todo_status": parent_status or None,
                },
                ensure_ascii=False,
                default=str,
            )

    state_dir = state_dir_from_raw(inner.get("state_dir"))
    parent_of, statuses, names = await coordinator.graph_snapshot()
    requested_signature = _normalize_task_signature(name, task)
    requested_scope = _task_scope_signature(name, task)
    requested_shape = classify_child_task_shape(name=name, task=task)
    parent_metadata = await coordinator.agent_metadata(str(parent_id))
    parent_shape = classify_child_task_shape(
        name=names.get(str(parent_id), str(parent_id)),
        task=str(parent_metadata.get("task") or ""),
    )
    if parent_shape == "reporting":
        return json.dumps(
            {
                "success": False,
                "error": (
                    "Reporting agents should not spawn child agents. Use existing independent "
                    "validation evidence to call create_vulnerability_report, or return the "
                    "missing validation/evidence gap to the parent coordinator."
                ),
                "agent_id": None,
                "requested_child_shape": requested_shape,
            },
            ensure_ascii=False,
            default=str,
        )
    reported_overlap = _reported_finding_overlap(
        state_dir=state_dir,
        requested_scope=requested_scope,
    )
    if reported_overlap is not None:
        return json.dumps(
            {
                "success": False,
                "error": (
                    "A vulnerability report already covers this target and risk area; "
                    "use the existing report instead of spawning another validator or reporter"
                ),
                "agent_id": None,
                "existing_vulnerability": reported_overlap,
            },
            ensure_ascii=False,
            default=str,
        )
    for agent_id, status in statuses.items():
        if agent_id == parent_id:
            continue
        if status not in _DUPLICATE_RELEVANT_STATUSES:
            continue
        metadata = await coordinator.agent_metadata(agent_id)
        existing_signature = _normalize_task_signature(
            names.get(agent_id, agent_id),
            str(metadata.get("task") or ""),
        )
        if existing_signature == requested_signature:
            return json.dumps(
                {
                    "success": False,
                    "error": (
                        "An agent already has the same name and task; reuse its result "
                        "or coordinate with it instead of spawning a duplicate"
                    ),
                    "agent_id": None,
                    "duplicate_agent_id": agent_id,
                    "duplicate_status": status,
                    "duplicate_parent_id": parent_of.get(agent_id),
                },
                ensure_ascii=False,
                default=str,
            )
        existing_scope = _task_scope_signature(
            names.get(agent_id, agent_id),
            str(metadata.get("task") or ""),
        )
        if _near_duplicate_task(requested_scope, existing_scope):
            if status in {"failed", "crashed"} and _intentional_failed_retry(
                agent_id=agent_id,
                requested_text=requested_signature,
            ):
                continue
            return json.dumps(
                {
                    "success": False,
                    "error": (
                        "An agent already covers the same target and task purpose; "
                        "reuse its result, message it if it is active, or create a "
                        "smaller failure-aware follow-up instead of spawning a near-duplicate"
                    ),
                    "agent_id": None,
                    "duplicate_agent_id": agent_id,
                    "duplicate_status": status,
                    "duplicate_parent_id": parent_of.get(agent_id),
                    "duplicate_scope": {
                        "purpose": existing_scope["purpose"],
                        "targets": sorted(existing_scope["targets"]),
                    },
                },
                ensure_ascii=False,
                default=str,
            )

    workflow_warnings: list[dict[str, Any]] = []
    if inner.get("parent_id") is None and not is_recon_task(
        name=name,
        task=task,
        skills=skill_list,
    ):
        gate = testing_preflight(
            state_dir,
            require_attack_surface=True,
            planned_task=task,
        )
        if not gate.get("ok"):
            workflow_warnings.append(gate)

    raw_parent_history = list(ctx.turn_input) if inherit_context and ctx.turn_input else []
    parent_history = (
        build_child_context_pack(
            name=name,
            task=task,
            skills=skill_list,
            parent_id=str(parent_id),
            state_dir=state_dir,
            parent_history=raw_parent_history,
        )
        if inherit_context
        else []
    )
    try:
        result = await spawner(
            parent_ctx=inner,
            name=name,
            task=task,
            skills=skill_list,
            parent_history=parent_history,
        )
    except Exception as e:
        logger.exception("create_agent: scan runner failed to spawn child '%s'", name)
        return json.dumps(
            {"success": False, "error": f"child spawn failed: {e!s}"},
            ensure_ascii=False,
            default=str,
        )

    child_id = str(result.get("agent_id") or "").strip()
    tracking = "none"
    assigned_todo_id = ""
    if child_id and result.get("success") is not False:
        try:
            if todo_id:
                bound = bind_todo_to_agent(
                    owner_agent_id=str(parent_id),
                    todo_id=todo_id,
                    linked_agent_id=child_id,
                )
                tracking = "bound"
            else:
                selected_parent_todo_id = parent_todo_id or active_parent_todo_id(str(parent_id))
                bound = create_bound_todo(
                    owner_agent_id=str(parent_id),
                    title=name,
                    description=task,
                    priority=task_priority,
                    linked_agent_id=child_id,
                    parent_todo_id=selected_parent_todo_id,
                )
                tracking = "created"
            assigned_todo_id = str(bound.get("todo_id") or "")
            await coordinator.update_metadata(
                child_id,
                assigned_todo_id=assigned_todo_id,
                assigned_todo_owner_id=str(parent_id),
            )
        except Exception as e:
            logger.exception("create_agent: failed to bind todo for child '%s'", name)
            return json.dumps(
                {
                    "success": False,
                    "error": f"child spawned but task tracking failed: {e!s}",
                    "agent_id": child_id,
                },
                ensure_ascii=False,
                default=str,
            )
    result["todo_id"] = assigned_todo_id or None
    result["task_tracking"] = tracking
    if workflow_warnings:
        result["workflow_warnings"] = workflow_warnings

    logger.info(
        "create_agent: spawned %s (%s) parent=%s skills=%d task_len=%d todo=%s tracking=%s",
        child_id or result.get("agent_id"),
        name,
        parent_id or "-",
        len(skill_list),
        len(task or ""),
        assigned_todo_id or "-",
        tracking,
    )

    return json.dumps(
        result,
        ensure_ascii=False,
        default=str,
    )


@function_tool(timeout=30)
async def agent_finish(
    ctx: RunContextWrapper,
    result_summary: str,
    findings: list[str] | None = None,
    success: bool = True,
    report_to_parent: bool = True,
    final_recommendations: list[str] | None = None,
) -> str:
    """Subagent termination — post a completion report to the parent.

    **Subagents only.** Root agents must call ``finish_scan`` instead;
    this tool refuses to run for root agents. Calling this:

    1. Marks the subagent as ``completed``.
    2. Posts a structured completion report to the parent's inbox
       (when ``report_to_parent`` is true).
    3. Stops this subagent's execution.

    **Vulnerability findings must already be filed via
    ``create_vulnerability_report`` before calling this.** The
    ``findings`` field here is for narrative summary only — it does
    not register vulns in the scan report.

    Write the summary as if the parent has no idea what you were
    doing: what did you test, what did you find/confirm/rule out,
    what's still open.

    Args:
        result_summary: What you accomplished and discovered. Concrete
            and specific (URLs, parameters, payloads that worked).
        findings: Optional bullet list of confirmed observations. For
            credit-bearing vulnerabilities, file
            ``create_vulnerability_report`` first; this is for
            narrative.
        success: Whether the assigned subtask was completed
            successfully. Default ``True``.
        report_to_parent: Whether to deliver the completion report to
            the parent's inbox. Default ``True``.
        final_recommendations: Optional next-step suggestions for the
            parent (e.g., "prioritize testing X", "spawn an agent to
            cover Y").
    """
    inner = _ctx(ctx)
    coordinator = coordinator_from_context(inner)
    me = inner.get("agent_id")
    if coordinator is None or me is None:
        return json.dumps(
            {"success": False, "error": "Agent coordinator or agent_id missing in context"},
            ensure_ascii=False,
            default=str,
        )

    parent_id = inner.get("parent_id")
    if parent_id is None:
        return json.dumps(
            {
                "success": False,
                "error": (
                    "agent_finish is for subagents. Root/main agents must call finish_scan instead"
                ),
            },
            ensure_ascii=False,
            default=str,
        )

    unfinished_todos = unfinished_todos_for_agent(me)
    if unfinished_todos:
        return json.dumps(
            {
                "success": False,
                "agent_completed": False,
                "error": (
                    "Cannot finish while your todos are still unresolved. "
                    "Mark completed or tested-negative work as done before calling agent_finish"
                ),
                "unfinished_todos": [
                    {
                        "todo_id": todo.get("todo_id"),
                        "title": todo.get("title"),
                        "status": todo.get("status"),
                        "priority": todo.get("priority"),
                    }
                    for todo in unfinished_todos
                ],
            },
            ensure_ascii=False,
            default=str,
        )

    parent_notified = False
    completed_todos: list[dict[str, Any]] = []
    if report_to_parent:
        async with coordinator._lock:
            agent_name = coordinator.names.get(me, me)
        report = _render_completion_report(
            agent_name=agent_name,
            agent_id=me,
            task=str(inner.get("task", "")),
            success=success,
            result_summary=result_summary,
            findings=list(findings or []),
            recommendations=list(final_recommendations or []),
        )
        await coordinator.send(
            parent_id,
            {
                "id": f"report_{uuid.uuid4().hex[:8]}",
                "from": me,
                "content": report,
                "type": "completion",
                "priority": "high",
            },
        )
        parent_notified = True

    completed_todos = complete_bound_todos(linked_agent_id=str(me), success=success)

    logger.info(
        "agent_finish: %s success=%s findings=%d parent_notified=%s completed_todos=%d",
        me,
        success,
        len(findings or []),
        parent_notified,
        len(completed_todos),
    )
    await coordinator.set_status(me, "completed")

    return json.dumps(
        {
            "success": True,
            "agent_completed": True,
            "parent_notified": parent_notified,
            "agent_id": me,
            "summary": result_summary,
            "findings_count": len(findings or []),
            "has_recommendations": bool(final_recommendations),
            "completed_todo_ids": [
                todo.get("todo_id")
                for todo in completed_todos
                if todo.get("status") == "done"
            ],
            "resolved_todo_ids": [todo.get("todo_id") for todo in completed_todos],
        },
        ensure_ascii=False,
        default=str,
    )


@function_tool(timeout=30)
async def stop_agent(
    ctx: RunContextWrapper,
    target_agent_id: str,
    cascade: bool = True,
    reason: str = "",
    force: bool = False,
) -> str:
    """Gracefully stop a running agent (and optionally its descendants).

    Uses the SDK's ``RunResultStreaming.cancel(mode="after_turn")`` so the
    target's current turn finishes — including saving items to its
    session — before the run loop honors the cancel. The target agent
    becomes terminal as ``stopped`` and will not accept later
    user/peer messages.

    Use sparingly. This is a forced cancellation tool, not a normal
    completion path. For ordinary wrap-up, use ``send_message_to_agent``
    to ask the child to call ``agent_finish``, then ``wait_for_message``
    for its completion report.

    By default, active agents are protected from accidental cancellation.
    Set ``force=true`` only after you have a concrete reason to discard
    incomplete work, such as a duplicated task, out-of-scope work,
    repeated failure to follow instructions, or an explicit user/budget
    stop.

    Args:
        target_agent_id: The 8-char id from ``view_agent_graph`` /
            ``create_agent``. Cannot stop yourself.
        cascade: If ``True`` (default), also stop every descendant of
            ``target_agent_id`` leaves-first. ``False`` stops only the
            target.
        reason: Optional human-readable reason for the stop, surfaced
            in logs and telemetry.
        force: Must be ``true`` to cancel an active agent. Keep the
            default ``false`` for normal workflow coordination.
    """
    inner = _ctx(ctx)
    coordinator = coordinator_from_context(inner)
    me = inner.get("agent_id")
    if coordinator is None or me is None:
        return json.dumps(
            {"success": False, "error": "Agent coordinator or agent_id missing in context"},
            ensure_ascii=False,
            default=str,
        )
    if target_agent_id == me:
        return json.dumps(
            {
                "success": False,
                "error": "Cannot stop yourself; call agent_finish or finish_scan instead",
            },
            ensure_ascii=False,
            default=str,
        )
    _, statuses, _ = await coordinator.graph_snapshot()
    if target_agent_id not in statuses:
        return json.dumps(
            {"success": False, "error": f"Unknown agent_id: {target_agent_id}"},
            ensure_ascii=False,
            default=str,
        )

    current_status = statuses[target_agent_id]
    if current_status not in _ACTIVE_STATUSES:
        return json.dumps(
            {
                "success": False,
                "error": (
                    f"Agent {target_agent_id} is already '{current_status}'; "
                    "stop_agent only acts on running/waiting agents — use "
                    "view_agent_graph to find still-active descendants and "
                    "stop them individually, or send_message_to_agent if you "
                    "want to wake this one with new instructions"
                ),
                "target_agent_id": target_agent_id,
                "current_status": current_status,
            },
            ensure_ascii=False,
            default=str,
        )

    if not force:
        return json.dumps(
            {
                "success": False,
                "error": (
                    "Refusing to stop an active agent without force=true. "
                    "Normal completion must use send_message_to_agent to ask the child to wrap up, "
                    "then wait_for_message for its agent_finish report. Use force=true only when "
                    "you intentionally want to discard incomplete child work"
                ),
                "target_agent_id": target_agent_id,
                "current_status": current_status,
                "recommended_next_steps": [
                    "send_message_to_agent with a clear wrap-up instruction",
                    "wait_for_message until the completion report arrives",
                    "call stop_agent again with force=true only for duplicated, off-track, out-of-scope, blocked, budget-stopped, or user-cancelled work",
                ],
            },
            ensure_ascii=False,
            default=str,
        )

    if cascade:
        await coordinator.cancel_descendants_graceful(target_agent_id)
    else:
        await coordinator.request_stop(target_agent_id)
    resolved_todos = resolve_bound_todos(
        linked_agent_id=target_agent_id,
        status="skipped",
        reason=reason or "Agent stopped before normal completion",
    )

    logger.info(
        "stop_agent: target=%s cascade=%s reason=%r resolved_todos=%d",
        target_agent_id,
        cascade,
        reason,
        len(resolved_todos),
    )
    return json.dumps(
        {
            "success": True,
            "target_agent_id": target_agent_id,
            "cascade": cascade,
            "reason": reason,
            "resolved_todo_ids": [todo.get("todo_id") for todo in resolved_todos],
            "note": "Cancellation is graceful — current turn completes first.",
        },
        ensure_ascii=False,
        default=str,
    )
