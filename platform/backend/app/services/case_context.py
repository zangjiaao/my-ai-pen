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
# Visible group speech only — thinking / tools / status / finding cards stay out.
_SPEECH_INCLUDE_TYPES = frozenset({
    "text",
    "decision",
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

# Thin Scope intel (cross-Case Host memory) — caps keep injection small.
SCOPE_INTEL_MAX_HOSTS = 5
SCOPE_INTEL_PRIOR_INDEX = 24
SCOPE_INTEL_PRIOR_FETCH = 80
SCOPE_INTEL_HIGH_SAMPLE = SCOPE_INTEL_PRIOR_INDEX  # alias — catalog, not high-only
SCOPE_INTEL_PATH_SAMPLE = 16
SCOPE_INTEL_URL_SAMPLE = 12
SCOPE_INTEL_SERVICE_SAMPLE = 8
SCOPE_INTEL_SUMMARY_CHARS = 140
COVERAGE_SAMPLE_CAP = 5

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


def _normalize_finding_severity(value: object) -> str | None:
    """Spec #139 D1 / NC-Severity: fail closed — no silent medium default."""
    severity = str(value or "").strip().lower()
    if not severity:
        return None
    if severity in {"critical", "high", "medium", "low", "info"}:
        return severity
    return None


def _clip_block(text: str, limit: int = DEFAULT_EXCERPT_CHARS) -> str:
    t = str(text or "").strip()
    if len(t) <= limit:
        return t
    return t[: max(0, limit - 20)] + "…(truncated)"


_SEV_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}


def prior_index_module_key(location: object) -> str:
    """Module-level path for the prior catalog (display fold, not ledger identity)."""
    from app.services.finding_dedupe import location_resource_key

    path = location_resource_key(location)
    if not path:
        return ""
    parts = [p for p in path.split("/") if p]
    if not parts:
        return path
    if parts[0] in {"vulnerabilities", "hackable", "dvwa", "api", "rest", "external"}:
        return "/" + "/".join(parts[:2] if len(parts) >= 2 else parts[:1])
    return "/" + parts[0]


def collapse_prior_index(
    rows: list[dict[str, Any]],
    *,
    limit: int = SCOPE_INTEL_PRIOR_INDEX,
) -> list[dict[str, Any]]:
    """Fold duplicate rediscoveries into one module row (path + class).

    First row in each bucket wins as the representative (caller should pass
    severity-then-recency order). Not a Finding identity merge.
    """
    buckets: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        loc = str(raw.get("location") or "")
        mod = prior_index_module_key(loc) or loc.strip() or str(raw.get("title") or "")[:48]
        key = f"{raw.get('asset_id') or ''}|{raw.get('port') or ''}|{mod}"
        if key not in buckets:
            item = {k: v for k, v in raw.items() if v is not None and v != ""}
            item["location"] = mod or loc
            item["discoveries"] = 1
            buckets[key] = item
            order.append(key)
            continue
        buckets[key]["discoveries"] = int(buckets[key].get("discoveries") or 1) + 1
    out = [buckets[k] for k in order]
    out.sort(
        key=lambda r: (
            _SEV_RANK.get(str(r.get("severity") or "").lower(), 5),
            -int(r.get("discoveries") or 1),
        )
    )
    return out[: max(1, int(limit))]


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


def _line_identity(msg: dict, content: dict) -> dict[str, str]:
    mid = str(msg.get("id") or "").strip()
    eid = str(content.get("expert_id") or content.get("expertId") or "").strip()
    sid = str(
        content.get("session_id")
        or content.get("sessionId")
        or content.get("agent_session_id")
        or msg.get("session_id")
        or msg.get("sessionId")
        or ""
    ).strip()
    out: dict[str, str] = {}
    if mid:
        out["id"] = mid[:80]
    if eid:
        out["expert_id"] = eid[:80]
    if sid:
        out["session_id"] = sid[:128]
    return out


def _line_from_message(msg: dict) -> dict[str, str] | None:
    """Turn a stored message summary into one thread line, or None to skip."""
    role = str(msg.get("role") or "")
    msg_type = str(msg.get("msg_type") or msg.get("type") or "")
    content = msg.get("content") if isinstance(msg.get("content"), dict) else {}
    if not isinstance(content, dict):
        content = {}
    ident = _line_identity(msg, content)

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
            **ident,
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
            **ident,
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
            **ident,
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


def build_speech_from_messages(
    messages: list[dict],
    *,
    limit: int = DEFAULT_THREAD_LIMIT,
    total_chars: int = DEFAULT_TOTAL_CHARS,
) -> list[dict[str, str]]:
    """Append-only Case group speech (visible talk only), oldest→newest."""
    lines: list[dict[str, str]] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        line = _line_from_message(msg)
        if not line:
            continue
        kind = str(line.get("kind") or "")
        role = str(msg.get("role") or "")
        if kind not in _SPEECH_INCLUDE_TYPES and role != "user":
            continue
        if kind in {"vuln_found", "vuln_card", "status", "tool"}:
            continue
        if not str(line.get("text") or "").strip():
            continue
        if not str(line.get("id") or "").strip():
            # Cursor needs a stable id; skip unidentifiable rows.
            continue
        lines.append(line)
    if limit > 0 and len(lines) > limit:
        lines = lines[-limit:]
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
        severity = _normalize_finding_severity(f.get("severity"))
        row: dict[str, Any] = {
            "id": str(f.get("id") or f.get("finding_id") or f.get("vulnerability_id") or "")[:80],
            "title": _clip(title, 200),
            "severity": severity or "",
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


# Product Case/Session artifact identity — not host mount/drive letters.
_ARTIFACT_PATH_NEEDLES = (
    "HANDOFF",
    "source_dump",
    "workspace/",
    "evidence/",
    "findings/",
    ".md",
    "notes/",
)
_ARTIFACT_PATH_EXTS = (
    ".md",
    ".py",
    ".js",
    ".ts",
    ".json",
    ".txt",
    ".log",
    ".html",
    ".java",
    ".php",
    ".c",
    ".go",
)


def _looks_like_artifact_path(token: str) -> bool:
    """True when the token is path- or filename-shaped — not a prose word."""
    t = str(token or "").strip("`'\"()[].,;:")
    if len(t) < 5 or len(t) >= 260:
        return False
    if "/" in t or "\\" in t:
        return True
    lower = t.lower()
    return any(lower.endswith(ext) for ext in _ARTIFACT_PATH_EXTS)


def extract_artifact_hints(thread: list[dict[str, str]], findings: list[dict]) -> list[str]:
    """Light path/id hints from thread text (no full file bodies).

    Needles are Case/Session relative identity (notes/, workspace/, source_dump,
    filename HANDOFF, .md, …) — not host mounts (/mnt/, D:\\). A token is kept
    only when it is path-shaped; a bare word like status “Handoff” is not an artifact.
    """
    hints: list[str] = []
    seen: set[str] = set()
    for line in thread:
        text = line.get("text") or ""
        if not any(n.lower() in text.lower() for n in _ARTIFACT_PATH_NEEDLES):
            continue
        for token in text.replace(",", " ").split():
            t = token.strip("`'\"()[].,;:")
            if not _looks_like_artifact_path(t):
                continue
            if not any(n.lower() in t.lower() for n in _ARTIFACT_PATH_NEEDLES):
                continue
            if t not in seen:
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


def extract_hosts_from_task(task: dict | None) -> list[str]:
    """Pull normalized host keys from structured task target/scope (no NLP invent)."""
    from app.services.asset_ledger import normalize_address

    if not isinstance(task, dict):
        return []
    hosts: list[str] = []
    seen: set[str] = set()

    def _add(raw: object) -> None:
        h = normalize_address(raw)
        if not h or h in seen:
            return
        seen.add(h)
        hosts.append(h)

    target = task.get("target")
    if isinstance(target, dict):
        _add(target.get("value") or target.get("url") or target.get("host") or target.get("address"))
    elif isinstance(target, str):
        _add(target)

    scope = task.get("scope")
    if isinstance(scope, dict):
        for key in ("allow", "hosts", "targets"):
            arr = scope.get(key)
            if isinstance(arr, list):
                for item in arr:
                    if isinstance(item, dict):
                        _add(item.get("value") or item.get("url") or item.get("host") or item.get("address"))
                    else:
                        _add(item)
    elif isinstance(scope, list):
        for item in scope:
            _add(item)

    for key in ("url", "host", "address", "target_url"):
        if task.get(key) is not None:
            _add(task.get(key))
    return hosts


def _iter_task_scope_items(task: dict | None):
    """Structured target / scope entries only — no free-text scan."""
    if not isinstance(task, dict):
        return
    yield task.get("target")
    scope = task.get("scope")
    if isinstance(scope, dict):
        for key in ("allow", "hosts", "targets"):
            arr = scope.get(key)
            if isinstance(arr, list):
                yield from arr
    elif isinstance(scope, list):
        yield from scope
    for key in ("url", "host", "address", "target_url"):
        if task.get(key) is not None:
            yield task.get(key)


def task_scope_blobs(task: dict | None) -> list[str]:
    blobs: list[str] = []
    seen: set[str] = set()

    def _add(raw: object) -> None:
        if raw is None:
            return
        if isinstance(raw, dict):
            for k in ("value", "url", "host", "address"):
                if raw.get(k) is not None:
                    _add(raw.get(k))
            return
        s = str(raw).strip()
        if s and s not in seen:
            seen.add(s)
            blobs.append(s)

    for item in _iter_task_scope_items(task):
        _add(item)
    return blobs


def extract_scope_ports_from_task(task: dict | None) -> dict[str, list[str]]:
    """Host → explicit Scope ports from structured target/scope (no implicit 80/443)."""
    from app.services.asset_ledger import extract_ports_for_host, normalize_address, normalize_port

    hosts = extract_hosts_from_task(task)
    blobs = task_scope_blobs(task)
    out: dict[str, list[str]] = {h: [] for h in hosts}

    def _add_port(host: str, port: str | None) -> None:
        if not host or not port:
            return
        bucket = out.setdefault(host, [])
        if port not in bucket:
            bucket.append(port)

    for host in hosts:
        for port in extract_ports_for_host(host, *blobs):
            _add_port(host, port)

    for item in _iter_task_scope_items(task):
        if not isinstance(item, dict):
            continue
        host = normalize_address(
            item.get("value") or item.get("url") or item.get("host") or item.get("address")
        )
        _add_port(host, normalize_port(item.get("port")))
    return out


def task_scope_asset_ids(task: dict | None) -> list[str]:
    """Explicit Host ids from structured scope.asset_ids (user-authorized). Never NLP."""
    import uuid as uuid_mod

    if not isinstance(task, dict):
        return []
    scope = task.get("scope")
    raw = None
    if isinstance(scope, dict):
        raw = scope.get("asset_ids")
    if not isinstance(raw, list):
        raw = task.get("asset_ids") if isinstance(task.get("asset_ids"), list) else None
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        s = str(item or "").strip()
        if not s or s in seen:
            continue
        try:
            uuid_mod.UUID(s)
        except ValueError:
            continue
        seen.add(s)
        out.append(s)
    return out


def unique_identity_asset_ids(
    host_keys: list[str],
    catalog: list[tuple[str, set[str]]],
) -> list[str]:
    """Host keys that uniquely match one catalog Host. Ambiguous keys add no one."""
    included: list[str] = []
    seen: set[str] = set()
    for key in host_keys:
        k = str(key or "").strip()
        if not k:
            continue
        hits = [aid for aid, identities in catalog if k in identities]
        if len(hits) != 1:
            continue
        aid = str(hits[0])
        if aid in seen:
            continue
        seen.add(aid)
        included.append(aid)
    return included


def surface_origin_host_keys(conv_context: dict | None) -> list[str]:
    """Normalized hosts from this-Case Surface origin_key (unique-match input)."""
    from app.services.asset_ledger import normalize_address
    from app.services.surface_inventory import host_from_origin_key

    if not isinstance(conv_context, dict):
        return []
    sl = conv_context.get("surface_ledger")
    surfaces = sl.get("surfaces") if isinstance(sl, dict) else None
    if not isinstance(surfaces, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for row in surfaces:
        if not isinstance(row, dict):
            continue
        raw = row.get("origin_key") or row.get("location") or ""
        host = normalize_address(host_from_origin_key(str(raw or ""))) or ""
        if not host or host in seen:
            continue
        seen.add(host)
        out.append(host)
    return out


def case_intel_port_scope(
    assets: list[tuple[str, str]],
    task: dict | None,
    identities: dict[str, set[str]] | None = None,
) -> dict[str, set[str] | None]:
    """asset_id → named Scope ports, or None when the Host is in Scope with no port.

    None = whole Host (include sibling Service intel).
    set = those Services plus Host-level (empty port) only.
    identities: optional asset_id → primary∪aliases so allow=localhost hits
    a Host whose primary is host.docker.internal.
    """
    from app.services.asset_ledger import normalize_address

    host_ports = extract_scope_ports_from_task(task)
    out: dict[str, set[str] | None] = {}
    for aid, address in assets:
        key = str(aid or "").strip()
        if not key:
            continue
        addr = normalize_address(address) or str(address or "").strip()
        keys: set[str] = set(identities.get(key) or []) if identities else set()
        if addr:
            keys.add(addr)
        if not keys:
            out[key] = None
            continue
        named: set[str] = set()
        whole_host = False
        matched = False
        for k in keys:
            if k not in host_ports:
                continue
            matched = True
            ports = host_ports.get(k) or []
            if not ports:
                whole_host = True
            else:
                named.update(str(p) for p in ports if p)
        if whole_host or not matched:
            # Authorized by Host id / unique Surface owner, or allow names Host with no port.
            out[key] = None
        else:
            out[key] = named
    return out


def vuln_scope_sql_clause(port_scope: dict[str, set[str] | None]):
    """Vulnerability hang filter: same law as Intel (Host-level + Scope Service ports)."""
    import uuid as uuid_mod

    from sqlalchemy import and_, false, or_

    from app.models.vulnerability import Vulnerability
    from app.services.owner_intel import intel_port_key

    parts: list[Any] = []
    host_level = or_(Vulnerability.port.is_(None), Vulnerability.port == "")
    for aid_raw, ports in (port_scope or {}).items():
        try:
            aid = uuid_mod.UUID(str(aid_raw))
        except ValueError:
            continue
        if ports is None:
            parts.append(Vulnerability.asset_id == aid)
            continue
        allowed = sorted({p for p in (intel_port_key(x) for x in ports) if p})
        if allowed:
            parts.append(
                and_(
                    Vulnerability.asset_id == aid,
                    or_(host_level, Vulnerability.port.in_(allowed)),
                )
            )
        else:
            parts.append(and_(Vulnerability.asset_id == aid, host_level))
    return or_(*parts) if parts else false()


def coverage_sketch_from_surfaces(surfaces: list[Any] | None) -> dict[str, Any]:
    """Capped coverage counts + untested samples from Case surface_ledger rows."""
    rows = [s for s in (surfaces or []) if isinstance(s, dict)]
    tested = untested = skipped = new = 0
    samples: list[str] = []
    for s in rows:
        cov = str(s.get("coverage") or "untested").strip().lower()
        if cov == "tested":
            tested += 1
        elif cov == "skipped":
            skipped += 1
        else:
            untested += 1
            loc = str(s.get("path_key") or s.get("location") or s.get("path") or "").strip()
            if loc and loc not in samples and len(samples) < COVERAGE_SAMPLE_CAP:
                samples.append(loc[:160])
        status = str(s.get("status") or "").strip().lower()
        if cov not in ("tested", "skipped") and status in ("seen", "new"):
            new += 1
    out: dict[str, Any] = {
        "new": new,
        "untested": untested,
        "tested": tested,
        "skipped": skipped,
    }
    if samples:
        out["untested_samples"] = samples
    return out


def build_scope_intel_card(
    *,
    hosts: list[dict[str, Any]],
    prior_counts: dict[str, Any] | None = None,
    high_sample: list[dict[str, Any]] | None = None,
    surface_paths: list[str] | None = None,
    sample_urls: list[str] | None = None,
    this_case_surface_n: int | None = None,
    coverage: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Pure thin Scope intel card for injection (no PoC bodies)."""
    if not hosts and not prior_counts and not high_sample and not surface_paths and not coverage:
        return None
    card: dict[str, Any] = {
        "version": 1,
        "discipline": (
            "Scope Hosts already on the owner ledger — thin memory only. "
            "Primary work remains attack-surface expansion and NEW ledger identities. "
            "Open priors are an index (title + one-line summary), not a start-of-turn work queue. "
            "Do not host-wide dump platform_list_vulnerabilities at kickoff. "
            "When you approach a path/module, look up that row with finding(get). "
            "Same path/module merges (再次发现). Ledger presence ≠ skip and ≠ must-finish. "
            "Honest counts: 重新验证 N = confirms this session only."
        ),
    }
    if hosts:
        card["hosts"] = hosts[:SCOPE_INTEL_MAX_HOSTS]
    if isinstance(prior_counts, dict) and prior_counts:
        card["prior_findings"] = prior_counts
    if high_sample:
        card["high_priority_sample"] = high_sample[:SCOPE_INTEL_HIGH_SAMPLE]
    surface: dict[str, Any] = {}
    if surface_paths:
        surface["known_paths"] = surface_paths[:SCOPE_INTEL_PATH_SAMPLE]
    if sample_urls:
        surface["sample_urls"] = sample_urls[:SCOPE_INTEL_URL_SAMPLE]
    if this_case_surface_n is not None:
        surface["this_case_surface_count"] = int(this_case_surface_n)
    if isinstance(coverage, dict) and coverage:
        for key in ("new", "untested", "tested", "skipped"):
            if key in coverage and coverage[key] is not None:
                surface[key] = int(coverage[key])
        samples = coverage.get("untested_samples")
        if isinstance(samples, list) and samples:
            surface["untested_samples"] = [str(x)[:160] for x in samples[:COVERAGE_SAMPLE_CAP] if str(x).strip()]
    if surface:
        card["surface_sketch"] = surface
    return card


def booking_scope_from_assign(
    conv_context: dict | None,
    *,
    expert_id: str | None,
) -> tuple[str | None, str | None]:
    """Resolve this Participant Session's wrap-count scope from the Case roster."""
    eid = str(expert_id or "").strip() or None
    sid = None
    if eid:
        try:
            from app.services.case_participants import participants_map

            for row in participants_map(conv_context).values():
                if str(row.get("expert_id") or "").strip() == eid:
                    sid = str(row.get("session_instance_id") or "").strip() or None
                    break
        except Exception:
            sid = None
    return sid, eid


def session_booking_from_messages(
    messages: list[dict] | None,
    *,
    session_id: str | None = None,
    expert_id: str | None = None,
) -> tuple[int, int]:
    """Count this Participant Session's confirms vs new ledger identities.

    New identity is platform ``created is True`` only. Persist errors are skipped.
    Scope is required: ``session_id`` (pi Agent.sessionId) preferred, else ``expert_id``.
    Unscoped calls return (0, 0) so wrap never mixes another Expert/Session.
    """
    want_sid = str(session_id or "").strip()
    want_eid = str(expert_id or "").strip()
    confirms = 0
    new_identities = 0
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        msg_type = str(m.get("msg_type") or m.get("type") or "").lower()
        content = m.get("content") if isinstance(m.get("content"), dict) else {}
        if not isinstance(content, dict):
            content = {}
        if msg_type not in {"vuln_found", "vuln_card"}:
            continue
        if str(content.get("type") or "").lower() == "vuln_found_error":
            continue
        msg_sid = str(
            content.get("session_id")
            or content.get("agent_session_id")
            or m.get("session_id")
            or ""
        ).strip()
        msg_eid = str(content.get("expert_id") or m.get("expert_id") or "").strip()
        if want_sid:
            if msg_sid != want_sid:
                continue
        elif want_eid:
            if msg_eid != want_eid:
                continue
        else:
            continue
        confirms += 1
        if content.get("created") is True:
            new_identities += 1
    return confirms, new_identities


def build_case_context_payload(
    *,
    messages: list[dict],
    findings: list[dict] | None = None,
    evidence_rows: list[dict] | None = None,
    conversation_id: str | None = None,
    thread_limit: int = DEFAULT_THREAD_LIMIT,
    findings_limit: int = DEFAULT_FINDINGS_LIMIT,
    evidence_limit: int = DEFAULT_EVIDENCE_SNIPPETS,
    workset: dict | None = None,
    scope_intel: dict | None = None,
    intel_summary: list[dict] | None = None,
    asset_intake: dict | None = None,
    booking_session_id: str | None = None,
    booking_expert_id: str | None = None,
) -> dict[str, Any]:
    """Pure builder for tests and dispatch.

    Spec #311: when workset is provided, attach a thin next_work brief (refs only),
    not a fat dump of every Case field every turn.

    scope_intel: thin cross-Case Host memory (counts + samples + surface sketch) —
    never full PoC dumps.
    """
    thread = build_thread_from_messages(messages, limit=thread_limit)
    speech = build_speech_from_messages(messages, limit=thread_limit)
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

    payload: dict[str, Any] = {
        "version": 2,
        "conversation_id": conversation_id,
        "thread": thread,
        "speech": speech,
        "findings_summary": findings_summary,
        "evidence_snippets": evidence_snippets,
        "artifact_hints": hints[:16],
        "note": (
            "Same case work-group. findings_summary = this Case's booked findings (board). "
            "scope_intel (when present) = thin owner-ledger memory for Scope Hosts "
            "(counts + title/summary index on Scope ports, surface sketch) — not a work queue; "
            "intel_summary = living notebook clues on Scope Hosts (host-level) and "
            "matching Scope Service ports (id+summary+hang; sibling ports on the same "
            "Host are omitted; not Findings; summary is enough to act — recorded valid "
            "creds are the login path; get body via fact(op=get, id=…)). "
            "Primary work: expand untested surface and NEW ledger identities. "
            "Open priors: index only — look up when approaching that surface "
            "(rediscovery merge; same asset+path/module ≠ second row). "
            "Honest counts: 重新验证 N = confirms this session only; 新发现 only for new "
            "identities. Never claim 全部重新验证 from list length. "
            "Large files are not fully inlined."
        ),
    }
    session_confirms, session_new_identities = session_booking_from_messages(
        messages,
        session_id=booking_session_id,
        expert_id=booking_expert_id,
    )
    payload["session_confirms"] = session_confirms
    payload["session_new_identities"] = session_new_identities
    if isinstance(scope_intel, dict) and scope_intel:
        payload["scope_intel"] = scope_intel
    if isinstance(intel_summary, list) and intel_summary:
        from app.services.owner_intel import inject_window_size

        payload["intel_summary"] = intel_summary[: inject_window_size()]
    # Spec #311: thin Workset brief at assign boundary (not every mid-turn).
    if isinstance(workset, dict) and (workset.get("items") or workset.get("goal")):
        try:
            from app.services.case_workset import thin_handoff_brief

            payload["next_work"] = thin_handoff_brief(workset, boundary="case_assign")
        except Exception:
            pass
    if isinstance(asset_intake, dict) and str(asset_intake.get("mode") or "") == "enroll_group":
        nw = payload.get("next_work") if isinstance(payload.get("next_work"), dict) else {}
        nw["asset_intake"] = {
            "mode": "enroll_group",
            "group_id": asset_intake.get("group_id"),
            "group_name": asset_intake.get("group_name"),
            "set_by": asset_intake.get("set_by"),
        }
        payload["next_work"] = nw
    # Spec #312: mark whether transcript already has a legal next_steps card (soft-gate input).
    try:
        from app.services.choice_card import messages_have_legal_next_steps_choice

        answered: set[str] = set()
        for m in messages:
            if not isinstance(m, dict):
                continue
            if str(m.get("msg_type") or "").lower() != "decision":
                continue
            c = m.get("content") if isinstance(m.get("content"), dict) else {}
            rid = str(c.get("request_id") or "").strip()
            if rid:
                answered.add(rid)
        has_legal = messages_have_legal_next_steps_choice(messages, answered_request_ids=answered)
        if isinstance(payload.get("next_work"), dict):
            payload["next_work"]["has_legal_choice_card"] = has_legal
        payload["_has_legal_next_steps_choice"] = has_legal
    except Exception:
        pass
    return payload


async def _load_scope_intel(
    db,
    *,
    cid,
    uid,
    conv_context: dict | None,
) -> dict[str, Any] | None:
    """Thin cross-Case Host memory from structured task target/scope + sticky assets."""
    import uuid as uuid_mod

    from sqlalchemy import func, or_, select

    from app.models.asset import Asset
    from app.models.vulnerability import Vulnerability
    from app.services.asset_ledger import extract_services, normalize_address

    task = {}
    if isinstance(conv_context, dict):
        raw_task = conv_context.get("task")
        if isinstance(raw_task, dict):
            task = raw_task
    host_keys = extract_hosts_from_task(task)

    # Same Case Host membership as intel_summary / Findings 线索.
    assets: list = []
    try:
        rows = await _scope_asset_rows(db, cid=cid, uid=uid, conv_context=conv_context)
        ids = []
        for aid, _addr, _idents in rows[:SCOPE_INTEL_MAX_HOSTS]:
            try:
                ids.append(uuid_mod.UUID(str(aid)))
            except ValueError:
                continue
        if ids:
            fetched = {
                a.id: a
                for a in (await db.execute(select(Asset).where(Asset.id.in_(ids)))).scalars().all()
            }
            for aid in ids:
                if aid in fetched:
                    assets.append(fetched[aid])
    except Exception:
        assets = []

    if not assets and not host_keys and not task_scope_asset_ids(task):
        return None

    # Official services for ports/notes
    official: dict = {}
    if assets:
        try:
            from app.services.owner_services import load_official_services

            official = await load_official_services(db, [a.id for a in assets])
        except Exception:
            official = {}

    host_rows: list[dict[str, Any]] = []
    sample_urls: list[str] = []
    url_seen: set[str] = set()
    for a in assets[:SCOPE_INTEL_MAX_HOSTS]:
        props = a.properties if isinstance(a.properties, dict) else {}
        svcs = official.get(a.id) if official else None
        if not svcs:
            svcs = extract_services(props)
        svc_brief: list[dict[str, Any]] = []
        ports: list[str] = []
        for s in (svcs or [])[:SCOPE_INTEL_SERVICE_SAMPLE]:
            if not isinstance(s, dict):
                continue
            port = str(s.get("port") or "").strip()
            name = str(s.get("name") or s.get("product") or "").strip()
            note = str(s.get("note") or "").strip()
            if port and port not in ports:
                ports.append(port)
            row: dict[str, Any] = {}
            if port:
                row["port"] = port
            if name:
                row["name"] = name[:40]
            if note:
                row["note"] = note[:60]
            if row:
                svc_brief.append(row)
        # Also open_ports from properties
        for p in props.get("open_ports") or []:
            ps = str(p).strip()
            if ps and ps not in ports:
                ports.append(ps)
        for u in props.get("urls") or []:
            us = str(u or "").strip()
            if not us or us in url_seen:
                continue
            # Prefer short path-ish samples for surface sketch
            url_seen.add(us)
            sample_urls.append(us[:200])
            if len(sample_urls) >= SCOPE_INTEL_URL_SAMPLE:
                break
        host_rows.append({
            "id": str(a.id),
            "address": str(a.address or ""),
            "name": str(a.name or a.address or "")[:80],
            "tags": list(a.tags or [])[:8],
            "ports": ports[:16],
            "services": svc_brief,
            "on_ledger": True,
        })

    # Unmatched scope hosts (target named but not on ledger yet)
    ledger_addrs = {normalize_address(h.get("address")) for h in host_rows}
    for hk in host_keys:
        if hk not in ledger_addrs:
            host_rows.append({
                "address": hk,
                "on_ledger": False,
                "note": "not on owner ledger yet — do not invent Host rows without user request",
            })

    asset_ids = [a.id for a in assets]
    port_scope = case_intel_port_scope(
        [(str(a.id), str(a.address or "")) for a in assets],
        task,
    )
    scope_clause = vuln_scope_sql_clause(port_scope) if port_scope else None
    prior_counts: dict[str, Any] = {}
    high_sample: list[dict[str, Any]] = []
    surface_paths: list[str] = []
    if asset_ids and uid is not None:
        try:
            from sqlalchemy import case as sql_case

            owner_ok = or_(Vulnerability.user_id == uid, Vulnerability.user_id.is_(None))
            base = [Vulnerability.asset_id.in_(asset_ids), owner_ok]
            if scope_clause is not None:
                base.append(scope_clause)

            total = int(
                (
                    await db.execute(
                        select(func.count()).select_from(Vulnerability).where(*base)
                    )
                ).scalar_one()
                or 0
            )
            by_sev: dict[str, int] = {}
            sev_rows = (
                await db.execute(
                    select(Vulnerability.severity, func.count())
                    .where(*base)
                    .group_by(Vulnerability.severity)
                )
            ).all()
            for sev, cnt in sev_rows:
                key = _normalize_finding_severity(sev) or str(sev or "unknown").lower()
                by_sev[key] = by_sev.get(key, 0) + int(cnt or 0)
            open_n = int(
                (
                    await db.execute(
                        select(func.count())
                        .select_from(Vulnerability)
                        .where(
                            *base,
                            func.lower(func.coalesce(Vulnerability.status, "")).in_(
                                [
                                    "open",
                                    "to_fix",
                                    "unverified",
                                    "retest",
                                    "needs_reverify",
                                    "candidate",
                                ]
                            ),
                        )
                    )
                ).scalar_one()
                or 0
            )
            prior_counts = {
                "total": total,
                "open_or_retest": open_n,
                "by_severity": by_sev,
            }

            # Title + one-line summary index on Scope ports (no PoC). Not a work queue.
            sev_rank = sql_case(
                (func.lower(func.coalesce(Vulnerability.severity, "")) == "critical", 0),
                (func.lower(func.coalesce(Vulnerability.severity, "")) == "high", 1),
                (func.lower(func.coalesce(Vulnerability.severity, "")) == "medium", 2),
                (func.lower(func.coalesce(Vulnerability.severity, "")) == "low", 3),
                else_=4,
            )
            high_q = (
                select(Vulnerability)
                .where(*base)
                .order_by(sev_rank, Vulnerability.updated_at.desc())
                .limit(SCOPE_INTEL_PRIOR_FETCH)
            )
            fetched: list[dict[str, Any]] = []
            for v in (await db.execute(high_q)).scalars().all():
                desc = " ".join(str(getattr(v, "description", None) or "").split())
                fetched.append({
                    "id": str(v.id),
                    "severity": _normalize_finding_severity(v.severity) or str(v.severity or ""),
                    "title": _clip(str(v.title or "Untitled"), 120),
                    "location": _clip(
                        str(
                            getattr(v, "location_key", None)
                            or getattr(v, "port", None)
                            or ""
                        ),
                        120,
                    ),
                    "port": str(v.port) if getattr(v, "port", None) else None,
                    "status": str(v.status or "")[:32],
                    "asset_id": str(v.asset_id) if v.asset_id else None,
                    "vuln_type": getattr(v, "vuln_type", None),
                    "summary": _clip(desc, SCOPE_INTEL_SUMMARY_CHARS) if desc else None,
                })
            high_sample = collapse_prior_index(fetched, limit=SCOPE_INTEL_PRIOR_INDEX)

            # Distinct known paths from prior findings (surface sketch)
            path_q = (
                select(Vulnerability.location_key)
                .where(
                    *base,
                    Vulnerability.location_key.isnot(None),
                    Vulnerability.location_key != "",
                )
                .order_by(Vulnerability.updated_at.desc())
                .limit(SCOPE_INTEL_PATH_SAMPLE * 3)
            )
            path_seen: set[str] = set()
            for (lk,) in (await db.execute(path_q)).all():
                p = str(lk or "").strip()
                if not p or p in path_seen:
                    continue
                path_seen.add(p)
                surface_paths.append(p[:160])
                if len(surface_paths) >= SCOPE_INTEL_PATH_SAMPLE:
                    break
        except Exception:
            prior_counts = {}
            high_sample = []
            surface_paths = []

    this_case_surface_n = None
    coverage = None
    if isinstance(conv_context, dict):
        sl = conv_context.get("surface_ledger")
        if isinstance(sl, dict) and isinstance(sl.get("surfaces"), list):
            this_case_surface_n = len(sl["surfaces"])
            coverage = coverage_sketch_from_surfaces(sl["surfaces"])
            # Mix a few this-Case surface paths into sketch if we still have room
            for s in sl["surfaces"][:8]:
                if not isinstance(s, dict):
                    continue
                p = str(s.get("path_key") or s.get("location") or s.get("path") or "").strip()
                if p and p not in surface_paths:
                    surface_paths.append(p[:160])
                if len(surface_paths) >= SCOPE_INTEL_PATH_SAMPLE:
                    break

    # Prefer path-only samples from full URLs for compactness
    url_paths: list[str] = []
    for u in sample_urls:
        try:
            from urllib.parse import urlparse

            parsed = urlparse(u if "://" in u else f"http://{u}")
            path = (parsed.path or "/").strip() or "/"
            if path and path not in surface_paths and path not in url_paths:
                url_paths.append(path[:160])
        except Exception:
            continue
        if len(url_paths) >= min(8, SCOPE_INTEL_URL_SAMPLE):
            break
    # Keep a few full sample URLs too (short)
    short_urls = [u for u in sample_urls if len(u) < 120][:6]

    return build_scope_intel_card(
        hosts=host_rows,
        prior_counts=prior_counts or None,
        high_sample=high_sample or None,
        surface_paths=(surface_paths + url_paths)[:SCOPE_INTEL_PATH_SAMPLE] or None,
        sample_urls=short_urls or None,
        this_case_surface_n=this_case_surface_n,
        coverage=coverage,
    )


async def _scope_asset_rows(
    db,
    *,
    cid,
    uid,
    conv_context: dict | None,
) -> list[tuple[str, str, frozenset[str]]]:
    """Case Hosts: authorized Scope ids, unique identity match, unique Surface owner, sticky.

    Ambiguous identity (2+ Hosts share a key) does not join via that key.
    Returns (id, primary address, identity values).
    """
    import uuid as uuid_mod

    from sqlalchemy import or_, select

    from app.models.asset import Asset
    from app.services.asset_ledger import identity_values

    task = _task_from_conv_context(conv_context)
    host_keys = extract_hosts_from_task(task)
    explicit_ids = task_scope_asset_ids(task)
    origin_keys = surface_origin_host_keys(conv_context)
    rows: list[tuple[str, str, frozenset[str]]] = []
    seen: set[str] = set()

    def _add(asset) -> None:
        s = str(asset.id)
        if s in seen:
            return
        seen.add(s)
        idents = frozenset(identity_values(asset.address, asset.properties or {}))
        rows.append((s, str(asset.address or ""), idents))

    try:
        owner = or_(Asset.user_id == uid, Asset.user_id.is_(None)) if uid is not None else None
        catalog: list = []
        need_catalog = bool(host_keys or origin_keys)
        if uid is not None and (explicit_ids or need_catalog):
            q = select(Asset)
            if owner is not None:
                q = q.where(owner)
            if explicit_ids and not need_catalog:
                guids = []
                for raw_id in explicit_ids:
                    try:
                        guids.append(uuid_mod.UUID(raw_id))
                    except ValueError:
                        continue
                if guids:
                    q = q.where(Asset.id.in_(guids))
                    catalog = list((await db.execute(q)).scalars().all())
            else:
                catalog = list((await db.execute(q)).scalars().all())
        by_id = {str(a.id): a for a in catalog}

        for raw_id in explicit_ids:
            asset = by_id.get(raw_id)
            if asset is not None:
                _add(asset)

        ident_catalog = [
            (str(a.id), identity_values(a.address, a.properties or {}))
            for a in catalog
        ]
        for aid in unique_identity_asset_ids(host_keys, ident_catalog):
            asset = by_id.get(aid)
            if asset is not None:
                _add(asset)
        for aid in unique_identity_asset_ids(origin_keys, ident_catalog):
            asset = by_id.get(aid)
            if asset is not None:
                _add(asset)

        sticky_q = select(Asset).where(Asset.conversation_id == cid)
        if owner is not None:
            sticky_q = sticky_q.where(owner)
        for asset in (await db.execute(sticky_q)).scalars().all():
            _add(asset)
    except Exception:
        return rows
    return rows


async def _scope_assets(
    db,
    *,
    cid,
    uid,
    conv_context: dict | None,
) -> list[tuple[str, str]]:
    """(id, address) for Case Scope ∩ owner ledger (same match as scope_intel)."""
    return [
        (aid, addr)
        for aid, addr, _idents in await _scope_asset_rows(
            db, cid=cid, uid=uid, conv_context=conv_context
        )
    ]


async def _scope_asset_ids(
    db,
    *,
    cid,
    uid,
    conv_context: dict | None,
) -> list[str]:
    """Host ids for Case Scope ∩ owner ledger (same match as scope_intel)."""
    return [aid for aid, _addr in await _scope_assets(db, cid=cid, uid=uid, conv_context=conv_context)]


def _task_from_conv_context(conv_context: dict | None) -> dict:
    if isinstance(conv_context, dict):
        raw_task = conv_context.get("task")
        if isinstance(raw_task, dict):
            return raw_task
    return {}


def conv_context_with_this_turn_task(
    conv_context: dict | None,
    task_override: dict | None,
) -> dict:
    """Sticky conversation.context plus this-turn structured target/scope.

    This-turn envelope wins when present. No free-text invent.
    """
    ctx = dict(conv_context or {}) if isinstance(conv_context, dict) else {}
    sticky = ctx.get("task") if isinstance(ctx.get("task"), dict) else {}
    merged = dict(sticky) if isinstance(sticky, dict) else {}
    if isinstance(task_override, dict):
        if task_override.get("target"):
            merged["target"] = task_override["target"]
        if task_override.get("scope"):
            merged["scope"] = task_override["scope"]
    if merged:
        ctx["task"] = merged
    return ctx


async def _scope_intel_port_map(
    db,
    *,
    cid,
    uid,
    conv_context: dict | None,
) -> dict[str, set[str] | None]:
    rows = await _scope_asset_rows(db, cid=cid, uid=uid, conv_context=conv_context)
    assets = [(aid, addr) for aid, addr, _idents in rows]
    identities = {aid: set(idents) for aid, _addr, idents in rows}
    return case_intel_port_scope(
        assets, _task_from_conv_context(conv_context), identities=identities
    )


async def _load_living_intel_summary(
    db,
    *,
    cid,
    uid,
    conv_context: dict | None,
) -> list[dict[str, Any]] | None:
    """Living notebook lines for Scope Host-level + matching Scope Services."""
    from app.services.owner_intel import living_intel_for_assets

    port_scope = await _scope_intel_port_map(db, cid=cid, uid=uid, conv_context=conv_context)
    if not port_scope:
        return None
    task = _task_from_conv_context(conv_context)
    task_id = str(task.get("task_id") or task.get("id") or "").strip() or None
    rows = await living_intel_for_assets(
        db,
        user_id=uid,
        asset_ids=list(port_scope.keys()),
        port_scope=port_scope,
        current_task_id=task_id,
        conversation_id=str(cid),
    )
    if not rows:
        return None
    out: list[dict[str, Any]] = []
    for r in rows:
        line = {
            "id": r.get("id"),
            "summary": r.get("summary"),
            "kind": r.get("kind"),
            "asset_id": r.get("asset_id"),
            "port": r.get("port"),
            "is_new": r.get("is_new"),
        }
        out.append({k: v for k, v in line.items() if v is not None and v != ""})
    return out or None


async def load_case_context_for_conversation(
    db,
    conversation_id,
    *,
    user_id=None,
    thread_limit: int = DEFAULT_THREAD_LIMIT,
    findings_limit: int = DEFAULT_FINDINGS_LIMIT,
    evidence_limit: int = DEFAULT_EVIDENCE_SNIPPETS,
    task: dict | None = None,
    booking_session_id: str | None = None,
    booking_expert_id: str | None = None,
) -> dict[str, Any]:
    """Load messages + this-Case findings + thin scope_intel + evidence snippets.

    ``task`` is this-turn structured target/scope from the dispatch envelope.
    It overlays sticky conversation.context.task so first-turn inject sees
    the host even before the Case row is updated.
    """
    import uuid as uuid_mod

    from sqlalchemy import select

    from app.models.conversation import Conversation
    from app.models.evidence import Evidence
    from app.models.message import Message
    from app.models.vulnerability import Vulnerability
    from app.services.conversation_snapshot import message_summary
    from app.services.finding_dedupe import discovery_count, rediscovery_count

    cid = conversation_id if isinstance(conversation_id, uuid_mod.UUID) else uuid_mod.UUID(str(conversation_id))
    result = await db.execute(
        select(Message)
        .where(Message.conversation_id == cid)
        .order_by(Message.created_at, Message.id)
    )
    messages = [message_summary(m) for m in result.scalars().all()]

    uid = None
    if user_id is not None:
        uid = user_id if isinstance(user_id, uuid_mod.UUID) else uuid_mod.UUID(str(user_id))

    conv = None
    conv_context: dict = {}
    try:
        cr = await db.execute(select(Conversation).where(Conversation.id == cid))
        conv = cr.scalar_one_or_none()
        if conv is not None and isinstance(conv.context, dict):
            conv_context = conv.context
        if uid is None and conv is not None and getattr(conv, "user_id", None):
            uid = conv.user_id
    except Exception:
        conv = None
        conv_context = {}

    if task is not None:
        conv_context = conv_context_with_this_turn_task(conv_context, task)

    # findings_summary board: **this Case only** (avoid dumping cross-Case priors here).
    findings: list[dict] = []
    try:
        q = select(Vulnerability).where(Vulnerability.conversation_id == cid)
        if uid is not None:
            q = q.where(Vulnerability.user_id == uid)
        q = q.order_by(Vulnerability.updated_at.desc()).limit(max(findings_limit * 2, 30))
        for v in (await db.execute(q)).scalars().all():
            hist = getattr(v, "history", None)
            rcount = rediscovery_count(hist)
            loc = (
                getattr(v, "location_key", None)
                or getattr(v, "poc", None)
                or ""
            )
            findings.append({
                "id": str(getattr(v, "id", "") or ""),
                "title": getattr(v, "title", None) or "Untitled",
                "severity": _normalize_finding_severity(getattr(v, "severity", None)) or "",
                "status": getattr(v, "status", None) or "",
                "location": loc,
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
        if uid is not None:
            eq = eq.where(Evidence.user_id == uid)
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

    workset_blob = None
    intake_blob = None
    try:
        from app.services.case_workset import get_asset_intake, get_workset

        ctx_now = conv_context if isinstance(conv_context, dict) else {}
        if conv is not None:
            workset_blob = get_workset(ctx_now)
            intake_blob = get_asset_intake(ctx_now)
    except Exception:
        workset_blob = None
        intake_blob = None

    scope_intel = None
    try:
        scope_intel = await _load_scope_intel(
            db, cid=cid, uid=uid, conv_context=conv_context
        )
    except Exception:
        scope_intel = None

    intel_summary = None
    try:
        intel_summary = await _load_living_intel_summary(
            db, cid=cid, uid=uid, conv_context=conv_context
        )
    except Exception:
        intel_summary = None

    return build_case_context_payload(
        messages=messages,
        findings=findings,
        evidence_rows=evidence_rows,
        conversation_id=str(cid),
        thread_limit=thread_limit,
        findings_limit=findings_limit,
        evidence_limit=evidence_limit,
        workset=workset_blob,
        scope_intel=scope_intel,
        intel_summary=intel_summary,
        asset_intake=intake_blob,
        booking_session_id=booking_session_id,
        booking_expert_id=booking_expert_id,
    )
