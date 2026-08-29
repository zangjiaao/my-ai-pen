"""Case Workset («下一步») — durable multi-discovery parking lot (Spec #311).

Host-gated store on conversation.context["workset"]. Agent may propose only;
adopt is user, Goal mechanical valve (in-scope t_surface), or Case asset-intake
policy (user-delegated enroll_group). Never silent Scope/RoE expand.

Families V1:
  t_surface — in-Scope deepen (adopt ≠ expand rights)
  t_host    — new host; human confirm or Case enroll_group policy expands Scope

Statuses: proposed | adopted | done | rejected
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from app.services.asset_ledger import is_valid_ledger_address, split_host_port

WORKSET_KEY = "workset"
FAMILIES = frozenset({"t_surface", "t_host"})
STATUSES = frozenset({"proposed", "adopted", "done", "rejected"})
OPEN_STATUSES = frozenset({"proposed", "adopted"})
# Spec #532 — passive exposure metadata (not a closed source router).
CONFIDENCES = frozenset({"low", "medium", "high"})
SCOPE_DECISIONS = frozenset({"pending", "in_scope", "out_of_scope", "needs_authorization"})
# Goal outer-loop budget (rounds of auto-continue). Separate from stage retries.
DEFAULT_GOAL_OUTER_BUDGET = 8
# Spec #540 — Agent list is an index, not a dump.
AGENT_WORKSET_LIST_CAP = 24
AGENT_WORKSET_LIST_CAP_MAX = 40


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _clip(text: object, limit: int = 240) -> str:
    t = " ".join(str(text or "").split())
    if len(t) <= limit:
        return t
    return t[: max(0, limit - 1)] + "…"


def empty_workset() -> dict[str, Any]:
    return {
        "version": 1,
        "items": [],
        "goal": None,
    }


def get_workset(context: object) -> dict[str, Any]:
    """Read Workset blob from conversation.context (always a copy)."""
    ctx = context if isinstance(context, dict) else {}
    raw = ctx.get(WORKSET_KEY)
    if not isinstance(raw, dict):
        return empty_workset()
    items = raw.get("items")
    if not isinstance(items, list):
        items = []
    cleaned = [dict(i) for i in items if isinstance(i, dict)]
    goal = raw.get("goal") if isinstance(raw.get("goal"), dict) else None
    return {
        "version": int(raw.get("version") or 1),
        "items": cleaned,
        "goal": dict(goal) if goal else None,
    }


def put_workset(context: dict | None, workset: dict[str, Any]) -> dict[str, Any]:
    """Return new context dict with Workset written (does not mutate input)."""
    ctx = dict(context or {}) if isinstance(context, dict) else {}
    items = workset.get("items") if isinstance(workset.get("items"), list) else []
    ctx[WORKSET_KEY] = {
        "version": int(workset.get("version") or 1),
        "items": [dict(i) for i in items if isinstance(i, dict)],
        "goal": dict(workset["goal"]) if isinstance(workset.get("goal"), dict) else None,
    }
    return ctx


INTAKE_KEY = "asset_intake"
INTAKE_MODES = frozenset({"ask", "enroll_group"})
ADOPT_ACTORS = frozenset({"user", "goal_mechanical", "system", "intake_policy"})


def normalize_asset_intake(raw: object) -> dict[str, Any]:
    """Case user policy for discovery → Owner Host.

    Default ``ask``: Workset stays pending until user (or Goal t_surface valve) adopts.
    ``enroll_group``: eligible t_host rows enroll into the named Group and this Case Scope.
    Platform does not infer the mode from free-text; Agent/UI writes this structured field.
    """
    src = raw if isinstance(raw, dict) else {}
    mode = str(src.get("mode") or "ask").strip().lower()
    if mode not in INTAKE_MODES:
        mode = "ask"
    group_id = str(src.get("group_id") or "").strip()
    group_name = str(src.get("group_name") or src.get("group") or "").strip()
    if mode == "enroll_group" and not group_id and not group_name:
        mode = "ask"
    into_scope = src.get("into_scope")
    if into_scope is None:
        into_scope = True
    return {
        "mode": mode,
        "group_id": group_id or None,
        "group_name": group_name or None,
        "into_scope": bool(into_scope),
        "set_by": str(src.get("set_by") or "").strip()[:40] or None,
        "updated_at": str(src.get("updated_at") or "").strip() or None,
    }


def get_asset_intake(context: object) -> dict[str, Any]:
    ctx = context if isinstance(context, dict) else {}
    return normalize_asset_intake(ctx.get(INTAKE_KEY))


def put_asset_intake(context: dict | None, policy: object) -> dict[str, Any]:
    ctx = dict(context or {}) if isinstance(context, dict) else {}
    normalized = normalize_asset_intake(policy)
    if not normalized.get("updated_at"):
        normalized["updated_at"] = _now_iso()
    ctx[INTAKE_KEY] = normalized
    return ctx


def intake_enroll_eligible(item: dict[str, Any], policy: object) -> bool:
    """Eligible t_host for Case enroll_group policy. Exceptions stay proposed."""
    pol = normalize_asset_intake(policy)
    if pol["mode"] != "enroll_group":
        return False
    if not pol.get("group_id") and not pol.get("group_name"):
        return False
    if not isinstance(item, dict):
        return False
    if str(item.get("status") or "proposed") != "proposed":
        return False
    if str(item.get("family") or "") != "t_host":
        return False
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    host = _host_from_payload(payload, "t_host") or str(payload.get("host") or "").strip().lower()
    if not host or not is_valid_ledger_address(host):
        return False
    decision = str(payload.get("scope_decision") or "").strip().lower()
    if decision in {"out_of_scope", "needs_authorization"}:
        return False
    confidence = str(payload.get("confidence") or "").strip().lower()
    if confidence == "low":
        return False
    return True


def apply_intake_enroll_to_context(
    context: dict | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Apply enroll_group policy: adopt eligible t_host and expand this Case Scope.

    Does not write Owner Host rows — persist layer materializes into the Group.
    """
    ctx = dict(context or {}) if isinstance(context, dict) else {}
    policy = get_asset_intake(ctx)
    if policy["mode"] != "enroll_group":
        return ctx, []
    ws = get_workset(ctx)
    task = dict(ctx.get("task") or {}) if isinstance(ctx.get("task"), dict) else {}
    enrolled: list[dict[str, Any]] = []
    for item in list(ws.get("items") or []):
        if not isinstance(item, dict):
            continue
        if not intake_enroll_eligible(item, policy):
            continue
        expand_fields = host_expand_fields_from_item(item)
        if policy.get("into_scope") is not False and expand_fields:
            expanded, expand_err = expand_task_scope_for_host(
                task,
                host=expand_fields["host"],
                port=expand_fields.get("port"),
                urls=expand_fields.get("urls"),
            )
            if expand_err:
                continue
            task = expanded
        ws2, found, err = adopt_item(ws, str(item.get("id")), actor="intake_policy")
        if err or not found:
            continue
        ws = ws2
        enrolled.append(dict(found))
    if enrolled:
        ctx["task"] = task
        ctx = put_workset(ctx, ws)
    return ctx, enrolled


