"""Case work-group context for expert dispatch.

Same conversation = same case (work group). When any expert is task_assign'd,
attach a readable thread + findings board so the agent is not amnesic.

Not NLP engagement invent. Not full tool dumps. Structured envelope only.
"""
from __future__ import annotations

from typing import Any

# Prefer human-readable group traffic; skip heartbeat/tool floods by default.
_THREAD_INCLUDE_TYPES = frozenset({
    "text",
    "decision",
    "vuln_found",
    "vuln_card",
    "confirm_card",
    "user_steer",
    "user_input",
})
# Status lines that are useful once (settlement), not every checkpoint.
_STATUS_KEEP_SUBSTRINGS = (
    "completed",
    "failed",
    "error",
    "interrupted",
    "blocked",
    "handoff",
    "settled",
)

DEFAULT_THREAD_LIMIT = 40
DEFAULT_FINDINGS_LIMIT = 20
DEFAULT_LINE_CHARS = 800
DEFAULT_TOTAL_CHARS = 14000


def _clip(text: str, limit: int = DEFAULT_LINE_CHARS) -> str:
    t = " ".join(str(text or "").split())
    if len(t) <= limit:
        return t
    return t[: max(0, limit - 20)] + "…(truncated)"


def _speaker_from_message(role: str, content: dict, msg_type: str) -> str:
    if role == "user":
        return "user"
    name = (
        content.get("expert_name")
        or content.get("agent_name")
        or content.get("agent_source")
    )
    if name:
        return str(name).strip()[:80]
    pack = content.get("role_pack") or content.get("engagement")
    if pack:
        return f"expert:{pack}"
    if msg_type in {"vuln_found", "vuln_card"}:
        return "finding"
    return role or "agent"


def _line_from_message(msg: dict) -> dict[str, str] | None:
    """Turn a stored message summary into one thread line, or None to skip."""
    role = str(msg.get("role") or "")
    msg_type = str(msg.get("msg_type") or msg.get("type") or "")
    content = msg.get("content") if isinstance(msg.get("content"), dict) else {}
    if not isinstance(content, dict):
        content = {}

    if msg_type in _THREAD_INCLUDE_TYPES or role == "user":
        text = ""
        if msg_type in {"vuln_found", "vuln_card"}:
            title = content.get("title") or "finding"
            sev = content.get("severity") or ""
            loc = content.get("location") or content.get("url") or ""
            st = content.get("status") or ""
            text = f"[finding {st}] {sev} {title} @ {loc}".strip()
        else:
            text = str(
                content.get("text")
                or content.get("message")
                or content.get("instruction")
                or content.get("summary")
                or ""
            ).strip()
            if not text and content.get("reason"):
                text = str(content.get("reason")).strip()
        if not text:
            return None
        return {
            "speaker": _speaker_from_message(role, content, msg_type),
            "kind": msg_type or "text",
            "text": _clip(text),
            "ts": str(msg.get("created_at") or "")[:32],
        }

    if msg_type == "status":
        blob = str(
            content.get("text")
            or content.get("message")
            or content.get("summary")
            or content.get("status")
            or ""
        ).lower()
        if not any(s in blob for s in _STATUS_KEEP_SUBSTRINGS):
            return None
        text = str(content.get("text") or content.get("message") or content.get("summary") or "").strip()
        if not text:
            return None
        return {
            "speaker": _speaker_from_message(role, content, msg_type),
            "kind": "status",
            "text": _clip(text, 400),
            "ts": str(msg.get("created_at") or "")[:32],
        }

    # Optional one-line tool crumbs only if summary is short and informative
    if msg_type == "tool_call":
        summary = str(content.get("summary") or content.get("tool_name") or "").strip()
        if not summary or len(summary) > 200:
            return None
        tool = content.get("tool_name") or "tool"
        return {
            "speaker": _speaker_from_message(role, content, msg_type),
            "kind": "tool",
            "text": _clip(f"[{tool}] {summary}", 240),
            "ts": str(msg.get("created_at") or "")[:32],
        }

    return None


def build_thread_from_messages(
    messages: list[dict],
    *,
    limit: int = DEFAULT_THREAD_LIMIT,
    total_chars: int = DEFAULT_TOTAL_CHARS,
) -> list[dict[str, str]]:
    """Build chronological thread lines from message summaries (oldest→newest)."""
    lines: list[dict[str, str]] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        line = _line_from_message(msg)
        if line:
            lines.append(line)
    if limit > 0 and len(lines) > limit:
        lines = lines[-limit:]
    # Enforce total char budget from the end (keep latest)
    kept: list[dict[str, str]] = []
    used = 0
    for line in reversed(lines):
        n = len(line.get("text") or "") + len(line.get("speaker") or "") + 8
        if used + n > total_chars and kept:
            break
        kept.append(line)
        used += n
    kept.reverse()
    return kept


