"""Participant Session work envelope resolver (Spec #277).

Session identity = conversation_id + expert_id.
Work mode is Session-private; Case sticky template must not silent-promote Free → Graph.

Structured fields only — never invent mode from free-text instruction.
"""
from __future__ import annotations

from typing import Any, Literal

from app.services.case_engagement import (
    is_product_graph_template,
    normalize_product_engagement_template,
    resolve_graph_execution,
)

WorkMode = Literal["free", "graph"]
GraphExecution = Literal["run", "continue_session", "resume_parked", "full_restart"]
QueueMode = Literal["enqueue", "run_now"]

# Wire values that mean Free / unspecified (UI 不指定).
_FREE_COMPOSER_KEYS = frozenset(
    {
        "",
        "free",
        "none",
        "off",
        "false",
        "null",
        "unspecified",
        "不指定",
    }
)


def is_free_composer_value(value: object) -> bool:
    """True when composer/engagement_template means Free on the wire."""
    if value is None:
        return True
    key = str(value).strip().lower()
    return key in _FREE_COMPOSER_KEYS


def session_record_from_context(context: object, expert_id: object = None) -> dict[str, Any]:
    """Read per-expert Participant Session private fields from conversation.context."""
    ctx = context if isinstance(context, dict) else {}
    sessions = ctx.get("sessions") if isinstance(ctx.get("sessions"), dict) else {}
    eid = str(expert_id or "").strip()
    if not eid:
        # Fallback: single anonymous slot used when expert_id was not yet known.
        row = sessions.get("_default") if isinstance(sessions.get("_default"), dict) else {}
        return dict(row) if row else {}
    row = sessions.get(eid)
    if not isinstance(row, dict):
        # Also try expert:id key shape if writers used roster-style keys.
        alt = sessions.get(f"expert:{eid}")
        row = alt if isinstance(alt, dict) else {}
    return dict(row) if row else {}


def merge_session_into_context(
    context: dict | None,
    *,
    expert_id: object = None,
    work_mode: object = None,
    graph_id: object = None,
    parked_graph: object = None,
) -> dict:
    """Return new context with sessions[expert_id] updated (Session-private)."""
    ctx = dict(context or {})
    sessions = dict(ctx.get("sessions") or {}) if isinstance(ctx.get("sessions"), dict) else {}
    eid = str(expert_id or "").strip() or "_default"
    prev = dict(sessions.get(eid) or {}) if isinstance(sessions.get(eid), dict) else {}

    mode = str(work_mode or "").strip().lower()
    if mode in {"free", "graph"}:
        prev["work_mode"] = mode
    gid = normalize_product_engagement_template(graph_id) if graph_id is not None else None
    if work_mode is not None and mode == "free":
        prev["graph_id"] = None
    elif gid:
        prev["graph_id"] = gid
    elif graph_id is not None and is_free_composer_value(graph_id):
        prev["graph_id"] = None

    if parked_graph is not None:
        if parked_graph is False or parked_graph == {}:
            prev.pop("parked_graph", None)
        elif isinstance(parked_graph, dict):
            prev["parked_graph"] = parked_graph

    sessions[eid] = prev
    ctx["sessions"] = sessions
    return ctx