def scope_hosts_from_task(task: object) -> set[str]:
    """Host keys currently authorized on the Case task Scope."""
    out: set[str] = set()
    t = task if isinstance(task, dict) else {}
    target = t.get("target") if isinstance(t.get("target"), dict) else {}
    for key in ("value", "url", "host", "address"):
        host, _ = split_host_port(target.get(key) or "")
        if host:
            out.add(host.lower())
    scope = t.get("scope") if isinstance(t.get("scope"), dict) else {}
    allow = scope.get("allow")
    if isinstance(allow, list):
        for item in allow:
            host, _ = split_host_port(item)
            if host:
                out.add(host.lower())
    return out


def _host_from_payload(payload: dict[str, Any], family: str) -> str:
    for key in ("host", "address", "url", "location", "path"):
        raw = payload.get(key)
        if not raw:
            continue
        host, _ = split_host_port(raw)
        if host:
            return host.lower()
        if family == "t_surface" and isinstance(raw, str) and raw.strip().startswith("/"):
            return ""
    urls = payload.get("urls")
    if isinstance(urls, list):
        for u in urls:
            host, _ = split_host_port(u)
            if host:
                return host.lower()
    return ""


def _surface_key(payload: dict[str, Any]) -> str:
    loc = str(
        payload.get("location")
        or payload.get("path")
        or payload.get("url")
        or payload.get("path_key")
        or ""
    ).strip()
    if loc:
        return loc.lower()[:300]
    host = str(payload.get("host") or "").strip().lower()
    port = str(payload.get("port") or "").strip()
    return f"{host}|{port}" if host else ""


def _item_dedupe_key(item: dict[str, Any]) -> str:
    family = str(item.get("family") or "")
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    if family == "t_host":
        host = _host_from_payload(payload, family) or str(payload.get("host") or "").lower()
        port = str(payload.get("port") or "").strip()
        return f"t_host:{host}|{port}"
    return f"t_surface:{_surface_key(payload)}"


def mechanical_gate(
    item: dict[str, Any],
    *,
    scope_hosts: set[str] | None = None,
    for_auto_adopt: bool = False,
) -> dict[str, Any]:
    """Validate a Workset item. Returns {ok, reasons, auto_eligible}.

    for_auto_adopt=True applies Goal valve rules:
      - only t_surface
      - host must be in Scope
      - never t_host (silent RoE expand ban)
    """
    reasons: list[str] = []
    family = str(item.get("family") or "").strip()
    if family not in FAMILIES:
        reasons.append("invalid_family")
    status = str(item.get("status") or "proposed").strip()
    if status not in STATUSES:
        reasons.append("invalid_status")
    title = str(item.get("title") or item.get("summary") or "").strip()
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    if not payload and not title:
        reasons.append("empty_item")

    host = _host_from_payload(payload, family)
    scope = scope_hosts if scope_hosts is not None else set()

    if family == "t_host":
        if not host:
            reasons.append("missing_host")
        elif not is_valid_ledger_address(host):
            reasons.append("invalid_host")
        if for_auto_adopt:
            reasons.append("silent_roe_expand_forbidden")
    elif family == "t_surface":
        loc = str(
            payload.get("location")
            or payload.get("path")
            or payload.get("url")
            or payload.get("path_key")
            or ""
        ).strip()
        if not loc and not host:
            reasons.append("empty_surface")
        if loc and len(loc) < 2:
            reasons.append("non_executable")
        if for_auto_adopt:
            if host and scope and host not in scope:
                reasons.append("non_in_scope_surface")
            elif host and not scope:
                reasons.append("scope_unknown")
            if payload.get("in_scope") is False:
                reasons.append("non_in_scope_surface")

    ok = len(reasons) == 0
    return {
        "ok": ok,
        "reasons": reasons,
        "auto_eligible": auto_check_safe(item, scope),
    }


def is_passive_exposure_item(item: dict[str, Any]) -> bool:
    """Spec #532: CT/DNS/Shodan-class candidates stay proposed until the user adopts."""
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    if payload.get("passive") is True:
        return True
    decision = str(payload.get("scope_decision") or "").strip().lower()
    if decision in {"pending", "needs_authorization"}:
        return True
    if str(payload.get("intel_source") or "").strip():
        return True
    src = str(item.get("source") or "").strip().lower()
    return src.startswith("passive") or src.startswith("exposure")


def auto_check_safe(item: dict[str, Any], scope_hosts: set[str]) -> bool:
    """Whether Goal may auto-adopt this item (mechanical only).

    Spec #311: host-checkable in-scope only. Path-only t_surface (no host) is
    not auto-eligible when scope_hosts is non-empty (or empty — not checkable).
    Spec #532: passive exposure never auto-adopts (not Host / active test).
    """
    if is_passive_exposure_item(item):
        return False
    family = str(item.get("family") or "")
    if family != "t_surface":
        return False
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    if payload.get("in_scope") is False:
        return False
    host = _host_from_payload(payload, family)
    if not host:
        # Path-only surfaces are not host-checkable → never Goal auto-adopt.
        return False
    if not scope_hosts or host not in scope_hosts:
        return False
    title = str(item.get("title") or item.get("summary") or "").strip()
    loc = str(
        payload.get("location") or payload.get("path") or payload.get("url") or payload.get("path_key") or ""
    ).strip()
    if not title and not loc:
        return False
    if loc and len(loc) < 2:
        return False
    return True


