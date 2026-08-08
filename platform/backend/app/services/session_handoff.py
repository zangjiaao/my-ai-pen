"""Spec #354 S4: Case pending-handoff holding for incomplete Todo maps.

Holding is per Case + expert_id. Same-expert Session re-entry auto-consumes
the hold; cross-expert isolation is strict (never hand expert X's map to Y).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _sessions_bucket(context: dict | None) -> dict:
    ctx = dict(context or {})
    holds = ctx.get("pending_handoffs")
    if not isinstance(holds, dict):
        holds = {}
    return holds


def put_pending_handoff(
    context: dict | None,
    *,
    expert_id: object,
    open_todos: object,
    source: str = "session_delete",
) -> dict:
    """Store incomplete Todo snapshot for expert under Case context."""
    ctx = dict(context or {})
    eid = str(expert_id or "").strip()
    if not eid:
        return ctx
    holds = dict(_sessions_bucket(ctx))
    todos = open_todos if isinstance(open_todos, list) else []
    # Only hold non-empty maps (value path = continue unfinished work).
    has_items = False
    for phase in todos:
        if isinstance(phase, dict) and phase.get("tasks"):
            has_items = True
            break
        if isinstance(phase, dict) and phase.get("items"):
            has_items = True
            break
    if not has_items and todos:
        # Still hold raw snapshot if non-empty list of any shape
        has_items = len(todos) > 0
    if not has_items:
        return ctx
    holds[eid] = {
        "expert_id": eid,
        "open_todos": todos,
        "held_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
    }
    ctx["pending_handoffs"] = holds
    return ctx


def peek_pending_handoff(context: dict | None, expert_id: object) -> dict[str, Any] | None:
    eid = str(expert_id or "").strip()
    if not eid:
        return None
    holds = _sessions_bucket(context)
    row = holds.get(eid)
    return dict(row) if isinstance(row, dict) else None


def take_pending_handoff(context: dict | None, expert_id: object) -> tuple[dict, dict[str, Any] | None]:
    """Consume same-expert hold (auto-handoff on new Session)."""
    ctx = dict(context or {})
    eid = str(expert_id or "").strip()
    if not eid:
        return ctx, None
    holds = dict(_sessions_bucket(ctx))
    row = holds.pop(eid, None)
    if holds:
        ctx["pending_handoffs"] = holds
    else:
        ctx.pop("pending_handoffs", None)
    return ctx, dict(row) if isinstance(row, dict) else None


def pending_handoff_expert_ids(context: dict | None) -> list[str]:
    holds = _sessions_bucket(context)
    return sorted(str(k) for k in holds.keys() if str(k).strip())


def has_pending_handoff(context: dict | None, expert_id: object | None = None) -> bool:
    if expert_id is not None:
        return peek_pending_handoff(context, expert_id) is not None
    return bool(pending_handoff_expert_ids(context))