def resolve_work_envelope(
    *,
    expert_id: object = None,
    session_work_mode: object = None,
    session_graph_id: object = None,
    composer_template: object = None,
    case_sticky_template: object = None,
    conversation_status: object = None,
    explicit_execution: object = None,
    same_mode_continue: bool = False,
    session_running: bool = False,
    force_interrupt: bool = False,
    permission_decision: object = None,
    capability_graph_ids: frozenset[str] | set[str] | None = None,
) -> dict[str, Any]:
    """Resolve immutable work envelope for one dispatch (structured I/O only).

    Priority (mode authority):
    1. This-turn explicit product graph id on composer → graph (user permission).
    2. This-turn free / empty / 不指定 → free (do not pre-fill graph_id).
    3. Same-mode continue after fail/incomplete → Session work_mode (never Case sticky upgrade).
    4. Session work_mode when composer omitted.
    5. Default → free. Case sticky template alone never forces graph.

    Does not scan free-text instruction for mode.
    """
    eid = str(expert_id or "").strip() or None
    sess_mode = str(session_work_mode or "").strip().lower()
    if sess_mode not in {"free", "graph"}:
        sess_mode = ""
    sess_gid = normalize_product_engagement_template(session_graph_id)

    # Structured permission card (enter graph / exit / resume parked) — optional MVP path.
    perm = permission_decision if isinstance(permission_decision, dict) else {}
    perm_action = str(perm.get("action") or perm.get("kind") or "").strip().lower()
    perm_graph = normalize_product_engagement_template(
        perm.get("graph_id") or perm.get("engagement_template")
    )

    composer_raw = composer_template
    composer_is_absent = composer_raw is None
    composer_free = is_free_composer_value(composer_raw)
    composer_gid = (
        None
        if composer_free
        else normalize_product_engagement_template(composer_raw)
    )

    # Capability gate: unknown / undeclared graph ids cannot enter Graph.
    caps = capability_graph_ids
    if caps is not None and composer_gid and composer_gid not in caps:
        composer_gid = None
        composer_free = True
    if caps is not None and perm_graph and perm_graph not in caps:
        perm_graph = None

    work_mode: WorkMode = "free"
    graph_id: str | None = None
    graph_execution: GraphExecution | None = None
    permission_required: str | None = None

    # --- Mode resolution ---
    if perm_action in {"enter_graph", "accept_enter_graph"} and perm_graph:
        work_mode = "graph"
        graph_id = perm_graph
    elif perm_action in {"exit_graph", "accept_exit_graph"}:
        work_mode = "free"
        graph_id = None
    elif perm_action in {"resume_parked", "continue_parked"} and (perm_graph or sess_gid):
        work_mode = "graph"
        graph_id = perm_graph or sess_gid
        graph_execution = "resume_parked"
    elif perm_action in {"full_restart", "restart_graph"} and (perm_graph or sess_gid or composer_gid):
        work_mode = "graph"
        graph_id = perm_graph or composer_gid or sess_gid
        graph_execution = "full_restart"
    elif same_mode_continue and sess_mode:
        # A1/A9: failed Free + 继续 stays Free even if UI/Case sticky is app_assessment.
        # Same for Graph Session continue — do not re-judge via sticky.
        work_mode = "graph" if sess_mode == "graph" else "free"
        graph_id = sess_gid if work_mode == "graph" else None
    elif composer_gid:
        # Explicit product graph this turn → user permission via UI control.
        work_mode = "graph"
        graph_id = composer_gid
    elif not composer_is_absent and composer_free:
        # Explicit free / none / 不指定 / empty string this turn.
        work_mode = "free"
        graph_id = None
    elif sess_mode == "graph" and sess_gid:
        work_mode = "graph"
        graph_id = sess_gid
    elif sess_mode == "free":
        work_mode = "free"
        graph_id = None
    else:
        # First turn / no Session: default Free. Case sticky is NOT mode authority.
        work_mode = "free"
        graph_id = None
        # case_sticky_template intentionally unused for mode (A1/A5/A9).
        _ = case_sticky_template

    # --- graph_execution (C1 + same-mode) ---
    if work_mode == "graph" and graph_id:
        if graph_execution is None:
            # Map existing C1 resolver; only after real Graph settle → continue.
            c1 = resolve_graph_execution(
                engagement_template=graph_id,
                conversation_status=conversation_status,
                explicit_execution=explicit_execution,
            )
            if c1 == "full":
                graph_execution = "full_restart"
            elif c1 == "continue":
                graph_execution = "continue_session"
            elif same_mode_continue and sess_mode == "graph":
                # Incomplete/failed Graph continue: keep Graph without forcing full restart
                # when client did not ask for full. Node interprets omit as first-run full
                # only when hard resolves; for fail continue we prefer continue_session.
                status = str(conversation_status or "").strip().lower()
                if status in {"failed", "incomplete", "paused", "canceled", "cancelled"}:
                    graph_execution = "continue_session"
                else:
                    graph_execution = "run"
            else:
                graph_execution = "run"
    else:
        graph_execution = None
        graph_id = None

    queue: QueueMode = "run_now"
    if session_running and not force_interrupt:
        queue = "enqueue"
    if force_interrupt:
        queue = "run_now"

    return {
        "expert_id": eid,
        "work_mode": work_mode,
        "graph_id": graph_id,
        "graph_execution": graph_execution,
        "queue": queue,
        "permission_required": permission_required,
        # Wire helpers for task_assign consumers
        "engagement_template": graph_id if work_mode == "graph" else None,
        "wire_graph_execution": _wire_graph_execution(graph_execution),
    }


def _wire_graph_execution(graph_execution: GraphExecution | None) -> str | None:
    """Map envelope graph_execution to existing task_assign wire values."""
    if graph_execution is None:
        return None
    if graph_execution in {"continue_session", "resume_parked"}:
        return "continue"
    if graph_execution == "full_restart":
        return "full"
    # run → omit (Node first-run full when hard resolves)
    return None


def apply_work_envelope_to_task_assign(task_msg: dict | None, envelope: dict | None) -> dict:
    """Apply resolver output onto a task_assign payload (strip silent Graph when Free)."""
    out = dict(task_msg or {})
    env = envelope if isinstance(envelope, dict) else {}
    mode = str(env.get("work_mode") or "free").strip().lower()
    if mode == "graph" and env.get("engagement_template"):
        out["engagement_template"] = env["engagement_template"]
        wire_exec = env.get("wire_graph_execution")
        if wire_exec:
            out["graph_execution"] = wire_exec
        elif "graph_execution" in out and not env.get("graph_execution"):
            # Free of stale execution when run
            pass
    else:
        # Free: must not carry Case sticky / UI default Graph template.
        out.pop("engagement_template", None)
        out.pop("engagementTemplate", None)
        out.pop("graph_execution", None)
        out.pop("graphExecution", None)
    return out
