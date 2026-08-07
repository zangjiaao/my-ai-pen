"""Spec #312 — Unified Choice Card pure contracts (S1–S3).

Agent-authored options; platform validates / expands / soft-gates only.
Does not invent engagement or option bodies from Workset titles.
"""
from __future__ import annotations

from typing import Any

NEXT_STEPS_MIN = 2
NEXT_STEPS_MAX = 5

SOFT_GATE_NOTE = (
    "Soft gate (Spec #312/#313): stoppable/continue boundary with open Case Workset "
    "(or open priors) but no legal next_steps choice card was offered. "
    "Emit one request_user_decision(kind=next_steps) with 2–5 curated options "
    "(title + body; optional workset_item_ids binds; single-select default). "
    "Do not only say 等待指示 or prose A/B/C/D menus. "
    "Do not invent inventory chips as the product path."
)

SOFT_GATE_CONTEXT_KEY = "soft_gate_next_steps_injected"


def _s(v: object) -> str:
    return str(v or "").strip()


def is_next_steps_choice(content: dict | None) -> bool:
    if not isinstance(content, dict):
        return False
    kind = _s(content.get("kind")).lower()
    if kind == "next_steps":
        return True
    opts = content.get("options")
    if not isinstance(opts, list) or not opts:
        return False
    return all(isinstance(o, dict) for o in opts)


def validate_choice_card_payload(raw: object) -> dict[str, Any]:
    """S1 — Return {ok, mode?, value?, errors?}."""
    if not isinstance(raw, dict):
        return {"ok": False, "errors": ["payload must be an object"]}

    kind = _s(raw.get("kind")).lower() or "confirm"
    is_next = kind == "next_steps" or is_next_steps_choice(raw)

    if not is_next:
        return {
            "ok": True,
            "mode": "authorize",
            "value": {
                **raw,
                "kind": kind or "confirm",
            },
        }

    errors: list[str] = []
    opts_raw = raw.get("options")
    if not isinstance(opts_raw, list):
        return {"ok": False, "errors": ["next_steps requires options array"]}
    if len(opts_raw) < NEXT_STEPS_MIN or len(opts_raw) > NEXT_STEPS_MAX:
        errors.append(
            f"next_steps options must be {NEXT_STEPS_MIN}–{NEXT_STEPS_MAX} "
            f"(got {len(opts_raw)})"
        )

    ids: set[str] = set()
    options: list[dict[str, Any]] = []
    for i, row in enumerate(opts_raw):
        if not isinstance(row, dict):
            errors.append(f"options[{i}] must be an object")
            continue
        oid = _s(row.get("id"))
        title = _s(row.get("title"))
        body = _s(row.get("body"))
        if not oid:
            errors.append(f"options[{i}].id required")
        if not title:
            errors.append(f"options[{i}].title required")
        if not body:
            errors.append(f"options[{i}].body required")
        if oid:
            if oid in ids:
                errors.append(f"duplicate option id: {oid}")
            ids.add(oid)
        workset_ids = []
        raw_ws = row.get("workset_item_ids")
        if isinstance(raw_ws, list):
            workset_ids = [_s(x) for x in raw_ws if _s(x)]
        opt: dict[str, Any] = {"id": oid, "title": title, "body": body}
        if workset_ids:
            opt["workset_item_ids"] = workset_ids
        if _s(row.get("kind")):
            opt["kind"] = _s(row.get("kind"))
        options.append(opt)

    if errors:
        return {"ok": False, "errors": errors}

    # Spec #313 L8: next_steps product default is single-select (multi only when agent sets it).
    selection = raw.get("selection")
    if selection not in ("single", "multi"):
        selection = "single"

    value = {**raw, "kind": "next_steps", "selection": selection, "options": options}
    return {"ok": True, "mode": "next_steps", "value": value}


def parse_choice_options(card: dict | None) -> list[dict[str, Any]]:
    result = validate_choice_card_payload(card or {})
    if not result.get("ok") or result.get("mode") != "next_steps":
        return []
    value = result.get("value") or {}
    opts = value.get("options") if isinstance(value, dict) else None
    return list(opts) if isinstance(opts, list) else []


