"""Spec #312 — Unified Choice Card pure contracts (S1–S3).

Agent-authored options; platform validates / expands / soft-gates only.
Does not invent engagement or option bodies from Workset titles.
"""
from __future__ import annotations

from typing import Any

NEXT_STEPS_MIN = 2
NEXT_STEPS_MAX = 5

SOFT_GATE_NOTE = (
    "Soft gate (Spec #312): stoppable/continue boundary with open Case Workset "
    "(or open priors) but no legal next_steps choice card was offered. "
    "Emit one request_user_decision(kind=next_steps) with 2–5 curated options "
    "(title + body; optional workset_item_ids binds). Do not only say 等待指示 "
    "or prose A/B/C/D menus. Do not invent inventory chips as the product path."
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

    # V1 FE is multi-select only (Spec #312 L4). Wire may send "single" for forward-compat;
    # product default remains multi until single UX exists.
    selection = raw.get("selection")
    if selection not in ("single", "multi"):
        selection = "multi"

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
    """S2 — selected_option_ids + card → workset_item_ids + summary_titles."""
    options = parse_choice_options(card)
    want = {_s(x) for x in (selected_option_ids or []) if _s(x)}
    workset_item_ids: list[str] = []
    seen: set[str] = set()
    summary_titles: list[str] = []
    for opt in options:
        if not isinstance(opt, dict):
            continue
        oid = _s(opt.get("id"))
        if oid not in want:
            continue
        summary_titles.append(_s(opt.get("title")) or oid)
        for wid in opt.get("workset_item_ids") or []:
            w = _s(wid)
            if not w or w in seen:
                continue
            seen.add(w)
            workset_item_ids.append(w)
    return {
        "workset_item_ids": workset_item_ids,
        "summary_titles": summary_titles,
    }


def format_selected_summary(summary_titles: list[str] | None) -> str:
    titles = [_s(t) for t in (summary_titles or []) if _s(t)]
    if not titles:
        return "已选择"
    return "已选择：" + "、".join(titles)


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
