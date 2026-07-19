"""Case-level multi-role participant roster for Status panel.

1 conversation = 1 Case. Each product expert / default seat that speaks or runs
a work-burst is a participant. Checkpoints update only the matching role —
they must not wipe the roster.

No NLP: keys come from structured expert_id / pack_id / expert_name only.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _slug(value: object, fallback: str = "agent") -> str:
    text = str(value or "").strip().lower()
    if not text:
        return fallback
    text = re.sub(r"[^a-z0-9._:-]+", "-", text)
    text = text.strip("-")[:64]
    return text or fallback


def participant_key(
    *,
    expert_id: object = None,
    pack_id: object = None,
    expert_name: object = None,
) -> str:
    """Stable roster key: prefer product expert_id, else pack+name slug."""
    eid = str(expert_id or "").strip()
    if eid:
        return f"expert:{eid}"
    pack = _slug(pack_id, "default")
    name = _slug(expert_name, pack)
    return f"pack:{pack}:{name}"


def _as_dict(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _num(value: object) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def participants_map(context: dict | None) -> dict[str, dict[str, Any]]:
    raw = _as_dict(context).get("participants")
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for key, value in raw.items():
        k = str(key or "").strip()
        if not k or not isinstance(value, dict):
            continue
        out[k] = dict(value)
    return out


def upsert_participant(
    context: dict | None,
    *,
    expert_id: object = None,
    expert_name: object = None,
    pack_id: object = None,
    last_status: object = None,
    last_detail: object = None,
    last_task_id: object = None,
    panel_agents: object = None,
    plan_tree: object = None,
    usage_snapshot: object = None,
    usage_mode: str = "replace",  # replace | merge_max
    touch: bool = True,
) -> dict[str, Any]:
    """Insert or update one Case participant; returns new context dict."""
    ctx = dict(context or {})
    pack = str(pack_id or "").strip() or "default"
    name = str(expert_name or "").strip() or pack
    eid = str(expert_id or "").strip()
    key = participant_key(expert_id=eid or None, pack_id=pack, expert_name=name)
    roster = participants_map(ctx)
    prev = dict(roster.get(key) or {})

    row: dict[str, Any] = {
        **prev,
        "key": key,
        "expert_id": eid or prev.get("expert_id") or "",
        "expert_name": name or prev.get("expert_name") or pack,
        "pack_id": pack or prev.get("pack_id") or "default",
    }
    if last_status is not None and str(last_status).strip():
        row["last_status"] = str(last_status).strip().lower()
    elif not row.get("last_status"):
        row["last_status"] = "idle"
    if last_detail is not None:
        text = str(last_detail).strip()
        if text:
            row["last_detail"] = text[:200]
    if last_task_id is not None and str(last_task_id).strip():
        row["last_task_id"] = str(last_task_id).strip()
    if isinstance(panel_agents, list):
        row["panel_agents"] = [dict(a) for a in panel_agents if isinstance(a, dict)]
    # panel_agents=None means leave previous tree in place (e.g. idle mark)
    if isinstance(plan_tree, list):
        stamped: list[dict[str, Any]] = []
        for item in plan_tree:
            if not isinstance(item, dict):
                continue
            node = dict(item)
            if eid and not node.get("owner_expert_id"):
                node["owner_expert_id"] = eid
            if name and not node.get("owner_expert_name"):
                node["owner_expert_name"] = name
            stamped.append(node)
        row["plan_tree"] = stamped

    if isinstance(usage_snapshot, dict):
        prev_u = _as_dict(row.get("usage"))
        snap = {
            "total_tokens": int(_num(usage_snapshot.get("total_tokens"))),
            "cost": float(_num(usage_snapshot.get("cost"))),
            "requests": int(_num(usage_snapshot.get("requests"))),
        }
        if usage_mode == "merge_max":
            # Avoid double-count when checkpoint reports cumulative burst usage:
            # keep the max seen for this participant (burst restarts reset task tokens).
            row["usage"] = {
                "total_tokens": max(int(_num(prev_u.get("total_tokens"))), snap["total_tokens"]),
                "cost": max(float(_num(prev_u.get("cost"))), snap["cost"]),
                "requests": max(int(_num(prev_u.get("requests"))), snap["requests"]),
            }
        else:
            row["usage"] = snap

    if touch:
        row["last_seen_at"] = _now_iso()

    roster[key] = row
    ctx["participants"] = roster
    return recompute_case_run(ctx)


def recompute_case_run(context: dict | None) -> dict[str, Any]:
    """Roll up Case-level started_at + llm_usage from participants."""
    ctx = dict(context or {})
    roster = participants_map(ctx)
    tokens = 0
    cost = 0.0
    requests = 0
    earliest: str | None = None
    latest: str | None = None
    for row in roster.values():
        u = _as_dict(row.get("usage"))
        tokens += int(_num(u.get("total_tokens")))
        cost += float(_num(u.get("cost")))
        requests += int(_num(u.get("requests")))
        seen = str(row.get("last_seen_at") or "").strip()
        if seen:
            if earliest is None or seen < earliest:
                earliest = seen
            if latest is None or seen > latest:
                latest = seen
    prev_run = _as_dict(ctx.get("case_run"))
    started = str(prev_run.get("started_at") or "").strip() or earliest
    case_run = {
        "started_at": started,
        "last_active_at": latest or prev_run.get("last_active_at"),
        "llm_usage": {
            "total_tokens": tokens,
            "cost": round(cost, 6),
            "requests": requests,
        },
        "participant_count": len(roster),
    }
    ctx["case_run"] = case_run
    return ctx


def apply_checkpoint_to_participant(
    context: dict | None,
    checkpoint: dict | None,
    *,
    expert_id: object = None,
    expert_name: object = None,
    pack_id: object = None,
    task_id: object = None,
    running: bool = True,
) -> dict[str, Any]:
    """Merge live checkpoint into the matching participant."""
    cp = checkpoint if isinstance(checkpoint, dict) else {}
    pack = str(pack_id or cp.get("role_pack") or cp.get("engagement") or "default").strip()
    # Panel main name may be expert persona
    panel = cp.get("panel_agents") if isinstance(cp.get("panel_agents"), list) else []
    main_name = ""
    main_detail = ""
    for item in panel:
        if not isinstance(item, dict):
            continue
        if str(item.get("parent_id") or "").strip():
            continue
        main_name = str(item.get("name") or "").strip()
        main_detail = str(item.get("current_detail") or item.get("current_action") or "").strip()
        break
    name = str(expert_name or main_name or pack).strip()
    status = "running" if running else "idle"
    usage = cp.get("llm_usage") if isinstance(cp.get("llm_usage"), dict) else None
    plan = cp.get("plan_tree") if isinstance(cp.get("plan_tree"), list) else None
    if plan is None and isinstance(cp.get("exploration_plan_tree"), list):
        plan = cp.get("exploration_plan_tree")
    return upsert_participant(
        context,
        expert_id=expert_id,
        expert_name=name,
        pack_id=pack,
        last_status=status,
        last_detail=main_detail or None,
        last_task_id=task_id or cp.get("task_id"),
        panel_agents=panel,
        plan_tree=plan,
        usage_snapshot=usage,
        usage_mode="merge_max",
        touch=True,
    )


def apply_plan_tree_to_participant(
    context: dict | None,
    plan_tree: object,
    *,
    expert_id: object = None,
    expert_name: object = None,
    pack_id: object = None,
    task_id: object = None,
) -> dict[str, Any]:
    """Store a role's todo plan on its Case participant (does not wipe other roles)."""
    if not isinstance(plan_tree, list):
        return dict(context or {})
    return upsert_participant(
        context,
        expert_id=expert_id,
        expert_name=expert_name,
        pack_id=pack_id,
        last_task_id=task_id,
        plan_tree=plan_tree,
        touch=True,
    )