def expand_selected_options(
    card: dict | None,
    selected_option_ids: list | None,
) -> dict[str, Any]:
    """S2 — selected_option_ids + card → workset_item_ids + summary_titles + selected options."""
    options = parse_choice_options(card)
    want = {_s(x) for x in (selected_option_ids or []) if _s(x)}
    workset_item_ids: list[str] = []
    seen: set[str] = set()
    summary_titles: list[str] = []
    selected_options: list[dict[str, Any]] = []
    for opt in options:
        if not isinstance(opt, dict):
            continue
        oid = _s(opt.get("id"))
        if oid not in want:
            continue
        summary_titles.append(_s(opt.get("title")) or oid)
        selected_options.append(opt)
        for wid in opt.get("workset_item_ids") or []:
            w = _s(wid)
            if not w or w in seen:
                continue
            seen.add(w)
            workset_item_ids.append(w)
    return {
        "workset_item_ids": workset_item_ids,
        "summary_titles": summary_titles,
        "selected_options": selected_options,
    }


def format_selected_summary(summary_titles: list[str] | None) -> str:
    titles = [_s(t) for t in (summary_titles or []) if _s(t)]
    if not titles:
        return "已选择"
    return "已选择：" + "、".join(titles)


def build_confirm_options_text(
    card: dict | None,
    selected_option_ids: list | None,
    *,
    supplement: str | None = None,
) -> str:
    """Spec #313 S3 — full confirm text: option title/body + optional supplement.

    Used as Session demand text (same class as user messages). Prefer this over
    title-only summary when feeding continue / queue.
    """
    expanded = expand_selected_options(card, selected_option_ids)
    selected = expanded.get("selected_options") or []
    parts: list[str] = []
    if selected:
        lines: list[str] = ["已选择："]
        for opt in selected:
            if not isinstance(opt, dict):
                continue
            title = _s(opt.get("title")) or _s(opt.get("id"))
            body = _s(opt.get("body"))
            if body:
                lines.append(f"- {title}：{body}")
            else:
                lines.append(f"- {title}")
        parts.append("\n".join(lines))
    else:
        titles = expanded.get("summary_titles") or []
        parts.append(format_selected_summary(titles if isinstance(titles, list) else []))
    sup = _s(supplement)
    if sup:
        parts.append(f"补充：{sup}")
    return "\n".join(parts).strip()


def should_soft_gate_next_steps(
    *,
    boundary: str | None = None,
    open_workset_count: int = 0,
    open_priors: bool = False,
    has_legal_choice_card: bool = False,
    turn_had_tools: bool = False,
) -> bool:
    """S3 — Pure soft-gate predicate (one retry cap is caller's job)."""
    b = _s(boundary).lower()
    stoppable = b in {
        "stoppable",
        "continue_empty",
        "settle",
        "case_assign",
    }
    if not stoppable:
        return False
    if has_legal_choice_card:
        return False
    if turn_had_tools:
        return False
    if int(open_workset_count or 0) <= 0 and not open_priors:
        return False
    return True


def messages_have_legal_next_steps_choice(
    messages: list[dict] | None,
    *,
    answered_request_ids: set[str] | None = None,
) -> bool:
    """True if transcript has a valid unanswered (or any) next_steps card.

    Soft gate treats any legal next_steps card in recent messages as present
    so we do not re-inject after the agent already offered choices.
    """
    answered = answered_request_ids or set()
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        msg_type = _s(m.get("msg_type") or m.get("type")).lower()
        content = m.get("content") if isinstance(m.get("content"), dict) else m
        if msg_type not in {"confirm_card", "choice_card", "request_decision"}:
            # content may still carry kind when flattened
            if not is_next_steps_choice(content if isinstance(content, dict) else None):
                continue
        if not isinstance(content, dict):
            continue
        if not is_next_steps_choice(content):
            continue
        rid = _s(content.get("request_id"))
        if rid and rid in answered:
            continue
        v = validate_choice_card_payload(content)
        if v.get("ok") and v.get("mode") == "next_steps":
            return True
    return False