def normalize_candidate(
    raw: dict[str, Any],
    *,
    source: str,
    scope_hosts: set[str] | None = None,
    default_family: str | None = None,
) -> dict[str, Any] | None:
    """Normalize a settle candidate dict into a Workset proposed item, or None if unusable."""
    if not isinstance(raw, dict):
        return None
    scope = scope_hosts if scope_hosts is not None else set()

    # Explicit family wins; else infer from in_scope / host shape.
    family = str(raw.get("family") or default_family or "").strip()
    host = str(raw.get("host") or raw.get("address") or "").strip().lower()
    if not host:
        for key in ("url", "location", "path"):
            h, _ = split_host_port(raw.get(key) or "")
            if h:
                host = h.lower()
                break
    in_scope_flag = raw.get("in_scope")
    if not family:
        if in_scope_flag is False or (host and scope and host not in scope):
            family = "t_host"
        elif in_scope_flag is True or (host and scope and host in scope) or raw.get("location") or raw.get("path"):
            # Prefer t_surface for in-scope deepen / open ledger paths.
            if host and scope and host not in scope:
                family = "t_host"
            else:
                family = "t_surface" if (raw.get("location") or raw.get("path") or raw.get("path_key") or in_scope_flag is True) else "t_host"
        else:
            family = "t_host" if host else "t_surface"

    if family not in FAMILIES:
        return None

    port = raw.get("port")
    port_s = str(port).strip() if port is not None and str(port).strip() else None
    urls = raw.get("urls") if isinstance(raw.get("urls"), list) else []
    urls_clean = [str(u).strip()[:300] for u in urls if str(u or "").strip()][:12]
    location = str(raw.get("location") or raw.get("path") or raw.get("url") or "").strip()[:500]
    path_key = str(raw.get("path_key") or "").strip()[:300]

    if family == "t_host":
        if not host or not is_valid_ledger_address(host):
            return None
        title = str(raw.get("title") or "").strip() or (f"{host}:{port_s}" if port_s else host)
        summary = str(raw.get("summary") or "").strip() or f"Out-of-scope host {title}"
        payload: dict[str, Any] = {
            "host": host,
            "in_scope": False,
        }
        if port_s:
            payload["port"] = port_s
        if urls_clean:
            payload["urls"] = urls_clean
        if location and "://" in location:
            payload.setdefault("urls", [])
            if location not in payload["urls"]:
                payload["urls"].append(location[:300])
    else:
        if not location and not path_key and not host:
            return None
        title = str(raw.get("title") or "").strip() or (location or path_key or host)[:200]
        summary = str(raw.get("summary") or "").strip() or f"Deepen surface {title}"[:240]
        in_scope = True
        if in_scope_flag is False:
            in_scope = False
        elif host and scope and host not in scope:
            in_scope = False
        payload = {
            "in_scope": in_scope,
        }
        if location:
            payload["location"] = location
        if path_key:
            payload["path_key"] = path_key
        if host:
            payload["host"] = host
        if port_s:
            payload["port"] = port_s
        if urls_clean:
            payload["urls"] = urls_clean
        kind = str(raw.get("kind") or "").strip()
        if kind:
            payload["kind"] = kind[:64]

    intel_source = str(raw.get("intel_source") or payload.get("intel_source") or "").strip()[:64]
    if intel_source:
        payload["intel_source"] = intel_source
    attribution = str(raw.get("attribution") or payload.get("attribution") or "").strip()
    if attribution:
        payload["attribution"] = _clip(attribution, 800)
    confidence = str(raw.get("confidence") or payload.get("confidence") or "").strip().lower()
    if confidence in CONFIDENCES:
        payload["confidence"] = confidence
    scope_decision = str(
        raw.get("scope_decision") or payload.get("scope_decision") or ""
    ).strip().lower()
    if scope_decision in SCOPE_DECISIONS:
        payload["scope_decision"] = scope_decision
    if raw.get("passive") is True or payload.get("passive") is True or intel_source:
        payload["passive"] = True
        if "scope_decision" not in payload:
            payload["scope_decision"] = "pending"

    now = _now_iso()
    item_id = str(raw.get("id") or "").strip() or f"ws_{uuid.uuid4().hex[:16]}"
    suggested = str(raw.get("suggested_expert") or raw.get("suggested_expert_id") or "").strip() or None
    item: dict[str, Any] = {
        "id": item_id,
        "family": family,
        "title": _clip(title, 200),
        "summary": _clip(summary, 400),
        "payload": payload,
        "status": "proposed",
        "source": str(source or "settle")[:80],
        "created_at": now,
        "updated_at": now,
        "sort_order": int(raw.get("sort_order") or 0),
    }
    if suggested:
        item["suggested_expert"] = suggested[:80]

    # Reject hollow proposed via mechanical gate (non-auto path).
    gate = mechanical_gate(item, scope_hosts=scope, for_auto_adopt=False)
    # For proposed emission we only require structural ok (not auto_eligible).
    if family == "t_host" and ("invalid_host" in gate["reasons"] or "missing_host" in gate["reasons"]):
        return None
    if family == "t_surface" and "empty_surface" in gate["reasons"]:
        return None
    if "empty_item" in gate["reasons"]:
        return None
    item["auto_eligible"] = auto_check_safe(item, scope)
    return item


def merge_proposed_items(
    workset: dict[str, Any],
    candidates: list[dict[str, Any]],
    *,
    source: str,
    scope_hosts: set[str] | None = None,
) -> dict[str, Any]:
    """Merge settle candidates as proposed. Open items survive; no wipe.

    Dedupes by family+host/path against open (proposed|adopted) items.
    Terminal (done|rejected) keys may be re-proposed as new ids.
    """
    ws = {
        "version": int(workset.get("version") or 1),
        "items": [dict(i) for i in (workset.get("items") or []) if isinstance(i, dict)],
        "goal": dict(workset["goal"]) if isinstance(workset.get("goal"), dict) else None,
    }
    open_keys: set[str] = set()
    max_order = 0
    for existing in ws["items"]:
        st = str(existing.get("status") or "")
        if st in OPEN_STATUSES:
            open_keys.add(_item_dedupe_key(existing))
        try:
            max_order = max(max_order, int(existing.get("sort_order") or 0))
        except (TypeError, ValueError):
            pass

    scope = scope_hosts if scope_hosts is not None else set()
    for raw in candidates:
        if not isinstance(raw, dict):
            continue
        item = normalize_candidate(raw, source=source, scope_hosts=scope)
        if not item:
            continue
        key = _item_dedupe_key(item)
        if key in open_keys:
            continue
        max_order += 10
        item["sort_order"] = max_order
        ws["items"].append(item)
        open_keys.add(key)
    return ws


