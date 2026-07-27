"""Engagement close-out productization (Spec #139 NC-Closeout / #163).

Node emits type=engagement_closeout with the same JSON as taskDir
hard-graph/engagement-closeout.json. Platform stores that payload on
conversation.context and as a structured timeline message.

Required top keys must stay aligned with:
- node4 EngagementCloseout type (node4/src/runtime/engagement-closeout.ts)
- score script CLOSEOUT_REQUIRED (node4/scripts/score-process-discovery-139.py)
- docs/specs/task-graph.md NC-Closeout row
"""

from __future__ import annotations

from typing import Any


# Keep identical to score script CLOSEOUT_REQUIRED + Node EngagementCloseout required fields.
REQUIRED_TOP_KEYS = (
    "scope",
    "target",
    "graphId",
    "terminal",
    "stages",
    "surfaces",
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
    # scope / target / surfaces: present and object-shaped (dict)
    if not isinstance(closeout.get("scope"), dict):
        return False
    if not isinstance(closeout.get("target"), dict):
        return False
    if not isinstance(closeout.get("surfaces"), dict):
        return False
    return True


def accept_engagement_closeout(msg: dict[str, Any] | None) -> dict[str, Any] | None:
    """Single accept gate for dual-write (context + timeline).

    Extract payload then require NC-Closeout fields. Returns validated closeout
    dict, or None when the frame must not be remembered or saved.
    """
    closeout = extract_closeout_payload(msg)
    if not required_fields_present(closeout):
        return None
    # required_fields_present guarantees a non-empty dict
    assert isinstance(closeout, dict)
    return closeout


def message_content_from_closeout(
    msg: dict[str, Any],
    closeout: dict[str, Any],
) -> dict[str, Any]:
    """Stable timeline content: human gist + full JSON semantics.

    Call only after accept_engagement_closeout succeeds — single gist builder
    for persisted timeline rows (frontend should reuse content.text / msg.message).
    """
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
    """Store latest close-out as Product state on conversation.context.

    Latest only — multi-run history is not a product surface yet (no consumer).
    """
    ctx = dict(context or {})
    # Ignore close-out from a superseded work burst when active_task_id is set.
    active = str(ctx.get("active_task_id") or "").strip()
    tid = str(task_id or "").strip()
    if active and tid and active != tid:
        return ctx
    ctx["engagement_closeout"] = closeout
    return ctx
