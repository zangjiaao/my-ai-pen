"""Spec #309 — Case traffic exchange store / project (pure + context merge).

SoT lives on conversation.context["traffic_exchanges"] (dict by exchange_id).
UI N3 filter is view-only (frontend); store keeps fuller browser rows.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

# Soft caps: keep Case bounded without claiming MITM completeness.
DEFAULT_ROW_CAP = 500
# Prefer dropping oldest full bodies before dropping rows.
STRIP_BODY_AFTER = 300

SOURCES = frozenset({"http", "browser", "mitm"})
PHASES = frozenset({"pending", "completed", "failed"})


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _str_or_none(value: Any, *, max_len: int | None = None) -> str | None:
    if value is None:
        return None
    text = str(value)
    if max_len is not None and len(text) > max_len:
        return text[:max_len]
    return text


def _headers(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    out: dict[str, str] = {}
    for key, raw in value.items():
        if raw is None:
            continue
        out[str(key)] = str(raw)
    return out or None


def normalize_traffic_exchange(msg: dict, *, conversation_id: str | None = None) -> dict | None:
    """Normalize an inbound traffic_exchange frame. Returns None if unusable."""
    if not isinstance(msg, dict):
        return None
    exchange_id = str(msg.get("exchange_id") or "").strip()
    if not exchange_id:
        return None
    conv = str(conversation_id or msg.get("conversation_id") or "").strip()
    if not conv:
        return None
    source = str(msg.get("source") or "http").strip().lower()
    if source not in SOURCES:
        source = "http"
    phase = str(msg.get("phase") or "pending").strip().lower()
    if phase not in PHASES:
        phase = "pending"
    method = str(msg.get("method") or "GET").strip().upper() or "GET"
    url = str(msg.get("url") or "").strip()
    if not url:
        return None

    status_raw = msg.get("status_code")
    status_code: int | None
    if status_raw is None or status_raw == "":
        status_code = None
    else:
        try:
            status_code = int(status_raw)
        except (TypeError, ValueError):
            status_code = None

    seq_raw = msg.get("sequence")
    sequence: int | None
    try:
        sequence = int(seq_raw) if seq_raw is not None and seq_raw != "" else None
    except (TypeError, ValueError):
        sequence = None

    duration_raw = msg.get("duration_ms")
    try:
        duration_ms = int(duration_raw) if duration_raw is not None and duration_raw != "" else None
    except (TypeError, ValueError):
        duration_ms = None

    resource = msg.get("browser_resource_class")
    resource_class = str(resource).strip().lower() if resource else None
    if resource_class == "":
        resource_class = None

    return {
        "type": "traffic_exchange",
        "exchange_id": exchange_id,
        "conversation_id": conv,
        "task_id": _str_or_none(msg.get("task_id"), max_len=120),
        "sequence": sequence,
        "source": source,
        "phase": phase,
        "method": method,
        "url": url,
        "request_headers": _headers(msg.get("request_headers")),
        "request_body": _str_or_none(msg.get("request_body")),
        "status_code": status_code,
        "response_headers": _headers(msg.get("response_headers")),
        "response_body": _str_or_none(msg.get("response_body")),
        "content_type": _str_or_none(msg.get("content_type"), max_len=200),
        "started_at": _str_or_none(msg.get("started_at")) or _now_iso(),
        "completed_at": _str_or_none(msg.get("completed_at")),
        "duration_ms": duration_ms,
        "error": _str_or_none(msg.get("error"), max_len=2000),
        "request_body_truncated": bool(msg.get("request_body_truncated")),
        "response_body_truncated": bool(msg.get("response_body_truncated")),
        "request_body_bytes": _safe_int(msg.get("request_body_bytes")),
        "response_body_bytes": _safe_int(msg.get("response_body_bytes")),
        "request_body_hash": _str_or_none(msg.get("request_body_hash"), max_len=64),
        "response_body_hash": _str_or_none(msg.get("response_body_hash"), max_len=64),
        "request_body_binary": bool(msg.get("request_body_binary")),
        "response_body_binary": bool(msg.get("response_body_binary")),
        "browser_resource_class": resource_class,
        "is_websocket": bool(msg.get("is_websocket")),
    }


def _safe_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def merge_exchange(existing: dict | None, incoming: dict) -> dict:
    """Upsert merge by exchange_id: later phase wins fields; preserve request side."""
    if not existing:
        return dict(incoming)
    out = dict(existing)
    # Identity locked
    out["exchange_id"] = existing.get("exchange_id") or incoming.get("exchange_id")
    out["conversation_id"] = existing.get("conversation_id") or incoming.get("conversation_id")
    # Prefer non-empty sequence
    if incoming.get("sequence") is not None:
        out["sequence"] = incoming["sequence"]
    for key in (
        "task_id",
        "source",
        "method",
        "url",
        "started_at",
        "browser_resource_class",
        "is_websocket",
        "request_headers",
        "request_body",
        "request_body_truncated",
        "request_body_bytes",
        "request_body_hash",
        "request_body_binary",
    ):
        if incoming.get(key) is not None:
            # Don't wipe request body with null on terminal if already set
            if key in {"request_body", "request_headers"} and existing.get(key) and incoming.get(key) is None:
                continue
            out[key] = incoming[key]

    phase_rank = {"pending": 0, "completed": 1, "failed": 1}
    old_phase = str(existing.get("phase") or "pending")
    new_phase = str(incoming.get("phase") or old_phase)
    if phase_rank.get(new_phase, 0) >= phase_rank.get(old_phase, 0):
        out["phase"] = new_phase
        for key in (
            "status_code",
            "response_headers",
            "response_body",
            "content_type",
            "completed_at",
            "duration_ms",
            "error",
            "response_body_truncated",
            "response_body_bytes",
            "response_body_hash",
            "response_body_binary",
        ):
            if key in incoming:
                out[key] = incoming[key]
    out["type"] = "traffic_exchange"
    return out


def upsert_into_store(
    store: dict[str, dict] | list | None,
    exchange: dict,
    *,
    row_cap: int = DEFAULT_ROW_CAP,
) -> dict[str, dict]:
    """Return new store dict after upsert. Case-scoped caller supplies per-conv store."""
    if isinstance(store, list):
        base: dict[str, dict] = {}
        for item in store:
            if isinstance(item, dict) and item.get("exchange_id"):
                base[str(item["exchange_id"])] = item
    elif isinstance(store, dict):
        base = {str(k): dict(v) for k, v in store.items() if isinstance(v, dict)}
    else:
        base = {}

    eid = str(exchange["exchange_id"])
    base[eid] = merge_exchange(base.get(eid), exchange)

    # Soft cap: drop oldest by started_at / sequence
    if len(base) > row_cap:
        ordered = sorted(
            base.values(),
            key=lambda row: (
                int(row.get("sequence") or 0),
                str(row.get("started_at") or ""),
            ),
        )
        drop_n = len(base) - row_cap
        for row in ordered[:drop_n]:
            base.pop(str(row.get("exchange_id") or ""), None)

    # Strip oldest bodies when over soft body retention
    if len(base) > STRIP_BODY_AFTER:
        ordered = sorted(
            base.values(),
            key=lambda row: (
                int(row.get("sequence") or 0),
                str(row.get("started_at") or ""),
            ),
        )
        for row in ordered[: max(0, len(base) - STRIP_BODY_AFTER)]:
            eid2 = str(row.get("exchange_id") or "")
            if not eid2 or eid2 not in base:
                continue
            trimmed = dict(base[eid2])
            if trimmed.get("request_body"):
                trimmed["request_body"] = None
                trimmed["request_body_truncated"] = True
            if trimmed.get("response_body"):
                trimmed["response_body"] = None
                trimmed["response_body_truncated"] = True
            base[eid2] = trimmed

    return base


def merge_traffic_into_context(
    context: dict | None,
    exchange: dict,
    *,
    row_cap: int = DEFAULT_ROW_CAP,
) -> dict:
    """Pure: return new conversation.context with upserted traffic store."""
    ctx = dict(context) if isinstance(context, dict) else {}
    store = ctx.get("traffic_exchanges")
    ctx["traffic_exchanges"] = upsert_into_store(store, exchange, row_cap=row_cap)
    return ctx


def traffic_exchanges_for_panel(
    context: dict | None,
    *,
    conversation_id: str | None = None,
) -> list[dict]:
    """Project Case traffic list for snapshot (all stored rows; N3 is FE view filter)."""
    if not isinstance(context, dict):
        return []
    store = context.get("traffic_exchanges")
    rows: list[dict] = []
    if isinstance(store, dict):
        rows = [dict(v) for v in store.values() if isinstance(v, dict)]
    elif isinstance(store, list):
        rows = [dict(v) for v in store if isinstance(v, dict)]
    if conversation_id:
        cid = str(conversation_id)
        rows = [r for r in rows if str(r.get("conversation_id") or cid) == cid]
    rows.sort(
        key=lambda r: (
            int(r.get("sequence") or 0),
            str(r.get("started_at") or ""),
            str(r.get("exchange_id") or ""),
        )
    )
    return rows


def project_exchange_detail(exchange: dict | None) -> dict | None:
    """S4: detail projection fields for dialog (pure)."""
    if not isinstance(exchange, dict):
        return None
    phase = str(exchange.get("phase") or "pending")
    waiting_response = phase == "pending"
    return {
        "exchange_id": exchange.get("exchange_id"),
        "source": exchange.get("source"),
        "phase": phase,
        "method": exchange.get("method"),
        "url": exchange.get("url"),
        "status_code": exchange.get("status_code"),
        "request_headers": exchange.get("request_headers"),
        "request_body": exchange.get("request_body"),
        "response_headers": exchange.get("response_headers"),
        "response_body": exchange.get("response_body"),
        "content_type": exchange.get("content_type"),
        "waiting_response": waiting_response,
        "request_body_truncated": bool(exchange.get("request_body_truncated")),
        "response_body_truncated": bool(exchange.get("response_body_truncated")),
        "request_body_bytes": exchange.get("request_body_bytes"),
        "response_body_bytes": exchange.get("response_body_bytes"),
        "request_body_hash": exchange.get("request_body_hash"),
        "response_body_hash": exchange.get("response_body_hash"),
        "request_body_binary": bool(exchange.get("request_body_binary")),
        "response_body_binary": bool(exchange.get("response_body_binary")),
        "error": exchange.get("error"),
        "started_at": exchange.get("started_at"),
        "completed_at": exchange.get("completed_at"),
        "duration_ms": exchange.get("duration_ms"),
        "browser_resource_class": exchange.get("browser_resource_class"),
        "is_websocket": bool(exchange.get("is_websocket")),
    }


def exchanges_do_not_cross_cases(
    store_a: dict[str, dict],
    store_b: dict[str, dict],
    exchange_for_a: dict,
) -> tuple[dict[str, dict], dict[str, dict]]:
    """Helper for tests: upsert into A leaves B unchanged."""
    next_a = upsert_into_store(deepcopy(store_a), exchange_for_a)
    return next_a, deepcopy(store_b)