def candidates_from_next_scope(
    next_scope: list | None,
    attack_surface: list | None = None,
) -> list[dict[str, Any]]:
    """Migrate free next_scope / attack_surface candidate lists into raw candidate dicts."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for c in list(next_scope or []) + list(attack_surface or []):
        if not isinstance(c, dict):
            continue
        host = str(c.get("host") or "").strip().lower()
        port = str(c.get("port") or "").strip()
        key = f"{host}|{port}|{c.get('location') or c.get('path') or ''}"
        if key in seen:
            continue
        seen.add(key)
        row = dict(c)
        # OOS hosts are t_host; in_scope surfaces with location stay t_surface.
        if c.get("in_scope") is False or (
            host and not c.get("location") and not c.get("path") and c.get("in_scope") is not True
        ):
            row.setdefault("family", "t_host")
            row["in_scope"] = False
        out.append(row)
    return out


def update_item_status(
    workset: dict[str, Any],
    item_id: str,
    *,
    status: str,
    actor: str = "user",
) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
    """Host-gated status transition. Returns (workset, item, error).

    Agent cannot self-approve adopted — actor must be user|goal_mechanical|system|intake_policy.
    """
    if status not in STATUSES:
        return workset, None, "invalid_status"
    if status == "adopted" and actor not in ADOPT_ACTORS:
        return workset, None, "agent_cannot_self_adopt"
    ws = {
        "version": int(workset.get("version") or 1),
        "items": [dict(i) for i in (workset.get("items") or []) if isinstance(i, dict)],
        "goal": dict(workset["goal"]) if isinstance(workset.get("goal"), dict) else None,
    }
    found: dict[str, Any] | None = None
    now = _now_iso()
    for item in ws["items"]:
        if str(item.get("id") or "") != item_id:
            continue
        item["status"] = status
        item["updated_at"] = now
        item["status_actor"] = actor[:40]
        if status != "adopted":
            item.pop("in_progress", None)
        found = item
        break
    if not found:
        return workset, None, "not_found"
    return ws, found, None


def adopt_item(
    workset: dict[str, Any],
    item_id: str,
    *,
    actor: str,
    scope_hosts: set[str] | None = None,
    require_auto_eligible: bool = False,
) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
    """Adopt a proposed item with optional mechanical gate for Goal."""
    if actor not in ADOPT_ACTORS:
        return workset, None, "agent_cannot_self_adopt"
    items = workset.get("items") if isinstance(workset.get("items"), list) else []
    target = next((i for i in items if isinstance(i, dict) and str(i.get("id")) == item_id), None)
    if not target:
        return workset, None, "not_found"
    if str(target.get("status") or "") != "proposed":
        return workset, None, "not_proposed"
    if require_auto_eligible or actor == "goal_mechanical":
        if not auto_check_safe(target, scope_hosts or set()):
            return workset, None, "mechanical_gate_reject"
        if str(target.get("family") or "") != "t_surface":
            return workset, None, "mechanical_gate_reject"
    return update_item_status(workset, item_id, status="adopted", actor=actor)


def goal_auto_adopt(
    workset: dict[str, Any],
    *,
    scope_hosts: set[str],
    goal_on: bool,
) -> tuple[dict[str, Any], list[str]]:
    """Goal on: auto-adopt only gated in-scope t_surface. Goal off: no-op.

    Returns (workset, adopted_ids).
    """
    if not goal_on:
        return workset, []
    ws = {
        "version": int(workset.get("version") or 1),
        "items": [dict(i) for i in (workset.get("items") or []) if isinstance(i, dict)],
        "goal": dict(workset["goal"]) if isinstance(workset.get("goal"), dict) else None,
    }
    adopted: list[str] = []
    for item in list(ws["items"]):
        if str(item.get("status") or "") != "proposed":
            continue
        if str(item.get("family") or "") != "t_surface":
            continue
        if not auto_check_safe(item, scope_hosts):
            continue
        ws2, found, err = adopt_item(
            ws,
            str(item["id"]),
            actor="goal_mechanical",
            scope_hosts=scope_hosts,
            require_auto_eligible=True,
        )
        if err or not found:
            continue
        ws = ws2
        adopted.append(str(item["id"]))
    return ws, adopted


def order_workset_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Default UI order: in-progress → adopted → auto-eligible t_surface proposed → other proposed.

    Within each band, stable by sort_order then created_at discovery order.
    done/rejected omitted from open list (caller may still show residuals separately).
    """
    open_items = [dict(i) for i in items if isinstance(i, dict) and str(i.get("status") or "") in OPEN_STATUSES]

    def band(item: dict[str, Any]) -> int:
        if item.get("in_progress"):
            return 0
        st = str(item.get("status") or "")
        if st == "adopted":
            return 1
        if st == "proposed" and item.get("auto_eligible") and str(item.get("family") or "") == "t_surface":
            return 2
        return 3

    def sort_key(item: dict[str, Any]) -> tuple:
        try:
            order = int(item.get("sort_order") or 0)
        except (TypeError, ValueError):
            order = 0
        return (band(item), order, str(item.get("created_at") or ""), str(item.get("id") or ""))

    return sorted(open_items, key=sort_key)


def reorder_items(
    workset: dict[str, Any],
    ordered_ids: list[str],
) -> tuple[dict[str, Any], str | None]:
    """User reorder among open items. ordered_ids is the new priority sequence."""
    if not isinstance(ordered_ids, list) or not ordered_ids:
        return workset, "empty_order"
    ws = {
        "version": int(workset.get("version") or 1),
        "items": [dict(i) for i in (workset.get("items") or []) if isinstance(i, dict)],
        "goal": dict(workset["goal"]) if isinstance(workset.get("goal"), dict) else None,
    }
    by_id = {str(i.get("id")): i for i in ws["items"]}
    now = _now_iso()
    order = 10
    seen: set[str] = set()
    for iid in ordered_ids:
        item = by_id.get(str(iid))
        if not item or str(item.get("status") or "") not in OPEN_STATUSES:
            continue
        if str(iid) in seen:
            continue
        item["sort_order"] = order
        item["updated_at"] = now
        order += 10
        seen.add(str(iid))
    return ws, None


def set_in_progress(
    workset: dict[str, Any],
    item_id: str | None,
    *,
    expert_id: str | None = None,
    expert_name: str | None = None,
    graph_id: str | None = None,
    work_mode: str | None = None,
) -> dict[str, Any]:
    """At most one in-progress Next (V1). Clear others."""
    ws = {
        "version": int(workset.get("version") or 1),
        "items": [dict(i) for i in (workset.get("items") or []) if isinstance(i, dict)],
        "goal": dict(workset["goal"]) if isinstance(workset.get("goal"), dict) else None,
    }
    now = _now_iso()
    mode = str(work_mode or "").strip().lower() if work_mode is not None else None
    for item in ws["items"]:
        if item_id and str(item.get("id")) == item_id:
            item["in_progress"] = True
            item["updated_at"] = now
            if expert_id:
                item["expert_id"] = str(expert_id)[:80]
            if expert_name:
                item["expert_name"] = str(expert_name)[:80]
            if mode:
                item["work_mode"] = mode[:40]
            # Free: expert-only annotation (US3). Graph: expert · graph_id.
            if mode == "free":
                item.pop("graph_id", None)
            elif graph_id:
                item["graph_id"] = str(graph_id)[:80]
        else:
            if item.get("in_progress"):
                item["in_progress"] = False
                item["updated_at"] = now
    return ws


