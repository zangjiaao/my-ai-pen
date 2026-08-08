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


def _usage_fields(raw: object) -> dict[str, Any]:
    """Normalize LLM usage scalars (+ optional model). Spec #324 S1."""
    src = _as_dict(raw)
    out: dict[str, Any] = {
        "total_tokens": int(_num(src.get("total_tokens"))),
        "cost": round(float(_num(src.get("cost"))), 6),
        "requests": int(_num(src.get("requests"))),
    }
    model = str(src.get("model") or "").strip()
    if model:
        out["model"] = model
    return out


def merge_usage_lifetime(
    lifetime: object,
    cursor: object,
    snap: object,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Monotonic lifetime totals from burst-resettable cumulative snapshots.

    Checkpoints report per-burst cumulative usage that restarts near zero on a
    new work-burst. When the snap is >= cursor, add the delta; when it drops
    (burst reset), add the whole snap so prior bursts are not lost (Z1).

    Returns (lifetime_usage, new_cursor). Does not double-count within one
    continuous cumulative series.
    """
    life = _usage_fields(lifetime)
    cur = _usage_fields(cursor)
    s = _usage_fields(snap)

    def delta(life_v: float, cur_v: float, snap_v: float) -> float:
        if snap_v >= cur_v:
            return snap_v - cur_v
        return snap_v

    new_life: dict[str, Any] = {
        "total_tokens": int(life["total_tokens"] + delta(life["total_tokens"], cur["total_tokens"], s["total_tokens"])),
        "cost": round(
            float(life["cost"]) + delta(float(life["cost"]), float(cur["cost"]), float(s["cost"])),
            6,
        ),
        "requests": int(life["requests"] + delta(life["requests"], cur["requests"], s["requests"])),
    }
    model = s.get("model") or life.get("model")
    if model:
        new_life["model"] = str(model)
    return new_life, s


def _panel_children_usage_sum(panel: object) -> dict[str, Any]:
    """Sum Sub/child usage rows (parent_id set). Main row is excluded."""
    tokens = 0
    cost = 0.0
    requests = 0
    if not isinstance(panel, list):
        return _usage_fields({})
    for item in panel:
        if not isinstance(item, dict):
            continue
        if not str(item.get("parent_id") or "").strip():
            continue
        u = _usage_fields(item.get("usage") or item.get("llm_usage"))
        tokens += int(u["total_tokens"])
        cost += float(u["cost"])
        requests += int(u["requests"])
    return {
        "total_tokens": tokens,
        "cost": round(cost, 6),
        "requests": requests,
    }


def ensure_usage_own(row: dict[str, Any]) -> dict[str, Any]:
    """Migrate pre-S1 rows: historical ``usage`` was own/checkpoint-only.

    Seed ``usage_cursor`` to the same baseline so the first post-upgrade
    ``merge_usage_lifetime`` does not re-add the entire prior total
    (snap − 0 would double-count; Spec #323 / #324 L3).
    """
    if row.get("usage_own") is None and isinstance(row.get("usage"), dict):
        # Copy scalars only — do not keep a pointer to the display dict.
        migrated = _usage_fields(row.get("usage"))
        row["usage_own"] = migrated
        if row.get("usage_cursor") is None:
            row["usage_cursor"] = dict(migrated)
    elif (
        isinstance(row.get("usage_own"), dict)
        and row.get("usage_cursor") is None
    ):
        # Own exists without cursor (partial write) — baseline cursor at current own.
        row["usage_cursor"] = _usage_fields(row.get("usage_own"))
    return row


def rollup_participant_usage(row: dict | None) -> dict[str, Any]:
    """Participant display usage = own lifetime + Sub children (no double-count).

    ``usage_own`` is Main/own metered lifetime. Child rows on ``panel_agents``
    carry their own usage; they are folded once into the parent total. Case
    rollup sums these parent totals only (children are not separate Case rows).

    Never re-read rolled ``usage`` as own — that would double-count children on
    repeated recompute.
    """
    r = dict(_as_dict(row))
    ensure_usage_own(r)
    own = _usage_fields(r.get("usage_own"))
    children = _panel_children_usage_sum(r.get("panel_agents"))
    out: dict[str, Any] = {
        "total_tokens": int(own["total_tokens"]) + int(children["total_tokens"]),
        "cost": round(float(own["cost"]) + float(children["cost"]), 6),
        "requests": int(own["requests"]) + int(children["requests"]),
    }
    model = own.get("model")
    if model:
        out["model"] = str(model)
    return out


_RUNNING_PANEL_STATUSES = frozenset(
    {"running", "tool_running", "llm_waiting", "starting", "working", "chat"}
)


def merge_panel_agents(prev: object, incoming: object) -> list[dict[str, Any]]:
    """Merge a live burst panel into the Case participant's historical roster.

    Canonical write-path for Case Subagent history (frontend live merge is thinner
    and must not invent terminal status).

    Invariant: children are append/upsert by id — never dropped because a new
    work burst (re-chat) emits main-only. No prune / no task_id bucketing yet;
    same id across bursts overwrites the prior row.

    Rules:
    - Main (no parent_id): take from incoming when present.
    - Children: upsert by id; keep previous children not in the new panel.
    - Orphan children still marked running are settled to completed (burst left).
    """
    prev_list = [dict(a) for a in (prev or []) if isinstance(a, dict) and str(a.get("id") or "").strip()]
    inc_list = [dict(a) for a in (incoming or []) if isinstance(a, dict) and str(a.get("id") or "").strip()]
    if not inc_list:
        return prev_list
    if not prev_list:
        return inc_list

    by_id: dict[str, dict[str, Any]] = {str(a["id"]): dict(a) for a in prev_list}
    inc_ids = {str(a["id"]) for a in inc_list}
    for a in inc_list:
        aid = str(a["id"])
        incoming = dict(a)
        prev_row = by_id.get(aid)
        # Spec #324: keep Sub usage lifetime when the same id is re-emitted.
        snap_u = incoming.get("usage") if isinstance(incoming.get("usage"), dict) else None
        if snap_u is None and isinstance(incoming.get("llm_usage"), dict):
            snap_u = incoming.get("llm_usage")
        if isinstance(snap_u, dict):
            prev_life = _as_dict(prev_row).get("usage") if prev_row else None
            prev_cur = _as_dict(prev_row).get("usage_cursor") if prev_row else None
            life, cur = merge_usage_lifetime(prev_life, prev_cur, snap_u)
            incoming["usage"] = life
            incoming["usage_cursor"] = cur
        elif prev_row and isinstance(prev_row.get("usage"), dict):
            incoming["usage"] = dict(prev_row["usage"])
            if isinstance(prev_row.get("usage_cursor"), dict):
                incoming["usage_cursor"] = dict(prev_row["usage_cursor"])
        by_id[aid] = incoming

    for aid, row in by_id.items():
        if aid in inc_ids:
            continue
        if not str(row.get("parent_id") or "").strip():
            continue
        st = str(row.get("status") or "").lower()
        if st in _RUNNING_PANEL_STATUSES:
            row["status"] = "completed"
            row["current_action"] = "completed"

    main_id = ""
    for a in inc_list:
        if not str(a.get("parent_id") or "").strip():
            main_id = str(a["id"])
            break
    if not main_id:
        for a in prev_list:
            if not str(a.get("parent_id") or "").strip():
                main_id = str(a["id"])
                break

    out: list[dict[str, Any]] = []
    if main_id and main_id in by_id:
        out.append(by_id[main_id])

    seen_kids: set[str] = set()
    for source in (prev_list, inc_list):
        for a in source:
            aid = str(a.get("id") or "")
            if not aid or aid == main_id or aid in seen_kids:
                continue
            row = by_id.get(aid)
            if not row or not str(row.get("parent_id") or "").strip():
                continue
            out.append(row)
            seen_kids.add(aid)
    return out


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


# ---------------------------------------------------------------------------
# Spec #308 — Case Worker display_name overrides (platform-owned)
# ---------------------------------------------------------------------------

_MAX_WORKER_DISPLAY_NAME = 64
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def worker_display_names_map(context: dict | None) -> dict[str, str]:
    """Return agent_id → display_name overrides from Case context."""
    raw = _as_dict(context).get("worker_display_names")
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in raw.items():
        aid = str(key or "").strip()
        name = str(value or "").strip()
        if aid and name:
            out[aid] = name
    return out


def validate_worker_display_name(raw: object) -> str | None:
    """Return trimmed name, empty string to clear, or None if invalid."""
    if raw is None:
        return ""
    text = str(raw).strip()
    if not text:
        return ""
    if _CONTROL_CHARS.search(text):
        return None
    if len(text) > _MAX_WORKER_DISPLAY_NAME:
        return None
    return text


def set_worker_display_name(
    context: dict | None,
    *,
    agent_id: object,
    display_name: object,
) -> dict[str, Any] | None:
    """Upsert or clear a Case Worker display_name override.

    Returns new context dict, or None if agent_id/display_name invalid.
    Empty display_name clears the override (fallback to panel Worker N).
    """
    aid = str(agent_id or "").strip()
    if not aid or len(aid) > 128:
        return None
    name = validate_worker_display_name(display_name)
    if name is None:
        return None
    ctx = dict(context or {})
    names = worker_display_names_map(ctx)
    if not name:
        names.pop(aid, None)
    else:
        names[aid] = name
    if names:
        ctx["worker_display_names"] = names
    else:
        ctx.pop("worker_display_names", None)
    return ctx


def resolve_worker_display_name(
    *,
    agent_id: object,
    override: object = None,
    panel_name: object = None,
    worker_ordinal: object = None,
) -> str:
    """S1 resolve: user_display_name ?? panel_agents.name ?? Worker N."""
    ov = str(override or "").strip()
    if ov:
        return ov
    pn = str(panel_name or "").strip()
    if pn:
        return pn
    try:
        n = int(worker_ordinal)  # type: ignore[arg-type]
        if n >= 1:
            return f"Worker {n}"
    except (TypeError, ValueError):
        pass
    return "Worker"


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
    usage_mode: str = "replace",  # replace | merge_max | lifetime
    touch: bool = True,
    # pi-agent-core Agent.sessionId from Node (collab copy only; never expert catalog).
    pi_agent_session_id: object = None,
) -> dict[str, Any]:
    """Insert or update one Case participant; returns new context dict."""
    ctx = dict(context or {})
    pack = str(pack_id or "").strip() or "default"
    name = str(expert_name or "").strip() or pack
    eid = str(expert_id or "").strip()
    key = participant_key(expert_id=eid or None, pack_id=pack, expert_name=name)
    roster = participants_map(ctx)
    prev = dict(roster.get(key) or {})

    # Collab Session id = pi-agent-core Agent.sessionId only (Node SoT).
    # Do not invent platform UUIDs or expert:{catalog} keys for copy chrome.
    incoming_pi = str(pi_agent_session_id or "").strip()
    if incoming_pi.startswith("expert:") or incoming_pi.startswith("pack:"):
        incoming_pi = ""
    prev_pi = str(prev.get("session_instance_id") or "").strip()
    if prev_pi.startswith("expert:") or prev_pi.startswith("pack:"):
        prev_pi = ""

    row: dict[str, Any] = {
        **prev,
        "key": key,
        "expert_id": eid or prev.get("expert_id") or "",
        "expert_name": name or prev.get("expert_name") or pack,
        "pack_id": pack or prev.get("pack_id") or "default",
    }
    if incoming_pi:
        row["session_instance_id"] = incoming_pi
    elif prev_pi:
        row["session_instance_id"] = prev_pi
    else:
        row.pop("session_instance_id", None)
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
        prev_panel = prev.get("panel_agents") if isinstance(prev.get("panel_agents"), list) else []
        # Merge so a new burst's main-only panel cannot wipe prior Subagents.
        row["panel_agents"] = merge_panel_agents(prev_panel, panel_agents)
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
        snap = _usage_fields(usage_snapshot)
        # model may arrive only on the snapshot (metered/configured id).
        if usage_mode == "merge_max" or usage_mode == "lifetime":
            # Spec #324 S1: monotonic lifetime across bursts (not plain max — multi-burst
            # must accumulate; max under-counts when a later burst is smaller).
            ensure_usage_own(row)
            life, cur = merge_usage_lifetime(row.get("usage_own"), row.get("usage_cursor"), snap)
            row["usage_own"] = life
            row["usage_cursor"] = cur
        else:
            # replace: treat snap as the full own lifetime (tests / explicit reset only).
            row["usage_own"] = snap
            row["usage_cursor"] = snap

    ensure_usage_own(row)
    # Display usage = own + Sub children (single-count). Always refresh after panel/usage writes.
    row["usage"] = rollup_participant_usage(row)

    if touch:
        row["last_seen_at"] = _now_iso()

    roster[key] = row
    ctx["participants"] = roster
    return recompute_case_run(ctx)


def recompute_case_run(context: dict | None) -> dict[str, Any]:
    """Roll up Case-level started_at + llm_usage from participants (incl. Sub once)."""
    ctx = dict(context or {})
    roster = participants_map(ctx)
    tokens = 0
    cost = 0.0
    requests = 0
    earliest: str | None = None
    latest: str | None = None
    for key, row in list(roster.items()):
        # Keep display usage coherent even if panel_agents were patched in place.
        row = dict(row)
        ensure_usage_own(row)
        rolled = rollup_participant_usage(row)
        row["usage"] = rolled
        roster[key] = row
        tokens += int(rolled["total_tokens"])
        cost += float(rolled["cost"])
        requests += int(rolled["requests"])
        seen = str(row.get("last_seen_at") or "").strip()
        if seen:
            if earliest is None or seen < earliest:
                earliest = seen
            if latest is None or seen > latest:
                latest = seen
    ctx["participants"] = roster
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
    # Node projects pi-agent-core Agent.sessionId on checkpoints (collab copy SoT).
    pi_sid = str(cp.get("agent_session_id") or "").strip() or None
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
        pi_agent_session_id=pi_sid,
    )


def apply_plan_tree_to_participant(
    context: dict | None,
    plan_tree: object,
    *,
    expert_id: object = None,
    expert_name: object = None,
    pack_id: object = None,
    task_id: object = None,
    task_map_revisions: object = None,
    live_revision_id: object = None,
    live_sealed: object = None,
) -> dict[str, Any]:
    """Store a role's todo plan on its Case participant (does not wipe other roles).

    Spec #321: optional Task Map revision list is Session/participant-scoped so
    multi-role Cases do not merge maps into one fake list.
    """
    if not isinstance(plan_tree, list):
        return dict(context or {})
    ctx = upsert_participant(
        context,
        expert_id=expert_id,
        expert_name=expert_name,
        pack_id=pack_id,
        last_task_id=task_id,
        plan_tree=plan_tree,
        touch=True,
    )
    if task_map_revisions is not None or live_revision_id is not None or live_sealed is not None:
        ctx = apply_task_map_to_participant(
            ctx,
            task_map_revisions=task_map_revisions,
            live_revision_id=live_revision_id,
            live_sealed=live_sealed,
            expert_id=expert_id,
            expert_name=expert_name,
            pack_id=pack_id,
            task_id=task_id,
        )
    return ctx


def apply_task_map_to_participant(
    context: dict | None,
    *,
    task_map_revisions: object = None,
    live_revision_id: object = None,
    live_sealed: object = None,
    expert_id: object = None,
    expert_name: object = None,
    pack_id: object = None,
    task_id: object = None,
) -> dict[str, Any]:
    """Spec #321: persist Task Map history on the matching participant (immutable archives)."""
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
    if isinstance(task_map_revisions, list):
        # Deep-copy + merge by id so a Node cold-start with a shorter list cannot
        # wipe Session history (Spec #321 retention for Case/Session lifetime).
        try:
            import copy

            incoming = copy.deepcopy(task_map_revisions)
        except Exception:
            incoming = list(task_map_revisions)
        prev_revs = prev.get("task_map_revisions") if isinstance(prev.get("task_map_revisions"), list) else []
        row["task_map_revisions"] = merge_task_map_revisions(prev_revs, incoming)
    if live_revision_id is not None:
        lid = str(live_revision_id).strip() if live_revision_id is not None else ""
        row["live_revision_id"] = lid or None
    if live_sealed is not None:
        row["live_sealed"] = bool(live_sealed)
    if task_id is not None and str(task_id).strip():
        row["last_task_id"] = str(task_id).strip()
    roster[key] = row
    ctx["participants"] = roster
    return ctx


def merge_task_map_revisions(previous: list, incoming: list) -> list[dict[str, Any]]:
    """Union revisions by id; incoming wins on conflict. Prefer stable archive order.

    At most one is_live row after merge: when incoming declares a live id, prior
    lives not present as live in incoming are demoted to archived (keeps history).
    """
    by_id: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    incoming_live: set[str] = set()
    if isinstance(incoming, list):
        for item in incoming:
            if isinstance(item, dict) and item.get("is_live"):
                rid = str(item.get("id") or "").strip()
                if rid:
                    incoming_live.add(rid)
    for src in (previous, incoming):
        if not isinstance(src, list):
            continue
        for item in src:
            if not isinstance(item, dict):
                continue
            rid = str(item.get("id") or "").strip()
            if not rid:
                continue
            if rid not in by_id:
                order.append(rid)
            by_id[rid] = dict(item)
    if incoming_live:
        for rid, item in list(by_id.items()):
            if item.get("is_live") and rid not in incoming_live:
                demoted = dict(item)
                demoted["is_live"] = False
                by_id[rid] = demoted
    # Live rows last; archived keep first-seen order.
    archived = [by_id[i] for i in order if not by_id[i].get("is_live")]
    live = [by_id[i] for i in order if by_id[i].get("is_live")]
    return archived + live


def task_map_projection_from_participants(context: dict | None) -> dict[str, Any]:
    """Spec #321: Case-level Task Map projection from the active/primary participant.

    Multi-role: each participant keeps its own revisions; snapshot exposes the
    union metadata list tagged with owner when multiple roles have maps, but
    live_revision_id stays the single writable live of the most recently updated
    participant that has a live map (not a merged fake checklist).

    Returned revision payloads are deep-copied so consumers cannot mutate archives.
    """
    import copy

    revisions: list[dict[str, Any]] = []
    live_id: str | None = None
    live_sealed = False
    seen_ids: set[str] = set()
    for row in participants_list(context):
        eid = str(row.get("expert_id") or "").strip()
        ename = str(row.get("expert_name") or "").strip()
        revs = row.get("task_map_revisions") if isinstance(row.get("task_map_revisions"), list) else []
        for item in revs:
            if not isinstance(item, dict):
                continue
            rid = str(item.get("id") or "").strip()
            if rid and rid in seen_ids:
                continue
            if rid:
                seen_ids.add(rid)
            node = copy.deepcopy(item)
            if eid and not node.get("owner_expert_id"):
                node["owner_expert_id"] = eid
            if ename and not node.get("owner_expert_name"):
                node["owner_expert_name"] = ename
            revisions.append(node)
        row_live = str(row.get("live_revision_id") or "").strip()
        if row_live:
            live_id = row_live
            live_sealed = bool(row.get("live_sealed"))
    # Case-level honesty: only the Case live_revision_id is is_live.
    if live_id:
        for node in revisions:
            node["is_live"] = str(node.get("id") or "") == live_id
    return {
        "task_map_revisions": revisions,
        "live_revision_id": live_id,
        "live_sealed": live_sealed,
    }


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
    # Spec #324: do not invent work-content narration on idle; runtime is dot+badge.
    return upsert_participant(
        context,
        expert_id=expert_id,
        expert_name=expert_name,
        pack_id=pack_id,
        last_status="idle",
        last_detail=last_detail if last_detail is not None else "",
        panel_agents=None,  # keep previous panel_agents
        touch=True,
    )


def remove_participant(
    context: dict | None,
    *,
    expert_id: object = None,
    pack_id: object = None,
    expert_name: object = None,
) -> dict[str, Any]:
    """Spec #354 L10: remove Case roster row after Session Delete so collab UI drops the card."""
    ctx = dict(context or {})
    roster = participants_map(ctx)
    if not roster:
        return ctx
    eid = str(expert_id or "").strip()
    pack = str(pack_id or "").strip()
    name = str(expert_name or "").strip()
    keys_to_drop: list[str] = []
    if eid:
        # Drop any row whose expert_id matches (key may be expert:{id} or pack:...).
        for key, row in roster.items():
            if not isinstance(row, dict):
                continue
            if str(row.get("expert_id") or "").strip() == eid:
                keys_to_drop.append(key)
            elif key == f"expert:{eid}" or key.endswith(f":{eid}"):
                keys_to_drop.append(key)
    else:
        key = participant_key(expert_id=None, pack_id=pack or None, expert_name=name or None)
        if key in roster:
            keys_to_drop.append(key)
    if not keys_to_drop:
        return ctx
    for key in keys_to_drop:
        roster.pop(key, None)
    # Keep empty dict (not pop) so snapshot does not fall back to checkpoint panel_agents
    # and resurrect a ghost Main card after Session Delete (Spec #354).
    ctx["participants"] = roster
    return recompute_case_run(ctx)


def settle_context_after_session_delete(
    context: dict | None,
    *,
    expert_id: object = None,
) -> dict[str, Any]:
    """Spec #354: after Session Delete mid-run, close package busy state on the Case.

    - Drop workers tied to this expert (or all if expert unknown)
    - Clear interrupt_pending / active_task_id when no workers remain
    - Clear checkpoint panel_agents ghosts when roster empty
    Does not invent new participants.
    """
    ctx = dict(context or {})
    eid = str(expert_id or "").strip()
    workers_raw = ctx.get("workers") if isinstance(ctx.get("workers"), dict) else {}
    new_workers: dict[str, Any] = {}
    for nid, meta in workers_raw.items():
        if not isinstance(meta, dict):
            continue
        meta_eid = str(meta.get("expert_id") or "").strip()
        if eid and meta_eid and meta_eid != eid:
            new_workers[str(nid)] = meta
            continue
        # Drop matching expert worker, or drop all when expert unknown / untagged.
        if eid and meta_eid and meta_eid == eid:
            continue
        if eid and not meta_eid:
            # Untagged worker on single-node Cases usually belongs to the deleted Session.
            continue
        if not eid:
            continue
        new_workers[str(nid)] = meta
    if not eid:
        new_workers = {}
    ctx["workers"] = new_workers
    ctx.pop("interrupt_pending", None)
    if not new_workers:
        ctx.pop("active_task_id", None)
        # Soft-close work-burst ledger if open.
        try:
            from app.services.work_burst_time import finalize_burst, get_ledger, set_ledger

            ledger = get_ledger(ctx)
            if ledger.get("active_burst_id"):
                ctx = set_ledger(ctx, finalize_burst(ledger))
        except Exception:
            pass
    # Ghost Main from checkpoint.panel_agents when participants empty.
    roster = participants_map(ctx)
    if not roster:
        cp = dict(ctx.get("checkpoint") or {}) if isinstance(ctx.get("checkpoint"), dict) else {}
        if cp:
            if "panel_agents" in cp:
                cp["panel_agents"] = []
            node3 = cp.get("node3_strix") if isinstance(cp.get("node3_strix"), dict) else None
            if node3 is not None:
                ns = dict(node3)
                ns["agents"] = []
                cp["node3_strix"] = ns
            ctx["checkpoint"] = cp
    return ctx


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
        usage = rollup_participant_usage(row)

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
            # Spec #324 D1: Participant cumulative usage for AgentRow (own + Subs).
            "usage": usage,
            "model": usage.get("model") or "",
        }
        # Spec #278: Free/Graph badge is Session harness, not burst-ephemeral.
        # Prefer Participant Session work_mode (context.sessions), then last panel main.
        try:
            from app.services.participant_session import session_record_from_context

            sess = session_record_from_context(context, eid)
            swm = str(sess.get("work_mode") or "").strip().lower()
            if swm == "free":
                root["work_mode"] = "free"
            elif swm == "graph":
                root["work_mode"] = "graph"
                sgid = str(sess.get("graph_id") or "").strip()
                if sgid:
                    root["graph_id"] = sgid
        except Exception:
            pass
        # Collab copy: pi-agent-core Agent.sessionId only (never expert catalog / roster key).
        pi_sid = str(row.get("session_instance_id") or "").strip()
        if pi_sid and not pi_sid.startswith("expert:") and not pi_sid.startswith("pack:") and pi_sid != key:
            root["session_id"] = pi_sid
        # Pull live tool / harness fields from nested panel main
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
                # Always lift work_mode from last panel Main (Node stamps Free/Graph on every list()).
                pwm = str(item.get("work_mode") or "").strip().lower()
                if pwm == "free":
                    root["work_mode"] = "free"
                    root.pop("graph_id", None)
                    root.pop("graph_label", None)
                elif pwm == "graph" or pwm.startswith("hard_graph"):
                    root["work_mode"] = "graph"
                    gid = str(item.get("graph_id") or "").strip()
                    if not gid and pwm.startswith("hard_graph:"):
                        parts = pwm.split(":")
                        gid = parts[1] if len(parts) > 1 else ""
                    if gid:
                        root["graph_id"] = gid
                    glabel = str(item.get("graph_label") or "").strip()
                    if glabel:
                        root["graph_label"] = glabel
                # Collab copy: panel Main may carry pi Agent.sessionId when top-level missed.
                panel_sid = str(item.get("session_id") or "").strip()
                if (
                    panel_sid
                    and not panel_sid.startswith("expert:")
                    and not panel_sid.startswith("pack:")
                    and not root.get("session_id")
                ):
                    root["session_id"] = panel_sid
                # Activity chrome only while running (idle keeps last_detail).
                if status == "running":
                    root["current_tool"] = str(item.get("current_tool") or "")
                    root["current_action"] = str(item.get("current_action") or root["current_action"])
                    if item.get("current_detail"):
                        root["current_detail"] = str(item.get("current_detail"))
                continue
            # Subagent under this role
            child_usage = _usage_fields(item.get("usage") or item.get("llm_usage"))
            child: dict[str, Any] = {
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
            if any(int(child_usage.get(k) or 0) for k in ("total_tokens", "requests")) or float(
                child_usage.get("cost") or 0
            ) > 0:
                child["usage"] = child_usage
                if child_usage.get("model"):
                    child["model"] = child_usage["model"]
            children.append(child)
        out.append(root)
        out.extend(children)

    # conversation_status terminal folding applied by caller (conversation_snapshot)
    _ = conversation_status
    return out
