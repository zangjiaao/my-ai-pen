"""Spec #354 S4: Case pending-handoff holding for incomplete Todo maps.

Holding is per Case + expert_id. Same-expert Session re-entry auto-consumes
the hold; cross-expert isolation is strict (never hand expert X's map to Y).

Also builds Free cold-start Todo seed from Case Tasks (participant / checkpoint
plan_tree) so continue-after-fail reuses the open map instead of empty TodoStore.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

# plan_tree / TodoStore terminal statuses (any of these ⇒ not open work).
_TERMINAL_STATUSES = frozenset(
    {
        "done",
        "completed",
        "failed",
        "skipped",
        "blocked",
        "abandoned",
    }
)
_OPEN_STATUSES = frozenset({"pending", "running", "in_progress", ""})


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


def _is_terminal_status(status: object) -> bool:
    return str(status or "").strip().lower() in _TERMINAL_STATUSES


def _is_work_item_node(node: dict) -> bool:
    level = str(node.get("level") or "").strip().lower()
    kind = str(node.get("kind") or "").strip().lower()
    if level in {"phase"} or kind in {"phase"}:
        return False
    # Default plan_tree work rows are work_item / task.
    if level in {"work_item", "task", ""}:
        return True
    if kind in {"task", "work", "work_item", "todo"}:
        return True
    return False


def _is_phase_node(node: dict) -> bool:
    level = str(node.get("level") or "").strip().lower()
    kind = str(node.get("kind") or "").strip().lower()
    return level == "phase" or kind == "phase"


def open_todo_phases_from_plan_tree(plan_tree: object) -> list[dict[str, Any]]:
    """Convert plan_tree → Todo-phase snapshot for Node seedTodoFromHandoff.

    Returns [] when there is no open work (sealed / empty). When any open item
    exists, includes completed/abandoned siblings so progress is preserved.
    """
    if not isinstance(plan_tree, list) or not plan_tree:
        return []

    phases_by_id: dict[str, dict[str, Any]] = {}
    phase_order: list[str] = []
    orphan_tasks: list[dict[str, Any]] = []

    for node in plan_tree:
        if not isinstance(node, dict) or not _is_phase_node(node):
            continue
        nid = str(node.get("node_id") or node.get("id") or "").strip()
        title = str(node.get("title") or node.get("name") or "Tasks").strip() or "Tasks"
        if not nid:
            nid = f"phase:{title}"
        if nid not in phases_by_id:
            phases_by_id[nid] = {"name": title, "tasks": []}
            phase_order.append(nid)

    for node in plan_tree:
        if not isinstance(node, dict) or not _is_work_item_node(node):
            continue
        title = str(node.get("title") or node.get("name") or node.get("content") or "").strip()
        if not title:
            continue
        status = str(node.get("status") or "pending").strip().lower() or "pending"
        task = {"title": title, "content": title, "status": status}
        parent = str(node.get("parent_id") or "").strip()
        if parent and parent in phases_by_id:
            phases_by_id[parent]["tasks"].append(task)
        else:
            orphan_tasks.append(task)

    if orphan_tasks:
        # Flat / legacy trees without phase parents.
        catch_id = phase_order[0] if phase_order else "phase:Tasks"
        if catch_id not in phases_by_id:
            phases_by_id[catch_id] = {"name": "Tasks", "tasks": []}
            phase_order.append(catch_id)
        phases_by_id[catch_id]["tasks"].extend(orphan_tasks)

    out: list[dict[str, Any]] = []
    has_open = False
    for pid in phase_order:
        phase = phases_by_id.get(pid) or {}
        tasks = phase.get("tasks") if isinstance(phase.get("tasks"), list) else []
        if not tasks:
            continue
        for t in tasks:
            if isinstance(t, dict) and not _is_terminal_status(t.get("status")):
                has_open = True
                break
        out.append({"name": str(phase.get("name") or "Tasks"), "tasks": list(tasks)})

    if not has_open:
        return []
    return out


def plan_tree_for_expert(context: dict | None, expert_id: object) -> list:
    """Prefer same-expert participant plan_tree; fall back to checkpoint / case plan_tree."""
    ctx = dict(context or {})
    eid = str(expert_id or "").strip()
    if eid:
        participants = ctx.get("participants")
        if isinstance(participants, dict):
            for row in participants.values():
                if not isinstance(row, dict):
                    continue
                if str(row.get("expert_id") or "").strip() != eid:
                    continue
                # Sealed live map: no open Free work to seed.
                if row.get("live_sealed") is True:
                    return []
                tree = row.get("plan_tree")
                if isinstance(tree, list) and tree:
                    return list(tree)

    tree = ctx.get("plan_tree") if isinstance(ctx.get("plan_tree"), list) else []
    if tree:
        return list(tree)
    checkpoint = ctx.get("checkpoint") if isinstance(ctx.get("checkpoint"), dict) else {}
    cp_tree = checkpoint.get("plan_tree") if isinstance(checkpoint.get("plan_tree"), list) else []
    return list(cp_tree) if cp_tree else []


def open_todo_phases_for_expert(context: dict | None, expert_id: object) -> list[dict[str, Any]]:
    """Open (non-sealed) Free Todo phases for same-expert cold continue seed."""
    return open_todo_phases_from_plan_tree(plan_tree_for_expert(context, expert_id))