def clear_in_progress(workset: dict[str, Any]) -> dict[str, Any]:
    return set_in_progress(workset, None)


def annotation_fields_from_context(context: object) -> dict[str, str | None]:
    """Expert + Session work mode/graph for in-progress 下一步 annotation (US3).

    Reads sticky Case task expert and Participant Session private mode — Host-only
    writer path; no Tasks dual-write.
    """
    ctx = context if isinstance(context, dict) else {}
    task = ctx.get("task") if isinstance(ctx.get("task"), dict) else {}
    expert_id = str(task.get("expert_id") or "").strip() or None
    expert_name = str(task.get("expert_name") or "").strip() or None
    work_mode: str | None = None
    graph_id: str | None = None
    try:
        from app.services.participant_session import session_record_from_context

        sess = session_record_from_context(ctx, expert_id)
        mode = str(sess.get("work_mode") or "").strip().lower()
        if mode in {"free", "graph"}:
            work_mode = mode
        if mode == "graph":
            graph_id = (
                str(sess.get("graph_id") or task.get("engagement_template") or "").strip() or None
            )
    except Exception:
        pass
    if work_mode is None and (expert_id or expert_name):
        # Adopt before any Session row: default Free so UI shows expert-only annotation.
        work_mode = "free"
    return {
        "expert_id": expert_id,
        "expert_name": expert_name,
        "graph_id": graph_id,
        "work_mode": work_mode,
    }


def take_in_progress_baton(
    workset: dict[str, Any],
    item_id: str,
    *,
    expert_id: str | None = None,
    expert_name: str | None = None,
    graph_id: str | None = None,
    work_mode: str | None = None,
    force: bool = False,
) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
    """Mark an open Workset item as the single in-progress baton.

    If the item already holds in_progress and force is False, still refreshes
    annotation fields when provided. Clears any other in_progress item.
    Returns (workset, item, error).
    """
    iid = str(item_id or "").strip()
    if not iid:
        return workset, None, "not_found"
    items = workset.get("items") if isinstance(workset.get("items"), list) else []
    target = next((i for i in items if isinstance(i, dict) and str(i.get("id")) == iid), None)
    if not target:
        return workset, None, "not_found"
    st = str(target.get("status") or "")
    if st not in OPEN_STATUSES:
        return workset, None, "not_open"
    # Prefer adopted; proposed may take baton only after host adopt (caller).
    if st == "proposed":
        return workset, None, "not_adopted"
    already = bool(target.get("in_progress"))
    if already and not force and not any((expert_id, expert_name, graph_id, work_mode)):
        return workset, dict(target), None
    ws = set_in_progress(
        workset,
        iid,
        expert_id=expert_id,
        expert_name=expert_name,
        graph_id=graph_id,
        work_mode=work_mode,
    )
    item = next((i for i in ws["items"] if str(i.get("id")) == iid), None)
    return ws, item, None


def detect_goal_mode_on(
    *,
    msg: dict | None = None,
    task: dict | None = None,
) -> bool:
    """Explicit goal_mode only for Case Workset Goal valve (Spec #311).

    Bare goal_objective string is not treated as Goal-on — product must set
    goal_mode (UI / task_assign / Node goals.isActive settle field).
    """
    for src in (msg, task):
        if not isinstance(src, dict):
            continue
        if src.get("goal_mode") in (True, "true", "1", 1, "yes"):
            return True
    return False


def detect_goal_mode_explicit_off(msg: dict | None = None) -> bool:
    """True when the wire explicitly sets goal_mode=false (not merely missing).

    Used to stop Case Goal outer when the user turns Goal off in the UI and
    the next user_message/task_complete carries goal_mode: false.
    """
    if not isinstance(msg, dict):
        return False
    return msg.get("goal_mode") in (False, "false", "0", 0, "no")


def detect_user_stopped_settle(msg: dict | None) -> bool:
    """True only when the user stops **Goal itself** — not turn cancel.

    Grok-aligned: Esc / abort cancels the in-flight turn only; long Goal stays open
    unless the user explicitly stops Goal (`user_stopped` or goal-clear tokens).
    Harness `status=incomplete` is never user-stop.
    """
    if not isinstance(msg, dict):
        return False
    if msg.get("user_stopped") in (True, "true", "1", 1, "yes"):
        return True
    stop_reason = str(msg.get("stop_reason") or msg.get("stopReason") or "").lower()
    if not stop_reason:
        return False
    # Explicit Goal-off tokens only — not abort / interrupt / cancel (those are turn cancel).
    goal_stop_tokens = (
        "user_stop",
        "user_stopped",
        "goal_stop",
        "goal_stopped",
        "goal_clear",
        "stop_goal",
        "clear_goal",
    )
    return any(t in stop_reason for t in goal_stop_tokens)


def detect_turn_cancelled_settle(msg: dict | None) -> bool:
    """True when this settle ends because the in-flight turn was cancelled.

    Grok: Esc / send-now / abort cancel the turn; Goal outer must stay running
    (not goal_stopped, not premature goal_complete on empty workset).
    """
    if not isinstance(msg, dict):
        return False
    if detect_user_stopped_settle(msg):
        return False
    stop_reason = str(msg.get("stop_reason") or msg.get("stopReason") or "").lower()
    if not stop_reason:
        return False
    tokens = ("abort", "interrupt", "cancel", "cancelled", "canceled")
    return any(t in stop_reason for t in tokens)


def goal_wants_session_free(goal_outer: dict | None) -> bool:
    """Whether Goal outer loop asks Session to land Free (no Graph chain)."""
    if not isinstance(goal_outer, dict):
        return False
    return str(goal_outer.get("return_to") or "").strip().lower() == "free"


