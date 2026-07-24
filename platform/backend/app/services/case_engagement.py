"""Case (v1: 1 conversation = 1 case) engagement template + RoE helpers.

Structured fields only — no free-text NLP inventing engagement.
"""
from __future__ import annotations

from typing import Any

# Product templates (map to pentest pack via catalog aliases; RoE differs).
# Soft scenario mode retired (#76). Phase 2 (#78): product Graphs = app_assessment + redteam_deep.
TEMPLATE_APP = "app_assessment"
TEMPLATE_DEEP = "redteam_deep"

_TEMPLATE_ALIASES: dict[str, str] = {
    "app_assessment": TEMPLATE_APP,
    "assessment": TEMPLATE_APP,
    "assess": TEMPLATE_APP,
    "pre-prod": TEMPLATE_APP,
    "preprod": TEMPLATE_APP,
    "redteam_deep": TEMPLATE_DEEP,
    "redteam": TEMPLATE_DEEP,
    "red-team": TEMPLATE_DEEP,
    "deep": TEMPLATE_DEEP,
}

# Product-selectable Expert Graph templates (UI / new Case writes). No free chip here.
PRODUCT_GRAPH_TEMPLATES: frozenset[str] = frozenset({TEMPLATE_APP, TEMPLATE_DEEP})


def normalize_engagement_template(value: object) -> str | None:
    key = str(value or "").strip().lower()
    if not key:
        return None
    return _TEMPLATE_ALIASES.get(key) or (key if key in (TEMPLATE_APP, TEMPLATE_DEEP) else None)


def is_product_graph_template(value: object) -> bool:
    """True when template is a currently product-offered Expert Graph id."""
    tmpl = normalize_engagement_template(value)
    return tmpl in PRODUCT_GRAPH_TEMPLATES


def normalize_product_engagement_template(value: object) -> str | None:
    """Template for new product Graph selection.

    free/none → None (Default free seat — not an Expert Graph template).
    Product Expert Graph ids: app_assessment, redteam_deep (#78 S2).
    """
    key = str(value or "").strip().lower()
    if not key or key in {"free", "none", "off", "false", "null"}:
        return None
    tmpl = normalize_engagement_template(value)
    if tmpl and is_product_graph_template(tmpl):
        return tmpl
    return None


def resolve_allow_postex(
    *,
    engagement_template: object = None,
    engagement: object = None,
    allow_postex: object = None,
) -> bool:
    """Derive allow_postex from structured fields. Default False (conservative)."""
    if isinstance(allow_postex, bool):
        return allow_postex
    if isinstance(allow_postex, str):
        low = allow_postex.strip().lower()
        if low in {"true", "1", "yes"}:
            return True
        if low in {"false", "0", "no"}:
            return False
    tmpl = normalize_engagement_template(engagement_template) or normalize_engagement_template(
        engagement
    )
    return tmpl == TEMPLATE_DEEP


def case_fields_from_context(context: object) -> dict[str, Any]:
    """Read Case-shaped fields from conversation.context."""
    ctx = context if isinstance(context, dict) else {}
    task = ctx.get("task") if isinstance(ctx.get("task"), dict) else {}
    case = ctx.get("case") if isinstance(ctx.get("case"), dict) else {}
    template = (
        case.get("engagement_template")
        or task.get("engagement_template")
        or task.get("engagement")
        or task.get("role")
    )
    allow = case.get("allow_postex")
    if allow is None:
        allow = task.get("allow_postex")
    return {
        "engagement_template": normalize_engagement_template(template)
        or (str(template).strip() if template else None),
        "allow_postex": resolve_allow_postex(
            engagement_template=template,
            engagement=task.get("engagement"),
            allow_postex=allow,
        ),
        "stations": case.get("stations") if isinstance(case.get("stations"), list) else [],
        "handoff": case.get("handoff") if isinstance(case.get("handoff"), dict) else None,
        "accounts": case.get("accounts") if case.get("accounts") is not None else task.get("accounts"),
        "engagement": task.get("engagement") or task.get("role"),
        "target": task.get("target"),
        "scope": task.get("scope"),
    }


def _clear_product_graph_sticky(case: dict, task: dict) -> None:
    """Clear product Graph sticky fields so free/none cannot resurrect a Graph template.

    Mutates case/task in place. Clears engagement_template and product-shaped
    task.engagement; also drops pack role=pentest so case_fields_from_context
    cannot surface it as a template fallback.
    """
    case.pop("engagement_template", None)
    task.pop("engagement_template", None)
    sticky_eng = str(task.get("engagement") or "").strip()
    if sticky_eng and (
        is_product_graph_template(sticky_eng)
        or normalize_engagement_template(sticky_eng) is not None
    ):
        task.pop("engagement", None)
    # role was set to pack "pentest" when selecting a Graph; do not let it
    # surface as engagement_template via case_fields fallback.
    if str(task.get("role") or "").strip().lower() == "pentest":
        task.pop("role", None)


