"""Case work-group context for expert dispatch.

Same conversation = same case (work group). When any expert is task_assign'd,
attach a readable thread + findings board + evidence snippets so the next expert
can continue without prior taskDir paths.

Not NLP engagement invent. Not full tool dumps. Structured envelope only.
Evidence is Case-shared material for multi-expert collab (e.g. pentest source
leak → code-audit reads path + preview from evidence_snippets).
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
DEFAULT_EVIDENCE_SNIPPETS = 12
DEFAULT_LINE_CHARS = 800
DEFAULT_EXCERPT_CHARS = 480
DEFAULT_TOTAL_CHARS = 14000

# Meta tools that should not dominate collab context (unless finding-linked).
# Note: source_tool "finding" is *book-time product proof* (emitCaseEvidence) — not meta noise.
_TRACE_SOURCE_TOOLS = frozenset({
    "todo",
    "skill",
    "read",
    "edit",
    "goal",
    "subagent",
})


def _clip(text: str, limit: int = DEFAULT_LINE_CHARS) -> str:
    t = " ".join(str(text or "").split())
    if len(t) <= limit:
        return t
    return t[: max(0, limit - 20)] + "…(truncated)"


def _clip_block(text: str, limit: int = DEFAULT_EXCERPT_CHARS) -> str:
    t = str(text or "").strip()
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


def _proof_from_description(description: str | None) -> str:
    text = str(description or "").strip()
    if not text:
        return ""
    marker = "[Proof]"
    if marker in text:
        return _clip_block(text.split(marker, 1)[1].strip(), DEFAULT_EXCERPT_CHARS)
    return _clip_block(text, 240)


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
        eids = f.get("evidence_ids") or []
        if not isinstance(eids, list):
            eids = []
        clean_eids = [str(x) for x in eids if str(x or "").strip()][:12]
        proof = _proof_from_description(f.get("description") or f.get("poc"))
        row: dict[str, Any] = {
            "id": str(f.get("id") or f.get("finding_id") or f.get("vulnerability_id") or "")[:80],
            "title": _clip(title, 200),
            "severity": str(f.get("severity") or "medium")[:32],
            "status": str(f.get("status") or "")[:32],
            "location": _clip(str(f.get("location") or f.get("url") or f.get("affected_asset") or ""), 200),
            "evidence_ids": clean_eids,
        }
        if f.get("asset_id"):
            row["asset_id"] = str(f.get("asset_id"))[:80]
        if f.get("port"):
            row["port"] = str(f.get("port"))[:16]
        if f.get("first_seen_at"):
            row["first_seen_at"] = str(f.get("first_seen_at"))[:40]
        if f.get("multiple_discoveries") or int(f.get("rediscovery_count") or 0) > 0:
            row["multiple_discoveries"] = True
            row["rediscovery_count"] = int(f.get("rediscovery_count") or 0)
        if proof:
            row["proof_excerpt"] = proof
        out.append(row)
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


def _props_dict(raw: Any) -> dict[str, Any]:
    return raw if isinstance(raw, dict) else {}


def excerpt_from_properties(properties: dict[str, Any] | None, *, limit: int = DEFAULT_EXCERPT_CHARS) -> str:
    """Build a short collab-facing excerpt from evidence.properties."""
    p = _props_dict(properties)
    if p.get("excerpt"):
        return _clip_block(str(p["excerpt"]), limit)
    # Book-time proof string (agent quote) may be stored as plain `proof` / `observation`.
    if isinstance(p.get("proof"), str) and str(p.get("proof") or "").strip():
        return _clip_block(str(p["proof"]), limit)
    if isinstance(p.get("observation"), str) and str(p.get("observation") or "").strip():
        return _clip_block(str(p["observation"]), limit)
    proof = p.get("proof") if isinstance(p.get("proof"), dict) else {}
    for key in (
        "stdout_excerpt",
        "body_excerpt",
        "response_body",
        "body_preview",
        "stdout",
        "observation",
        "preview",
        "text",
        "html",
        "content",
    ):
        val = p.get(key) or proof.get(key)
        if isinstance(val, str) and val.strip():
            return _clip_block(val, limit)
    # Nested data blob
    data = p.get("data")
    if isinstance(data, dict):
        for key in ("stdout", "body", "preview", "text"):
            val = data.get(key)
            if isinstance(val, str) and val.strip():
                return _clip_block(val, limit)
    if isinstance(data, str) and data.strip():
        return _clip_block(data, limit)
    return ""


def path_or_url_from_properties(properties: dict[str, Any] | None) -> str:
    p = _props_dict(properties)
    for key in ("path", "path_or_url", "url", "file", "target", "location"):
        val = p.get(key)
        if isinstance(val, str) and val.strip():
            return _clip(val.strip(), 260)
    command = str(p.get("command") or "").strip()
    if command:
        return _clip(f"$ {command}", 200)
    return ""


def evidence_role(properties: dict[str, Any] | None, source_tool: str | None = None) -> str:
    p = _props_dict(properties)
    role = str(p.get("role") or "").strip().lower()
    if role in {"proof", "trace"}:
        return role
    tool = str(source_tool or p.get("source_tool") or "").strip().lower()
    if tool in _TRACE_SOURCE_TOOLS:
        return "trace"
    # Hollow / noise → trace
    excerpt = excerpt_from_properties(p, limit=80)
    if not excerpt and not path_or_url_from_properties(p):
        return "trace"
    return "proof"


def _usefulness_score(
    *,
    evidence_id: str,
    referenced: set[str],
    properties: dict[str, Any],
    source_tool: str | None,
) -> tuple[int, int, int]:
    """Higher is better: (linked, is_proof, has_excerpt)."""
    linked = 1 if evidence_id in referenced else 0
    role = evidence_role(properties, source_tool)
    is_proof = 1 if role == "proof" else 0
    has_ex = 1 if excerpt_from_properties(properties, limit=40) or path_or_url_from_properties(properties) else 0
    return (linked, is_proof, has_ex)


def build_evidence_snippets(
    evidence_rows: list[dict],
    *,
    referenced_ids: set[str] | list[str] | None = None,
    limit: int = DEFAULT_EVIDENCE_SNIPPETS,
    prefer_linked: bool = True,
    prefer_proof: bool = True,
) -> list[dict[str, Any]]:
    """
    Select top-N Case evidence for joining experts.

    Prefers finding-linked + proof-role rows with non-empty excerpt/path.
    """
    ref = {str(x) for x in (referenced_ids or []) if str(x or "").strip()}
    scored: list[tuple[tuple[int, int, int], dict[str, Any]]] = []
    for row in evidence_rows:
        if not isinstance(row, dict):
            continue
        eid = str(row.get("evidence_id") or row.get("id") or "").strip()
        if not eid:
            continue
        props = _props_dict(row.get("properties"))
        source_tool = str(row.get("source_tool") or "")[:80]
        tool_l = source_tool.lower()
        if tool_l in _TRACE_SOURCE_TOOLS and eid not in ref:
            continue
        role = evidence_role(props, source_tool)
        if prefer_proof and role != "proof" and eid not in ref:
            # Still allow linked trace if referenced
            continue
        if prefer_linked and ref and eid not in ref and role != "proof":
            continue
        excerpt = excerpt_from_properties(props)
        path_or_url = path_or_url_from_properties(props)
        if not excerpt and not path_or_url and eid not in ref:
            continue
        kind = str(props.get("kind") or row.get("type") or "tool")[:40]
        snippet: dict[str, Any] = {
            "id": eid[:100],
            "summary": _clip(str(row.get("summary") or ""), 200),
            "source_tool": source_tool,
            "kind": kind,
            "role": role,
        }
        if path_or_url:
            snippet["path_or_url"] = path_or_url
        if excerpt:
            snippet["excerpt"] = excerpt
        # Book-time causality: how the agent obtained the observation (command / HTTP line).
        how = str(props.get("how_captured") or "").strip()
        if not how:
            method = str(props.get("method") or "").strip()
            url = str(props.get("url") or path_or_url or "").strip()
            cmd = str(props.get("command") or "").strip()
            if method and url:
                how = f"{method} {url}"
            elif cmd:
                how = f"$ {cmd[:160]}"
        if how:
            snippet["how_captured"] = _clip(how, 220)
        score = _usefulness_score(
            evidence_id=eid,
            referenced=ref,
            properties=props,
            source_tool=source_tool,
        )
        # If we prefer linked and have refs, demote unlinked slightly via score only
        if prefer_linked and ref and eid not in ref:
            score = (0, score[1], score[2])
        scored.append((score, snippet))

    scored.sort(key=lambda item: item[0], reverse=True)
    out = [s for _, s in scored[: max(1, limit)] if True]
    # If nothing passed filters but we have rows, fall back to linked ids only with raw summary
    if not out and ref:
        for row in evidence_rows:
            if not isinstance(row, dict):
                continue
            eid = str(row.get("evidence_id") or row.get("id") or "").strip()
            if eid not in ref:
                continue
            props = _props_dict(row.get("properties"))
            out.append({
                "id": eid[:100],
                "summary": _clip(str(row.get("summary") or ""), 200),
                "source_tool": str(row.get("source_tool") or "")[:80],
                "kind": str(props.get("kind") or row.get("type") or "tool")[:40],
                "role": evidence_role(props, row.get("source_tool")),
                "path_or_url": path_or_url_from_properties(props) or None,
                "excerpt": excerpt_from_properties(props) or None,
            })
            if len(out) >= limit:
                break
        # drop Nones
        cleaned: list[dict[str, Any]] = []
        for s in out:
            cleaned.append({k: v for k, v in s.items() if v is not None and v != ""})
        return cleaned
    return out


def build_case_context_payload(
    *,
    messages: list[dict],
    findings: list[dict] | None = None,
    evidence_rows: list[dict] | None = None,
    conversation_id: str | None = None,
    thread_limit: int = DEFAULT_THREAD_LIMIT,
    findings_limit: int = DEFAULT_FINDINGS_LIMIT,
    evidence_limit: int = DEFAULT_EVIDENCE_SNIPPETS,
) -> dict[str, Any]:
    """Pure builder for tests and dispatch."""
    thread = build_thread_from_messages(messages, limit=thread_limit)
    findings_list = findings or []
    findings_summary = build_findings_summary(findings_list, limit=findings_limit)
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
                    "evidence_ids": [],
                })
        findings_summary = findings_summary[:findings_limit]

    referenced: set[str] = set()
    for f in findings_list:
        for eid in (f.get("evidence_ids") or []) if isinstance(f, dict) else []:
            if eid:
                referenced.add(str(eid))
    for f in findings_summary:
        for eid in f.get("evidence_ids") or []:
            if eid:
                referenced.add(str(eid))

    evidence_snippets = build_evidence_snippets(
        evidence_rows or [],
        referenced_ids=referenced,
        limit=evidence_limit,
        prefer_linked=True,
        prefer_proof=True,
    )
    hints = extract_artifact_hints(thread, findings_list)
    # Surface paths from snippets as hints too
    for sn in evidence_snippets:
        p = sn.get("path_or_url")
        if p and str(p) not in hints and not str(p).startswith("$ "):
            hints.append(str(p))
        if len(hints) >= 16:
            break

    return {
        "version": 2,
        "conversation_id": conversation_id,
        "thread": thread,
        "findings_summary": findings_summary,
        "evidence_snippets": evidence_snippets,
        "artifact_hints": hints[:16],
        "note": (
            "Same case work-group. findings_summary includes this Case and prior ledger "
            "findings on Case assets. Open priors are a re-verify workstream: re-run minimal "
            "proof, then finding(confirm) with fresh tool-output (platform rediscovery merge; "
            "do not invent a second row for the same asset+path/module). Interleave with "
            "untested surface — do not skip priors just because they are already listed. "
            "Honest counts: rediscovery N = confirms this session only; 新发现 only for new "
            "ledger identities (not same-path merge). Never claim 全部重新验证 from list length. "
            "Use paths/excerpts to continue; large files are not fully inlined."
        ),
    }


async def load_case_context_for_conversation(
    db,
    conversation_id,
    *,
    user_id=None,
    thread_limit: int = DEFAULT_THREAD_LIMIT,
    findings_limit: int = DEFAULT_FINDINGS_LIMIT,
    evidence_limit: int = DEFAULT_EVIDENCE_SNIPPETS,
) -> dict[str, Any]:
    """Load messages + vulns + evidence from DB and build case_context."""
    import uuid as uuid_mod

    from sqlalchemy import select

    from app.models.evidence import Evidence
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
        from app.models.asset import Asset
        from app.services.finding_dedupe import discovery_count, rediscovery_count

        uid = None
        if user_id is not None:
            uid = user_id if isinstance(user_id, uuid_mod.UUID) else uuid_mod.UUID(str(user_id))

        # This Case's findings + prior ledger findings on assets used by this Case
        # so joining experts see "already booked" surface before re-booking.
        asset_ids: list = []
        try:
            aq = select(Asset.id).where(Asset.conversation_id == cid)
            if uid is not None:
                aq = aq.where(Asset.user_id == uid)
            asset_ids = list((await db.execute(aq.limit(40))).scalars().all())
        except Exception:
            asset_ids = []

        from sqlalchemy import or_

        conds = [Vulnerability.conversation_id == cid]
        if asset_ids:
            conds.append(Vulnerability.asset_id.in_(asset_ids))
        q = select(Vulnerability).where(or_(*conds))
        if uid is not None:
            q = q.where(Vulnerability.user_id == uid)
        q = q.order_by(Vulnerability.updated_at.desc()).limit(max(findings_limit * 3, 40))
        vulns = (await db.execute(q)).scalars().all()
        seen: set[str] = set()
        for v in vulns:
            vid = str(getattr(v, "id", "") or "")
            if vid and vid in seen:
                continue
            if vid:
                seen.add(vid)
            hist = getattr(v, "history", None)
            rcount = rediscovery_count(hist)
            findings.append({
                "id": vid,
                "title": getattr(v, "title", None) or "Untitled",
                "severity": getattr(v, "severity", None) or "medium",
                "status": getattr(v, "status", None) or "",
                "location": getattr(v, "location", None)
                or getattr(v, "affected_asset", None)
                or getattr(v, "url", None)
                or getattr(v, "poc", None)
                or "",
                "description": getattr(v, "description", None) or "",
                "poc": getattr(v, "poc", None) or "",
                "evidence_ids": list(getattr(v, "evidence_ids", None) or []),
                "asset_id": str(v.asset_id) if getattr(v, "asset_id", None) else None,
                "port": str(v.port) if getattr(v, "port", None) else None,
                "first_seen_at": (
                    v.first_seen_at.isoformat()
                    if getattr(v, "first_seen_at", None)
                    else (v.discovered_at.isoformat() if getattr(v, "discovered_at", None) else None)
                ),
                "rediscovery_count": rcount,
                "multiple_discoveries": rcount > 0,
                "discovery_count": discovery_count(hist),
            })
            if len(findings) >= findings_limit * 2:
                break
    except Exception:
        findings = []

    evidence_rows: list[dict] = []
    try:
        eq = select(Evidence).where(Evidence.conversation_id == cid)
        if user_id is not None:
            uid = user_id if isinstance(user_id, uuid_mod.UUID) else uuid_mod.UUID(str(user_id))
            eq = eq.where(Evidence.user_id == uid)
        # Pull a wider window; snippet builder ranks/filter
        eq = eq.order_by(Evidence.created_at.desc()).limit(max(80, evidence_limit * 6))
        for e in (await db.execute(eq)).scalars().all():
            evidence_rows.append({
                "evidence_id": e.evidence_id,
                "id": e.evidence_id,
                "summary": e.summary or "",
                "source_tool": e.source_tool or "",
                "type": e.type or "tool_output",
                "properties": e.properties if isinstance(e.properties, dict) else {},
                "created_at": e.created_at.isoformat() if e.created_at else None,
            })
    except Exception:
        evidence_rows = []

    return build_case_context_payload(
        messages=messages,
        findings=findings,
        evidence_rows=evidence_rows,
        conversation_id=str(cid),
        thread_limit=thread_limit,
        findings_limit=findings_limit,
        evidence_limit=evidence_limit,
    )