def expand_task_scope_for_host(
    task: dict | None,
    *,
    host: str,
    port: str | None = None,
    urls: list | None = None,
) -> tuple[dict[str, Any], str | None]:
    """Extend task Scope.allow with a confirmed host (t_host adopt / next-scope spirit).

    Does not wipe prior allow entries. Returns (task, error).
    """
    h = str(host or "").strip().lower()
    if not h or not is_valid_ledger_address(h):
        return dict(task or {}) if isinstance(task, dict) else {}, "invalid_host"
    out = dict(task) if isinstance(task, dict) else {}
    scope = dict(out.get("scope") or {}) if isinstance(out.get("scope"), dict) else {}
    allow = list(scope.get("allow") or []) if isinstance(scope.get("allow"), list) else []
    port_s = str(port).strip() if port is not None and str(port).strip() else None
    url_entries: list[str] = []
    if isinstance(urls, list):
        for u in urls:
            s = str(u or "").strip()
            if s and "://" in s:
                url_entries.append(s[:500])
    candidates: list[str] = []
    candidates.extend(url_entries)
    if port_s:
        candidates.append(f"{h}:{port_s}")
    candidates.append(h)
    for entry in candidates:
        if entry and entry not in allow:
            allow.append(entry)
    scope["allow"] = allow
    if "deny" not in scope:
        scope["deny"] = list(scope.get("deny") or []) if isinstance(scope.get("deny"), list) else []
    out["scope"] = scope
    return out, None


def host_expand_fields_from_item(item: dict[str, Any]) -> dict[str, Any] | None:
    """Extract host/port/urls from a t_host Workset item for Scope expand. None if not t_host."""
    if not isinstance(item, dict):
        return None
    if str(item.get("family") or "") != "t_host":
        return None
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    host = _host_from_payload(payload, "t_host") or str(payload.get("host") or "").strip().lower()
    if not host:
        return None
    port = payload.get("port")
    port_s = str(port).strip() if port is not None and str(port).strip() else None
    urls = payload.get("urls") if isinstance(payload.get("urls"), list) else []
    return {"host": host, "port": port_s, "urls": [str(u) for u in urls if str(u or "").strip()]}


# --- Goal outer loop ---

GOAL_TERMINALS = frozenset({
    "goal_complete",
    "goal_blocked",
    "goal_budget_exhausted",
    "goal_stopped",
    "running",
})


def default_goal_outer_budget() -> int:
    import os

    raw = os.environ.get("PLATFORM_GOAL_OUTER_BUDGET") or os.environ.get("NODE4_GOAL_OUTER_BUDGET")
    if raw is None or str(raw).strip() == "":
        return DEFAULT_GOAL_OUTER_BUDGET
    try:
        n = int(raw)
        return max(1, min(n, 100))
    except (TypeError, ValueError):
        return DEFAULT_GOAL_OUTER_BUDGET


def init_goal_state(
    *,
    objective: str | None = None,
    budget: int | None = None,
) -> dict[str, Any]:
    return {
        "status": "running",
        "objective": _clip(objective or "", 500),
        "outer_budget": int(budget if budget is not None else default_goal_outer_budget()),
        "outer_rounds": 0,
        "terminal": None,
        "residual": None,
        "updated_at": _now_iso(),
    }


def evaluate_goal_terminal(
    workset: dict[str, Any],
    *,
    goal_on: bool,
    user_stopped: bool = False,
    turn_cancelled: bool = False,
    blocked: bool = False,
    blocked_reason: str | None = None,
) -> dict[str, Any]:
    """Compute Goal outer terminal after settle / Free return.

    Priority (Grok-aligned):
    - explicit Goal stop → goal_stopped
    - turn cancel (Esc/abort) → keep running (not stopped, not complete)
    - blocked → goal_blocked
    - outer budget exhausted → goal_budget_exhausted
    - else complete / continue from workset items

    goal_complete may carry residual awaiting_scope_confirm for pending t_host.
    Control always returns Free (caller responsibility — no Graph chain).
    """
    goal = dict(workset.get("goal") or {}) if isinstance(workset.get("goal"), dict) else None
    if not goal_on and not goal:
        return {
            "terminal": None,
            "status": "off",
            "return_to": "free",
            "residual": None,
            "goal": None,
        }
    if not goal:
        goal = init_goal_state()

    items = [i for i in (workset.get("items") or []) if isinstance(i, dict)]
    pending_hosts = [
        i for i in items
        if str(i.get("family") or "") == "t_host" and str(i.get("status") or "") == "proposed"
    ]
    # Auto-continuable proposed surfaces (Goal valve can still pick them up).
    auto_surfaces = [
        i for i in items
        if str(i.get("status") or "") == "proposed"
        and str(i.get("family") or "") == "t_surface"
        and i.get("auto_eligible")
    ]
    # Unfinished adopted / in_progress deepen work keeps Goal running after auto-adopt
    # (Spec #311 multi-round assembly — do not goal_complete merely because proposed
    # auto set is empty after the valve moved them to adopted).
    unfinished_deepen = [
        i for i in items
        if str(i.get("family") or "") == "t_surface"
        and (
            str(i.get("status") or "") == "adopted"
            or (
                bool(i.get("in_progress"))
                and str(i.get("status") or "") in OPEN_STATUSES
            )
        )
    ]

    residual: dict[str, Any] | None = None
    if pending_hosts:
        residual = {
            "class": "awaiting_scope_confirm",
            "pending_host_count": len(pending_hosts),
            "pending_host_ids": [str(h.get("id")) for h in pending_hosts[:40]],
        }

    if user_stopped:
        terminal = "goal_stopped"
    elif turn_cancelled:
        # Turn cancel only (Grok Esc): leave Case Goal outer open for continue.
        terminal = None
    elif blocked:
        terminal = "goal_blocked"
    else:
        budget = int(goal.get("outer_budget") or default_goal_outer_budget())
        rounds = int(goal.get("outer_rounds") or 0)
        if rounds >= budget:
            terminal = "goal_budget_exhausted"
        elif auto_surfaces or unfinished_deepen:
            # Still auto-continuable proposed, or unfinished adopted/in_progress deepen
            # → Free continues (never Graph-chain). Outer rounds track settle loops.
            terminal = None
        else:
            # No auto-continuable surface and no unfinished adopted deepen.
            # Residual hosts / other proposed stay visible after complete (US29) —
            # not full-coverage greenwash.
            terminal = "goal_complete"

    goal = dict(goal)
    goal["updated_at"] = _now_iso()
    if terminal:
        goal["status"] = terminal
        goal["terminal"] = terminal
        if residual:
            goal["residual"] = residual
        if blocked_reason:
            goal["blocked_reason"] = _clip(blocked_reason, 300)
    else:
        goal["status"] = "running"
        goal["terminal"] = None
        if residual:
            goal["residual"] = residual

    return {
        "terminal": terminal,
        "status": goal["status"],
        "return_to": "free",
        "residual": residual,
        "goal": goal,
        "full_coverage": False if residual else (terminal == "goal_complete"),
    }