def plan_tree_from_participants(context: dict | None) -> list[dict[str, Any]]:
    """Flatten per-role plan trees (owner stamped) for the Case Tasks list."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in participants_list(context):
        eid = str(row.get("expert_id") or "").strip()
        ename = str(row.get("expert_name") or "").strip()
        tree = row.get("plan_tree") if isinstance(row.get("plan_tree"), list) else []
        for item in tree:
            if not isinstance(item, dict):
                continue
            node = dict(item)
            if eid and not node.get("owner_expert_id"):
                node["owner_expert_id"] = eid
            if ename and not node.get("owner_expert_name"):
                node["owner_expert_name"] = ename
            nid = str(node.get("node_id") or node.get("id") or "").strip()
            # Namespaced by owner so two roles can share the same local todo id.
            owner = str(node.get("owner_expert_id") or node.get("owner_expert_name") or "")
            dedupe = f"{owner}:{nid or node.get('title')}"
            if dedupe in seen:
                continue
            seen.add(dedupe)
            if nid and owner and not nid.startswith(f"owner-"):
                # Keep original node_id; frontend merges by owner fields.
                pass
            out.append(node)
    return out


def mark_participant_idle(
    context: dict | None,
    *,
    expert_id: object = None,
    expert_name: object = None,
    pack_id: object = None,
    last_detail: object = None,
) -> dict[str, Any]:
    return upsert_participant(
        context,
        expert_id=expert_id,
        expert_name=expert_name,
        pack_id=pack_id,
        last_status="idle",
        last_detail=last_detail if last_detail is not None else "本轮工作已结束",
        panel_agents=None,  # keep previous panel_agents
        touch=True,
    )


def participants_list(context: dict | None) -> list[dict[str, Any]]:
    """Sorted: running first, then last_seen desc."""
    rows = list(participants_map(context).values())

    def sort_key(row: dict[str, Any]) -> tuple:
        st = str(row.get("last_status") or "").lower()
        running = 0 if st in {"running", "tool_running", "llm_waiting", "working", "chat", "starting"} else 1
        seen = str(row.get("last_seen_at") or "")
        return (running, 0 if seen else 1, "-" + seen, str(row.get("expert_name") or ""))

    rows.sort(key=sort_key)
    return rows


def agents_from_participants(
    context: dict | None,
    *,
    conversation_status: str | None = None,
    active_expert_id: object = None,
) -> list[dict[str, Any]]:
    """
    Build UI strix_agents-shaped list: one root per Case participant,
    with last burst subagents nested under that root.
    """
    workers = _as_dict(_as_dict(context).get("workers"))
    busy_expert_ids: set[str] = set()
    busy_names: set[str] = set()
    for meta in workers.values():
        if not isinstance(meta, dict):
            continue
        eid = str(meta.get("expert_id") or "").strip()
        ename = str(meta.get("expert_name") or "").strip().lower()
        if eid:
            busy_expert_ids.add(eid)
        if ename:
            busy_names.add(ename)

    active_eid = str(active_expert_id or "").strip()
    out: list[dict[str, Any]] = []
    for row in participants_list(context):
        eid = str(row.get("expert_id") or "").strip()
        ename = str(row.get("expert_name") or row.get("pack_id") or "Agent").strip()
        pack = str(row.get("pack_id") or "default").strip()
        key = str(row.get("key") or participant_key(expert_id=eid, pack_id=pack, expert_name=ename))
        root_id = f"role-{_slug(key, pack)}"
        st = str(row.get("last_status") or "idle").lower()
        is_busy = (eid and eid in busy_expert_ids) or (ename.lower() in busy_names) or st == "running"
        if is_busy:
            status = "running"
        elif st in {"failed", "stopped", "aborted"}:
            status = st
        elif st in {"completed", "done"}:
            status = "completed"
        else:
            status = "idle"

        detail = str(row.get("last_detail") or "").strip()
        if status == "idle" and not detail:
            detail = "空闲"

        root = {
            "id": root_id,
            "name": ename,
            "status": status,
            "parent_id": None,
            "task": "",
            "skills": [],
            "pending_count": 0,
            "role": "main",
            "pack_id": pack,
            "expert_id": eid,
            "current_tool": "",
            "current_action": status,
            "current_detail": detail,
            "highlighted": bool(active_eid and eid and active_eid == eid),
        }
        # Pull live tool from nested panel main if running
        panel = row.get("panel_agents") if isinstance(row.get("panel_agents"), list) else []
        children: list[dict[str, Any]] = []
        for item in panel:
            if not isinstance(item, dict):
                continue
            parent = str(item.get("parent_id") or "").strip()
            item_id = str(item.get("id") or "").strip()
            if not item_id:
                continue
            if not parent:
                # Merge live main fields into root
                if status == "running":
                    root["current_tool"] = str(item.get("current_tool") or "")
                    root["current_action"] = str(item.get("current_action") or root["current_action"])
                    if item.get("current_detail"):
                        root["current_detail"] = str(item.get("current_detail"))
                continue
            # Subagent under this role
            children.append(
                {
                    "id": f"{root_id}-{item_id}",
                    "name": str(item.get("name") or item_id),
                    "status": str(item.get("status") or "running"),
                    "parent_id": root_id,
                    "task": str(item.get("task") or ""),
                    "skills": item.get("skills") if isinstance(item.get("skills"), list) else [],
                    "pending_count": int(item.get("pending_count") or 0),
                    "role": "subagent",
                    "pack_id": pack,
                    "expert_id": eid,
                    "current_tool": str(item.get("current_tool") or ""),
                    "current_action": str(item.get("current_action") or ""),
                    "current_detail": str(item.get("current_detail") or item.get("task") or ""),
                }
            )
        out.append(root)
        out.extend(children)

    # conversation_status terminal folding applied by caller (conversation_snapshot)
    _ = conversation_status
    return out
