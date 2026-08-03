"""Participant Session work envelope resolver (Spec #277).

Session identity = conversation_id + expert_id.
Work mode is Session-private; Case sticky template must not silent-promote Free → Graph.

Structured fields only — never invent mode from free-text instruction.
"""
from __future__ import annotations

from typing import Any, Literal

from app.services.case_engagement import (
    normalize_product_engagement_template,
    resolve_graph_execution,
)

WorkMode = Literal["free", "graph"]
# continue_session = post-complete C1 free-in-envelope (wire "continue")
# resume = incomplete/interrupted/failed Graph same-mode continue (wire "resume" — Hard path, not C1)
# resume_parked = permissioned re-enter of parked Graph after exit
GraphExecution = Literal["run", "continue_session", "resume", "resume_parked", "full_restart"]
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
    1. Structured permission card (enter/exit/switch/park).
    2. This-turn explicit product graph id on composer → graph (user Workflow permission).
    3. This-turn free / empty string / 不指定 on composer → **no mode force** (Spec #278 A1):
       if Session is already Graph, stay Graph; otherwise Free.
       (Composer 不指定 is not exit Graph — exit needs permission card.)
    4. Same-mode continue after fail/incomplete → Session work_mode
       (Case sticky alone never upgrades Free→Graph; composer omitted on continue).
    5. Session work_mode when composer omitted.
    6. Default → free.

    Does not scan free-text instruction for mode.
    ``case_sticky_template`` is accepted for call-site symmetry but is never mode authority.
    """
    eid = str(expert_id or "").strip() or None
    sess_mode = str(session_work_mode or "").strip().lower()
    if sess_mode not in {"free", "graph"}:
        sess_mode = ""
    sess_gid = normalize_product_engagement_template(session_graph_id)
    del case_sticky_template  # not mode authority (A1/A9); callers may still pass for clarity

    # Structured permission card (enter graph / exit / switch / resume parked).
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
    elif perm_action in {"switch_graph", "accept_switch_graph"} and perm_graph:
        work_mode = "graph"
        graph_id = perm_graph
        graph_execution = "full_restart"
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
    elif composer_gid:
        # Explicit product graph this turn → user Workflow permission (wins over same-mode continue).
        work_mode = "graph"
        graph_id = composer_gid
    elif not composer_is_absent and composer_free:
        # Spec #278 A1: 不指定 / free / empty = do not force mode change.
        # Session already Graph → stay Graph; otherwise Free (first turn / Free session).
        if sess_mode == "graph" and sess_gid:
            work_mode = "graph"
            graph_id = sess_gid
        else:
            work_mode = "free"
            graph_id = None
    elif same_mode_continue and sess_mode:
        # A1/A9: failed Free + 继续 with composer omitted stays Free despite Case sticky Graph.
        work_mode = "graph" if sess_mode == "graph" else "free"
        graph_id = sess_gid if work_mode == "graph" else None
    elif sess_mode == "graph" and sess_gid:
        work_mode = "graph"
        graph_id = sess_gid
    elif sess_mode == "free":
        work_mode = "free"
        graph_id = None
    else:
        # First turn / no Session: default Free.
        work_mode = "free"
        graph_id = None

    # --- graph_execution (C1 post-complete vs incomplete Graph resume — Spec #282) ---
    if work_mode == "graph" and graph_id:
        if graph_execution is None:
            incomplete_like = is_incomplete_like_status(conversation_status)
            # Map existing C1 resolver; only after product-settled completed → free-in-envelope.
            c1 = resolve_graph_execution(
                engagement_template=graph_id,
                conversation_status=conversation_status,
                explicit_execution=explicit_execution,
            )
            if c1 == "full":
                graph_execution = "full_restart"
            elif incomplete_like and sess_mode == "graph":
                # Spec #282 S1/S6: incomplete/interrupted/failed Graph Session must never
                # wire as C1 "continue" (Node free-in-envelope). Resume Hard path instead.
                graph_execution = "resume"
            elif c1 == "continue":
                # Post-complete (or explicit continue_chat/envelope on completed) → C1.
                graph_execution = "continue_session"
            else:
                # First Graph run / composer-enter / non-incomplete same-mode: Hard full path.
                # (same_mode_continue + incomplete is handled above via resume.)
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
    """Map envelope graph_execution to task_assign wire values (Spec #282 split).

    - continue_session → "continue" (C1 free-in-envelope only)
    - resume / resume_parked → "resume" (Hard Graph path; not C1)
    - full_restart → "full"
    - run → omit (Node first-run full when hard resolves)
    """
    if graph_execution is None:
        return None
    if graph_execution == "continue_session":
        return "continue"
    if graph_execution in {"resume", "resume_parked"}:
        return "resume"
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
        else:
            out.pop("graph_execution", None)
            out.pop("graphExecution", None)
    else:
        # Free: must not carry Case sticky / UI default Graph template.
        out.pop("engagement_template", None)
        out.pop("engagementTemplate", None)
        out.pop("graph_execution", None)
        out.pop("graphExecution", None)
    return out


# Incomplete / interrupted Session terminals (Spec #282 incomplete Graph resume).
INCOMPLETE_LIKE_STATUSES = frozenset(
    {"failed", "incomplete", "paused", "canceled", "cancelled"}
)


def is_incomplete_like_status(status: object) -> bool:
    """True when conversation status is incomplete/interrupted/failed (not completed)."""
    return str(status or "").strip().lower() in INCOMPLETE_LIKE_STATUSES


def resolve_interrupt_wind_down(
    *,
    active_worker_ids: object = None,
    sent_to: object = None,
    action: object = "cancel",
) -> dict[str, Any]:
    """Spec #282 S7: pure decision — interrupt wind-down vs honest settle.

    Wind-down only when at least one **tracked** worker is also **online** (in sent_to).
    Offline-only ghosts + online bound-node alone must settle (no permanent interrupting).

    Returns:
      wind_down: bool
      online_active: list[str]  tracked workers that received interrupt
      offline_ghosts: list[str] tracked workers not online
      settle_status: "running" | "canceled" | "incomplete"
    """
    if isinstance(active_worker_ids, dict):
        workers = {str(k).strip() for k in active_worker_ids if str(k).strip()}
    elif isinstance(active_worker_ids, (list, tuple, set, frozenset)):
        workers = {str(x).strip() for x in active_worker_ids if str(x).strip()}
    else:
        workers = set()

    if isinstance(sent_to, dict):
        sent = {str(k).strip() for k in sent_to if str(k).strip()}
    elif isinstance(sent_to, (list, tuple, set, frozenset)):
        sent = {str(x).strip() for x in sent_to if str(x).strip()}
    else:
        sent = set()

    online_active = sorted(workers & sent)
    offline_ghosts = sorted(workers - sent)
    wind_down = bool(online_active)
    act = str(action or "cancel").strip().lower()
    if wind_down:
        settle_status = "running"
    elif act == "pause":
        settle_status = "incomplete"
    else:
        settle_status = "canceled"
    return {
        "wind_down": wind_down,
        "online_active": online_active,
        "offline_ghosts": offline_ghosts,
        "settle_status": settle_status,
    }


def finalize_interrupt_wind_down(
    *,
    initial_wind_down: bool,
    action: object = "cancel",
    workers_remaining: bool = False,
) -> dict[str, Any]:
    """Spec #282 S7: pure post-apply outcome (after worker state mutations).

    Separates initial decision from apply results so empty-after-apply cannot keep
    settle_status=running from the pre-apply decision, and so interrupting stays
    true while online workers remain.

    Returns:
      wind_down, settle_status, working, interrupting
    """
    act = str(action or "cancel").strip().lower()
    idle_status = "incomplete" if act == "pause" else "canceled"
    if not initial_wind_down:
        return {
            "wind_down": False,
            "settle_status": idle_status,
            "working": False,
            "interrupting": False,
        }
    if workers_remaining:
        return {
            "wind_down": True,
            "settle_status": "running",
            "working": True,
            "interrupting": True,
        }
    # Started wind-down but apply left no workers — honest settle (not "running").
    return {
        "wind_down": False,
        "settle_status": idle_status,
        "working": False,
        "interrupting": False,
    }


def wire_graph_execution_for_status(
    *,
    engagement_template: object = None,
    conversation_status: object = None,
    explicit_execution: object = None,
) -> str | None:
    """Legacy C1 helper alignment (Spec #282): incomplete Graph never wires continue.

    Returns wire value ``"full"`` | ``"continue"`` | ``"resume"`` | None.
    Prefer ``resolve_work_envelope`` on product dispatch; this is for C1-only callers.
    """
    from app.services.case_engagement import (
        is_product_graph_template,
        resolve_graph_execution,
    )

    raw = str(explicit_execution or "").strip().lower()
    if raw in {"full", "run", "restart"}:
        return "full"

    # Incomplete product Graph must never emit C1 free-in-envelope ``continue``.
    if is_incomplete_like_status(conversation_status) and is_product_graph_template(
        engagement_template
    ):
        return "resume"

    return resolve_graph_execution(
        engagement_template=engagement_template,
        conversation_status=conversation_status,
        explicit_execution=explicit_execution,
    )