def bump_goal_outer_round(workset: dict[str, Any]) -> dict[str, Any]:
    ws = {
        "version": int(workset.get("version") or 1),
        "items": [dict(i) for i in (workset.get("items") or []) if isinstance(i, dict)],
        "goal": dict(workset["goal"]) if isinstance(workset.get("goal"), dict) else None,
    }
    if not ws["goal"]:
        return ws
    g = dict(ws["goal"])
    g["outer_rounds"] = int(g.get("outer_rounds") or 0) + 1
    g["updated_at"] = _now_iso()
    ws["goal"] = g
    return ws


def project_workset_for_api(
    workset: dict[str, Any],
    *,
    include_terminal: bool = True,
) -> dict[str, Any]:
    """API/UI projection: ordered open items + residual done/rejected optional + goal."""
    items = [dict(i) for i in (workset.get("items") or []) if isinstance(i, dict)]
    ordered = order_workset_items(items)
    residual_items = [
        dict(i) for i in items
        if str(i.get("status") or "") in {"done", "rejected"}
    ]
    out: dict[str, Any] = {
        "version": int(workset.get("version") or 1),
        "items": ordered,
        "open_count": len(ordered),
        "all_items": items if include_terminal else ordered,
    }
    goal = workset.get("goal") if isinstance(workset.get("goal"), dict) else None
    if goal:
        out["goal"] = dict(goal)
    # Keep residuals visible after goal_complete.
    if residual_items:
        out["closed_items"] = residual_items[-40:]
    return out


def list_workset_for_agent(
    workset: dict[str, Any],
    *,
    family: str | None = None,
    status: str | None = None,
    needle: str | None = None,
    cap: int = AGENT_WORKSET_LIST_CAP,
    item_id: str | None = None,
) -> dict[str, Any]:
    """Filtered, capped Case Workset index for Agent tools (Spec #540)."""
    try:
        cap_n = int(cap or AGENT_WORKSET_LIST_CAP)
    except (TypeError, ValueError):
        cap_n = AGENT_WORKSET_LIST_CAP
    cap_n = max(1, min(cap_n, AGENT_WORKSET_LIST_CAP_MAX))
    items = [dict(i) for i in (workset.get("items") or []) if isinstance(i, dict)]
    want_id = str(item_id or "").strip()
    fam = str(family or "").strip().lower()
    st = str(status or "").strip().lower()
    q = str(needle or "").strip().lower()
    matched: list[dict[str, Any]] = []
    for item in items:
        if want_id:
            if str(item.get("id") or "") != want_id:
                continue
        else:
            cur_st = str(item.get("status") or "").strip().lower()
            if st:
                if cur_st != st:
                    continue
            elif cur_st not in OPEN_STATUSES:
                continue
            if fam and str(item.get("family") or "").strip().lower() != fam:
                continue
            if q:
                payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
                blob = " ".join(
                    [
                        str(item.get("id") or ""),
                        str(item.get("title") or ""),
                        str(item.get("summary") or ""),
                        str(payload.get("host") or ""),
                        str(payload.get("location") or ""),
                        str(payload.get("attribution") or ""),
                    ]
                ).lower()
                if q not in blob:
                    continue
        matched.append(item)
        if want_id:
            break
    total = len(matched)
    shown = matched[:cap_n]
    agent_items: list[dict[str, Any]] = []
    for i in shown:
        payload = i.get("payload") if isinstance(i.get("payload"), dict) else {}
        agent_items.append({
            "id": i.get("id"),
            "family": i.get("family"),
            "status": i.get("status"),
            "title": i.get("title"),
            "summary": i.get("summary"),
            "host": payload.get("host"),
            "location": payload.get("location"),
            "intel_source": payload.get("intel_source"),
            "attribution": payload.get("attribution"),
            "confidence": payload.get("confidence"),
            "scope_decision": payload.get("scope_decision"),
            "passive": payload.get("passive"),
            "source": i.get("source"),
        })
    return {
        "ok": True,
        "items": agent_items,
        "count": len(agent_items),
        "total": total,
        "omitted": max(0, total - len(agent_items)),
        "cap": cap_n,
        "note": (
            "Case Workset is pending admission — not Host, not Surface coverage, not Intel. "
            "Adopt is a user action unless Case asset-intake enroll_group applies. "
            "Parked hosts must not be probed or hung as Intel until adopt or enroll."
        ),
    }


def merge_proposed_into_context(
    context: dict | None,
    candidates: list[dict[str, Any]],
    *,
    source: str = "workset_propose",
) -> dict[str, Any]:
    """Mid-run Agent propose (Spec #532). Merge only — no Goal valve, no baton clear."""
    ctx = dict(context or {}) if isinstance(context, dict) else {}
    task = ctx.get("task") if isinstance(ctx.get("task"), dict) else {}
    scope_hosts = scope_hosts_from_task(task)
    ws = get_workset(ctx)
    ws = merge_proposed_items(ws, candidates, source=source, scope_hosts=scope_hosts)
    ctx = put_workset(ctx, ws)
    ctx, _enrolled = apply_intake_enroll_to_context(ctx)
    return ctx


def thin_handoff_brief(
    workset: dict[str, Any],
    *,
    boundary: str = "graph_to_free",
    max_items: int = 8,
) -> dict[str, Any]:
    """Thin brief at handoff boundaries only — refs + open Next, not fat case_context dump."""
    proj = project_workset_for_api(workset)
    open_items = proj.get("items") or []
    slim = []
    for item in open_items[:max_items]:
        slim.append({
            "id": item.get("id"),
            "family": item.get("family"),
            "title": item.get("title"),
            "status": item.get("status"),
            "auto_eligible": bool(item.get("auto_eligible")),
            "suggested_expert": item.get("suggested_expert"),
        })
    brief: dict[str, Any] = {
        "boundary": boundary,
        "workset_open": slim,
        "workset_open_count": len(open_items),
        "note": "Case Workset refs only — read detail from Case/tools; do not treat as full transcript dump.",
    }
    goal = proj.get("goal")
    if goal:
        brief["goal"] = {
            "status": goal.get("status"),
            "terminal": goal.get("terminal"),
            "outer_rounds": goal.get("outer_rounds"),
            "outer_budget": goal.get("outer_budget"),
            "residual": goal.get("residual"),
        }
    return brief


