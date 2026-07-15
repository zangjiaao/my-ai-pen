"""Case (v1: 1 conversation = 1 case) engagement template + RoE helpers.

Structured fields only — no free-text NLP inventing engagement.
"""
from __future__ import annotations

from typing import Any

# Product templates (map to pentest pack via catalog aliases; RoE differs).
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


def normalize_engagement_template(value: object) -> str | None:
    key = str(value or "").strip().lower()
    if not key:
        return None
    return _TEMPLATE_ALIASES.get(key) or (key if key in (TEMPLATE_APP, TEMPLATE_DEEP) else None)


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

    tmpl = normalize_engagement_template(engagement_template)
    if tmpl:
        case["engagement_template"] = tmpl
        task["engagement_template"] = tmpl
        # Keep pack sticky as pentest for assessment templates (aliases resolve on node).
        if tmpl in (TEMPLATE_APP, TEMPLATE_DEEP):
            task["engagement"] = tmpl  # alias → pentest on normalize_pack_id
            task["role"] = "pentest"

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