def resolve_confirm_options_delivery(
    *,
    had_live_pending: bool,
    conversation_status: str | None = None,
    working: bool | None = None,
    worker_count: int = 0,
    force_interrupt: bool = False,
) -> str:
    """Spec #313 S1 — how to deliver a next_steps confirm demand.

    Returns one of:
      - ``forward_live``: live approval wait still owns the Session
      - ``enqueue``: Session in-flight without live wait → FIFO demand queue (same class as user text)
      - ``continue_dispatch``: idle/settled/dead wait / force_interrupt → same Session continue turn
    """
    st = _s(conversation_status).lower()
    settled = st in {
        "failed",
        "incomplete",
        "paused",
        "canceled",
        "cancelled",
        "created",
        "completed",
        "done",
    }
    workers = int(worker_count or 0)
    # Match WS continue-check: idle when settled, working=False, or no tracked workers.
    session_idle = settled or working is False or workers == 0

    if force_interrupt:
        # Spec #313 L9/L11: force-send interrupts then applies (not silent steer).
        return "continue_dispatch"
    if had_live_pending and not session_idle:
        return "forward_live"
    if not session_idle:
        # Busy Session, no live wait (or wait already dead): FIFO enqueue (not mid-flight steer).
        return "enqueue"
    return "continue_dispatch"


def build_confirm_continue_message(
    *,
    text: str | None,
    selected_option_ids: list | None = None,
    workset_item_ids: list | None = None,
    task_context: dict | None = None,
    expert_id: str | None = None,
    expert_name: str | None = None,
    engagement: str | None = None,
) -> dict[str, Any]:
    """Spec #313 S1 pure — confirm → user_message-shaped demand with sticky target/scope.

    When prior engagement had a target, always rehydrate it (forbid empty-target chat-only).
    """
    summary = _s(text)
    if not summary:
        ids = [_s(x) for x in (selected_option_ids or []) if _s(x)]
        summary = (
            f"已选择 next_steps: {', '.join(ids)}" if ids else "User confirmed next_steps packages."
        )
    out: dict[str, Any] = {
        "type": "user_message",
        "text": summary,
        "display_text": summary,
    }
    ids_ws = [_s(x) for x in (workset_item_ids or []) if _s(x)]
    if ids_ws:
        out["workset_item_id"] = ids_ws[0]
        out["workset_item_ids"] = ids_ws
    if selected_option_ids:
        out["selected_option_ids"] = [
            _s(x) for x in selected_option_ids if _s(x)
        ]
    tc = task_context if isinstance(task_context, dict) else {}
    target = tc.get("target")
    scope = tc.get("scope")
    has_target = False
    if isinstance(target, dict) and _s(target.get("value")):
        out["target"] = target
        has_target = True
    elif isinstance(target, str) and _s(target):
        out["target"] = {"type": "host", "value": _s(target)}
        has_target = True
    if isinstance(scope, dict) and scope:
        out["scope"] = scope
    elif has_target and isinstance(out.get("target"), dict):
        val = _s(out["target"].get("value"))
        if val:
            out["scope"] = {"allow": [val], "deny": []}
    # Sticky persona
    if _s(expert_id):
        out["expert_id"] = _s(expert_id)
    if _s(expert_name):
        out["expert_name"] = _s(expert_name)
    if _s(engagement):
        out["engagement"] = _s(engagement)
        out["role"] = _s(engagement)
    # Preserve prior goal seed when present
    prior_goal = _s(tc.get("goal_objective"))
    if prior_goal:
        out["goal_objective"] = prior_goal
        out["goal_mode"] = True
    return out


def apply_soft_gate_note(
    case_context: dict[str, Any],
    *,
    boundary: str = "case_assign",
    already_injected: bool = False,
    open_priors: bool = False,
    has_legal_choice_card: bool | None = None,
    turn_had_tools: bool = False,
) -> tuple[dict[str, Any], bool]:
    """Optionally append soft-gate note once. Returns (ctx, injected_now)."""
    if already_injected:
        return case_context, False
    ctx = dict(case_context or {})
    next_work = ctx.get("next_work") if isinstance(ctx.get("next_work"), dict) else {}
    open_count = int(next_work.get("workset_open_count") or 0)
    if has_legal_choice_card is None:
        # Prefer explicit flag on brief if present
        has_legal_choice_card = bool(next_work.get("has_legal_choice_card"))
    if not should_soft_gate_next_steps(
        boundary=boundary,
        open_workset_count=open_count,
        open_priors=open_priors,
        has_legal_choice_card=bool(has_legal_choice_card),
        turn_had_tools=turn_had_tools,
    ):
        return ctx, False
    note = _s(ctx.get("note"))
    if SOFT_GATE_NOTE in note:
        return ctx, False
    ctx["note"] = (note + "\n\n" + SOFT_GATE_NOTE).strip() if note else SOFT_GATE_NOTE
    return ctx, True
