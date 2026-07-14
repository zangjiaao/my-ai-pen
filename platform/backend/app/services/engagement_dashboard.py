"""Build engagement dashboard DTO from real conversation / finding / event-shaped data."""
from __future__ import annotations

from typing import Any


def _sev(v: dict[str, Any]) -> str:
    return str(v.get("severity") or "unknown").strip().lower() or "unknown"


def _title(v: dict[str, Any]) -> str:
    return str(v.get("title") or v.get("name") or "Untitled").strip() or "Untitled"


# Message types that belong on the engagement activity rail.
_ACTIVITY_MSG_TYPES = frozenset(
    {
        "status",
        "status_update",
        "vuln_card",
        "vuln_found",
        "tool_call",
        "agent",
        "text",
    }
)


def activity_from_snapshot_messages(messages: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Map snapshot `message_summary` / compact rows → dashboard activity.

    Real rows look like::
        {"id": "...", "msg_type": "tool_call", "content": {"tool_name": "shell", ...}, "created_at": "..."}
    Legacy flat rows (type/text) are still accepted for older callers.
    """
    activity: list[dict[str, Any]] = []
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        content = m.get("content") if isinstance(m.get("content"), dict) else {}
        mtype = str(
            m.get("msg_type") or m.get("type") or m.get("message_type") or content.get("type") or ""
        ).strip()
        if mtype not in _ACTIVITY_MSG_TYPES:
            continue
        title = str(
            content.get("title")
            or content.get("text")
            or content.get("tool_name")
            or content.get("phase")
            or m.get("text")
            or m.get("title")
            or mtype
        ).strip()
        detail_bits = []
        if content.get("tool_name") and content.get("tool_name") not in title:
            detail_bits.append(str(content.get("tool_name")))
        if content.get("status"):
            detail_bits.append(str(content.get("status")))
        if content.get("command"):
            detail_bits.append(str(content.get("command"))[:160])
        activity.append(
            {
                "id": str(m.get("id") or m.get("event_id") or ""),
                "type": mtype,
                "title": title[:200] or mtype,
                "detail": (" · ".join(detail_bits)[:500] if detail_bits else None),
                "at": m.get("created_at") or m.get("at") or m.get("ts"),
                "status": content.get("status") or m.get("status"),
            }
        )
    return activity


def build_engagement_dashboard(
    *,
    conversation: dict[str, Any] | None = None,
    agent_state: dict[str, Any] | None = None,
    findings: list[dict[str, Any]] | None = None,
    timeline_events: list[dict[str, Any]] | None = None,
    engagement: str | None = None,
    target: str | None = None,
    progress: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return a JSON-serializable dashboard payload.

    All lists come from caller-supplied real data (DB / snapshot / events).
    Never injects placeholder findings.
    """
    conversation = conversation or {}
    agent_state = agent_state or {}
    findings = [f for f in (findings or []) if isinstance(f, dict)]
    timeline_events = [e for e in (timeline_events or []) if isinstance(e, dict)]
    progress = progress or {}

    severity_counts: dict[str, int] = {}
    for f in findings:
        s = _sev(f)
        severity_counts[s] = severity_counts.get(s, 0) + 1

    finding_rows = []
    for f in findings:
        finding_rows.append(
            {
                "id": str(f.get("id") or f.get("vulnerability_id") or ""),
                "title": _title(f),
                "severity": _sev(f),
                "status": str(f.get("status") or ""),
                "evidence_ids": list(f.get("evidence_ids") or f.get("evidenceIds") or [])
                if isinstance(f.get("evidence_ids") or f.get("evidenceIds"), list)
                else [],
            }
        )

    # Newest activity first when timestamps exist; preserve input order otherwise.
    activity = []
    for e in timeline_events[-100:]:
        activity.append(
            {
                "id": str(e.get("id") or e.get("event_id") or ""),
                "type": str(e.get("type") or e.get("category") or "event"),
                "title": str(e.get("title") or e.get("type") or "event"),
                "detail": str(e.get("detail") or e.get("text") or "")[:500] or None,
                "at": e.get("at") or e.get("created_at") or e.get("ts"),
                "status": e.get("status"),
            }
        )

    status = str(conversation.get("status") or agent_state.get("phase") or "unknown")
    task_blob = conversation.get("task") if isinstance(conversation.get("task"), dict) else {}
    eng = (
        engagement
        or conversation.get("engagement")
        or task_blob.get("engagement")
        or task_blob.get("role")
        or None
    )
    return {
        "conversation_id": str(conversation.get("id") or ""),
        "title": str(conversation.get("title") or ""),
        "status": status,
        "engagement": eng,
        "target": target or conversation.get("target") or task_blob.get("target"),
        "agent": {
            "phase": agent_state.get("phase") or agent_state.get("intakeStatus"),
            "active_tool": agent_state.get("activeTool") or agent_state.get("active_tool"),
            "raw": {k: agent_state[k] for k in list(agent_state)[:20]},
        },
        "progress": {
            "current": progress.get("current", 0),
            "total": progress.get("total", 0),
        },
        "findings_count": len(finding_rows),
        "severity_counts": severity_counts,
        "findings": finding_rows,
        "activity": activity,
    }