def apply_settle_to_context(
    context: dict | None,
    *,
    candidates: list[dict[str, Any]] | None = None,
    next_scope_candidates: list | None = None,
    attack_surface_candidates: list | None = None,
    source: str = "free_settle",
    goal_on: bool = False,
    goal_objective: str | None = None,
    user_stopped: bool = False,
    turn_cancelled: bool = False,
    goal_explicit_off: bool = False,
    blocked: bool = False,
    blocked_reason: str | None = None,
    bump_outer_round: bool = False,
) -> dict[str, Any]:
    """Primary platform seam: merge settle candidates into Case Workset + Goal valve.

    Returns updated context dict.

    Goal outer (Grok-aligned):
    - goal_on + not user_stopped → keep/reopen running; turn_cancelled skips complete
    - user_stopped or goal_explicit_off → goal_stopped
    - bump_outer_round skipped on turn_cancelled
    """
    ctx = dict(context or {}) if isinstance(context, dict) else {}
    task = ctx.get("task") if isinstance(ctx.get("task"), dict) else {}
    scope_hosts = scope_hosts_from_task(task)
    ws = get_workset(ctx)

    raw_cands: list[dict[str, Any]] = []
    if candidates:
        raw_cands.extend([c for c in candidates if isinstance(c, dict)])
    raw_cands.extend(
        candidates_from_next_scope(next_scope_candidates, attack_surface_candidates)
    )
    if raw_cands:
        ws = merge_proposed_items(ws, raw_cands, source=source, scope_hosts=scope_hosts)

    # Settle always clears in-progress baton annotation (baton ends with this burst).
    ws = clear_in_progress(ws)

    ctx = put_workset(ctx, ws)
    ctx, _enrolled = apply_intake_enroll_to_context(ctx)
    ws = get_workset(ctx)
    task = ctx.get("task") if isinstance(ctx.get("task"), dict) else {}
    scope_hosts = scope_hosts_from_task(task)

    stop_goal = bool(user_stopped or goal_explicit_off)

    # Goal state init / keep
    if goal_on and not stop_goal:
        if not isinstance(ws.get("goal"), dict):
            ws["goal"] = init_goal_state(objective=goal_objective or task.get("goal_objective"))
        elif goal_objective and not ws["goal"].get("objective"):
            ws["goal"] = dict(ws["goal"])
            ws["goal"]["objective"] = _clip(goal_objective, 500)
        # Grok: Goal still on → clear sticky goal_stopped so continue keeps outer running.
        if isinstance(ws.get("goal"), dict):
            g = dict(ws["goal"])
            if str(g.get("status") or "") == "goal_stopped" or str(g.get("terminal") or "") == "goal_stopped":
                g["status"] = "running"
                g["terminal"] = None
                ws["goal"] = g
        # Do not burn outer budget on turn-cancel settle (Esc / abort).
        if bump_outer_round and not turn_cancelled:
            ws = bump_goal_outer_round(ws)
        for item in ws["items"]:
            if str(item.get("status") or "") == "proposed":
                item["auto_eligible"] = auto_check_safe(item, scope_hosts)
        ws, _adopted = goal_auto_adopt(ws, scope_hosts=scope_hosts, goal_on=True)
        terminal_eval = evaluate_goal_terminal(
            ws,
            goal_on=True,
            user_stopped=False,
            turn_cancelled=turn_cancelled,
            blocked=blocked,
            blocked_reason=blocked_reason,
        )
        if terminal_eval.get("goal"):
            ws["goal"] = terminal_eval["goal"]
        ctx["goal_outer"] = {
            "terminal": terminal_eval.get("terminal"),
            "return_to": "free",
            "residual": terminal_eval.get("residual"),
            "full_coverage": terminal_eval.get("full_coverage"),
        }
    elif stop_goal and isinstance(ws.get("goal"), dict):
        # Explicit Goal-off (user_stopped flag, goal_clear token, or goal_mode: false).
        for item in ws["items"]:
            if str(item.get("status") or "") == "proposed":
                item["auto_eligible"] = auto_check_safe(item, scope_hosts)
        terminal_eval = evaluate_goal_terminal(
            ws,
            goal_on=True,
            user_stopped=True,
            turn_cancelled=False,
            blocked=blocked,
            blocked_reason=blocked_reason,
        )
        if terminal_eval.get("goal"):
            ws["goal"] = terminal_eval["goal"]
        ctx["goal_outer"] = {
            "terminal": terminal_eval.get("terminal"),
            "return_to": "free",
            "residual": terminal_eval.get("residual"),
            "full_coverage": terminal_eval.get("full_coverage"),
        }
    else:
        # Goal off / no Case goal: never auto-adopt; still refresh auto_eligible for UI.
        for item in ws["items"]:
            if str(item.get("status") or "") == "proposed":
                item["auto_eligible"] = auto_check_safe(item, scope_hosts)

    ctx = put_workset(ctx, ws)
    # Spec #540: legacy arrays are merge inputs only. Snapshot/API truth is Workset.
    ctx.pop("next_scope_candidates", None)
    ctx.pop("attack_surface_candidates", None)
    ctx.pop("next_scope_suggested", None)
    return ctx


async def materialize_intake_hosts(
    db: Any,
    *,
    user_id: Any,
    conversation_id: str,
    context: dict[str, Any],
) -> dict[str, Any]:
    """Create Owner Hosts in the intake Group for rows adopted by intake_policy."""
    policy = get_asset_intake(context)
    if policy["mode"] != "enroll_group":
        return context
    ws = get_workset(context)
    changed = False
    from app.services.node_ledger import NodeLedgerError, create_hosts_for_user

    for item in ws.get("items") or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("status") or "") != "adopted":
            continue
        if str(item.get("status_actor") or "") != "intake_policy":
            continue
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        if payload.get("intake_materialized"):
            continue
        fields = host_expand_fields_from_item(item)
        if not fields:
            continue
        try:
            await create_hosts_for_user(
                db,
                user_id=user_id,
                conversation_id=conversation_id,
                address=fields["host"],
                ports=[fields["port"]] if fields.get("port") else None,
                reason="Case asset-intake policy (user-delegated enroll_group)",
                group_id=policy.get("group_id"),
                group_name=policy.get("group_name"),
            )
        except NodeLedgerError as e:
            print(f"[intake] materialize skip {fields.get('host')}: {e}")
            continue
        except Exception as e:
            print(f"[intake] materialize error {fields.get('host')}: {e}")
            continue
        item["payload"] = {**payload, "intake_materialized": True}
        changed = True
    if changed:
        context = put_workset(context, ws)
    return context
