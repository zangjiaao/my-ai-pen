"""Engagement close-out productization (Spec #139 NC-Closeout / #163).

Node emits type=engagement_closeout with the same JSON as taskDir
hard-graph/engagement-closeout.json. Platform stores that payload on
conversation.context and as a structured timeline message.
"""

from __future__ import annotations

from typing import Any


REQUIRED_TOP_KEYS = (
    "graphId",
    "terminal",
    "stages",
    "findings",
    "priors",
    "feedback",
    "residual_risk",
)


def extract_closeout_payload(msg: dict[str, Any] | None) -> dict[str, Any] | None:
    """Pull structured close-out from a node WS/message frame."""
    if not isinstance(msg, dict):
        return None
    raw = msg.get("engagement_closeout")
    if isinstance(raw, dict) and raw:
        return dict(raw)
    # Tolerate nested content from rehydrated timeline rows
    content = msg.get("content")
    if isinstance(content, dict):
        nested = content.get("engagement_closeout")
        if isinstance(nested, dict) and nested:
            return dict(nested)
    return None


def required_fields_present(closeout: dict[str, Any] | None) -> bool:
    if not isinstance(closeout, dict) or not closeout:
        return False
    for key in REQUIRED_TOP_KEYS:
        if key not in closeout:
            return False
    if not isinstance(closeout.get("stages"), list):
        return False
    if not isinstance(closeout.get("findings"), dict):
        return False
    if not isinstance(closeout.get("priors"), dict):
        return False
    if not isinstance(closeout.get("feedback"), list):
        return False
    return True


def message_content_from_closeout(
    msg: dict[str, Any],
    closeout: dict[str, Any],
) -> dict[str, Any]:
    """Stable timeline content: human gist + full JSON semantics."""
    terminal = str(closeout.get("terminal") or msg.get("status") or "unknown")
    graph_id = str(closeout.get("graphId") or "")
    process_complete = closeout.get("process_complete")
    residual = str(closeout.get("residual_risk") or "").strip()
    residual_class = closeout.get("residual_class")
    booked_n = 0
    findings = closeout.get("findings") if isinstance(closeout.get("findings"), dict) else {}
    titles = findings.get("booked_titles") if isinstance(findings, dict) else None
    if isinstance(titles, list):
        booked_n = len(titles)
    text = msg.get("message") or f"Engagement close-out · terminal={terminal} · graph={graph_id}"
    if process_complete is False:
        text = f"{text} · process incomplete"
    content: dict[str, Any] = {
        "text": text,
        "type": "engagement_closeout",
        "engagement_closeout": closeout,
        "status": terminal,
        "terminal": terminal,
        "graphId": graph_id,
        "process_complete": process_complete,
        "residual_risk": residual,
        "booked_titles_n": booked_n,
    }
    if residual_class:
        content["residual_class"] = residual_class
    if closeout.get("booking_tail_ran") is not None:
        content["booking_tail_ran"] = closeout.get("booking_tail_ran")
    if isinstance(closeout.get("blocked_reasons"), list):
        content["blocked_reasons"] = closeout.get("blocked_reasons")
    return content


def merge_closeout_into_context(
    context: dict[str, Any] | None,
    closeout: dict[str, Any],
    *,
    task_id: str | None = None,
) -> dict[str, Any]:
    """Store latest close-out as Product state on conversation.context."""
    ctx = dict(context or {})
    # Ignore close-out from a superseded work burst when active_task_id is set.
    active = str(ctx.get("active_task_id") or "").strip()
    tid = str(task_id or "").strip()
    if active and tid and active != tid:
        return ctx
    ctx["engagement_closeout"] = closeout
    history = ctx.get("engagement_closeout_history")
    if not isinstance(history, list):
        history = []
    entry = dict(closeout)
    if tid:
        entry["_task_id"] = tid
    history = [h for h in history if isinstance(h, dict)]
    history.append(entry)
    ctx["engagement_closeout_history"] = history[-8:]
    return ctx