def build_findings_summary(
    findings: list[dict],
    *,
    limit: int = DEFAULT_FINDINGS_LIMIT,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for f in findings:
        if not isinstance(f, dict):
            continue
        title = str(f.get("title") or "").strip()
        if not title:
            continue
        out.append({
            "id": str(f.get("id") or f.get("finding_id") or f.get("vulnerability_id") or "")[:80],
            "title": _clip(title, 200),
            "severity": str(f.get("severity") or "medium")[:32],
            "status": str(f.get("status") or "")[:32],
            "location": _clip(str(f.get("location") or f.get("url") or f.get("affected_asset") or ""), 200),
        })
        if limit > 0 and len(out) >= limit:
            break
    return out


def extract_artifact_hints(thread: list[dict[str, str]], findings: list[dict]) -> list[str]:
    """Light path/id hints from thread text (no full file bodies)."""
    hints: list[str] = []
    seen: set[str] = set()
    needles = ("HANDOFF", "source_dump", "workspace/", "evidence/", "findings/", ".md", "/mnt/", "D:\\", "notes/")
    for line in thread:
        text = line.get("text") or ""
        if not any(n.lower() in text.lower() for n in needles):
            continue
        # keep short slices that look like paths
        for token in text.replace(",", " ").split():
            if any(n.lower() in token.lower() for n in needles) and len(token) > 4:
                t = token.strip("`'\"()[]")
                if t not in seen and len(t) < 260:
                    seen.add(t)
                    hints.append(t)
            if len(hints) >= 12:
                return hints
    for f in findings:
        for eid in (f.get("evidence_ids") or [])[:3]:
            s = f"evidence:{eid}"
            if s not in seen:
                seen.add(s)
                hints.append(s)
    return hints[:12]


def build_case_context_payload(
    *,
    messages: list[dict],
    findings: list[dict] | None = None,
    conversation_id: str | None = None,
    thread_limit: int = DEFAULT_THREAD_LIMIT,
    findings_limit: int = DEFAULT_FINDINGS_LIMIT,
) -> dict[str, Any]:
    """Pure builder for tests and dispatch."""
    thread = build_thread_from_messages(messages, limit=thread_limit)
    findings_summary = build_findings_summary(findings or [], limit=findings_limit)
    # Also fold vuln lines already in thread into board if findings empty
    if not findings_summary:
        for line in thread:
            if line.get("kind") in {"vuln_found", "vuln_card"} or line.get("text", "").startswith("[finding"):
                findings_summary.append({
                    "id": "",
                    "title": _clip(line.get("text") or "", 200),
                    "severity": "",
                    "status": "",
                    "location": "",
                })
        findings_summary = findings_summary[:findings_limit]
    hints = extract_artifact_hints(thread, findings or [])
    return {
        "version": 1,
        "conversation_id": conversation_id,
        "thread": thread,
        "findings_summary": findings_summary,
        "artifact_hints": hints,
        "note": (
            "Same case work-group thread. Read before acting. "
            "Large files are not inlined — use paths/hints if present."
        ),
    }


async def load_case_context_for_conversation(
    db,
    conversation_id,
    *,
    user_id=None,
    thread_limit: int = DEFAULT_THREAD_LIMIT,
    findings_limit: int = DEFAULT_FINDINGS_LIMIT,
) -> dict[str, Any]:
    """Load messages + vulns from DB and build case_context."""
    import uuid as uuid_mod

    from sqlalchemy import select

    from app.models.message import Message
    from app.models.vulnerability import Vulnerability
    from app.services.conversation_snapshot import message_summary

    cid = conversation_id if isinstance(conversation_id, uuid_mod.UUID) else uuid_mod.UUID(str(conversation_id))
    result = await db.execute(
        select(Message)
        .where(Message.conversation_id == cid)
        .order_by(Message.created_at, Message.id)
    )
    messages = [message_summary(m) for m in result.scalars().all()]

    findings: list[dict] = []
    try:
        q = select(Vulnerability).where(Vulnerability.conversation_id == cid)
        if user_id is not None:
            uid = user_id if isinstance(user_id, uuid_mod.UUID) else uuid_mod.UUID(str(user_id))
            q = q.where(Vulnerability.user_id == uid)
        q = q.order_by(Vulnerability.discovered_at.desc()).limit(findings_limit * 2)
        vulns = (await db.execute(q)).scalars().all()
        for v in vulns:
            findings.append({
                "id": str(getattr(v, "id", "") or ""),
                "title": getattr(v, "title", None) or "Untitled",
                "severity": getattr(v, "severity", None) or "medium",
                "status": getattr(v, "status", None) or "",
                "location": getattr(v, "location", None)
                or getattr(v, "affected_asset", None)
                or getattr(v, "url", None)
                or "",
                "evidence_ids": list(getattr(v, "evidence_ids", None) or []),
            })
    except Exception:
        # Fall back to vuln_found in messages only
        findings = []

    return build_case_context_payload(
        messages=messages,
        findings=findings,
        conversation_id=str(cid),
        thread_limit=thread_limit,
        findings_limit=findings_limit,
    )