def merge_case_into_context(
    context: dict | None,
    *,
    engagement_template: object = None,
    allow_postex: object = None,
    stations: object = None,
    handoff: object = None,
    accounts: object = None,
) -> dict:
    """Return new context dict with case + task RoE fields updated."""
    ctx = dict(context or {})
    case = dict(ctx.get("case") or {}) if isinstance(ctx.get("case"), dict) else {}
    task = dict(ctx.get("task") or {}) if isinstance(ctx.get("task"), dict) else {}

    # Product writes: free/none clear template; product Graphs (app_assessment, redteam_deep).
    tmpl = normalize_product_engagement_template(engagement_template)
    if engagement_template is not None and str(engagement_template).strip() != "":
        if tmpl:
            case["engagement_template"] = tmpl
            task["engagement_template"] = tmpl
            task["engagement"] = tmpl  # alias → pentest pack on Node
            task["role"] = "pentest"
        else:
            # free / none / unknown non-product — clear sticky Graph fields.
            _clear_product_graph_sticky(case, task)

    # allow_postex: explicit arg wins; if only template changes, re-derive from the
    # *new* template — do not treat a stale case.allow_postex as a user override.
    if allow_postex is not None:
        resolved = resolve_allow_postex(
            engagement_template=case.get("engagement_template") or tmpl,
            engagement=task.get("engagement"),
            allow_postex=allow_postex,
        )
        case["allow_postex"] = resolved
        task["allow_postex"] = resolved
    elif tmpl:
        resolved = resolve_allow_postex(
            engagement_template=tmpl,
            engagement=task.get("engagement"),
            allow_postex=None,
        )
        case["allow_postex"] = resolved
        task["allow_postex"] = resolved
    elif engagement_template is not None and str(engagement_template).strip() != "" and not tmpl:
        # free/none or non-product cleared → conservative post-ex off
        case["allow_postex"] = False
        task["allow_postex"] = False

    if isinstance(stations, list):
        case["stations"] = stations
    if isinstance(handoff, dict):
        case["handoff"] = handoff
    if accounts is not None:
        case["accounts"] = accounts
        task["accounts"] = accounts

    ctx["case"] = case
    ctx["task"] = task
    return ctx


def roe_payload_for_task_assign(context: object) -> dict[str, Any]:
    """Fields to attach on task_assign from conversation case/task."""
    fields = case_fields_from_context(context)
    out: dict[str, Any] = {}
    if fields.get("engagement_template"):
        out["engagement_template"] = fields["engagement_template"]
    out["allow_postex"] = bool(fields.get("allow_postex"))
    if fields.get("accounts") is not None:
        out["accounts"] = fields["accounts"]
    return out


def resolve_graph_execution(
    *,
    engagement_template: object = None,
    conversation_status: object = None,
    explicit_execution: object = None,
) -> str | None:
    """Resolve structured graph_execution for task_assign (C1).

    Returns "full" | "continue" | None (omit — Node first-run full when hard resolves).
    Structured only — never NLP on free-text instruction.
    Retest / full re-run is explicit graph_execution=full (map #81 later).
    """
    raw = str(explicit_execution or "").strip().lower()
    if raw in {"full", "run", "restart"}:
        return "full"
    if raw in {"continue", "continue_chat", "envelope"}:
        return "continue"

    if not is_product_graph_template(engagement_template):
        return None

    status = str(conversation_status or "").strip().lower()
    if status in {"completed", "complete", "done"}:
        return "continue"
    return None


def focus_fields_from_message(msg: dict | None) -> dict[str, Any]:
    """
    Extract optional dig-deeper / focused re-verify fields for task_assign (map #81).

    Accepts snake_case or camelCase. Never invents values from free-text NLP.
    Returns only keys present:
      - focus_finding_ids (list[str])
      - focus_note (str)

    No legacy retest_* wire keys (removed after short deprecation; use focus_* only).
    """
    if not isinstance(msg, dict):
        return {}
    out: dict[str, Any] = {}
    raw_ids = msg.get("focus_finding_ids")
    if raw_ids is None:
        raw_ids = msg.get("focusFindingIds")
    ids: list[str] = []
    if isinstance(raw_ids, (list, tuple)):
        for x in raw_ids:
            s = str(x or "").strip()
            if s:
                ids.append(s)
    elif isinstance(raw_ids, str) and raw_ids.strip():
        for part in raw_ids.split(","):
            s = part.strip()
            if s:
                ids.append(s)
    if ids:
        out["focus_finding_ids"] = ids
    raw_note = msg.get("focus_note")
    if raw_note is None:
        raw_note = msg.get("focusNote")
    if isinstance(raw_note, str) and raw_note.strip():
        out["focus_note"] = raw_note.strip()
    return out
