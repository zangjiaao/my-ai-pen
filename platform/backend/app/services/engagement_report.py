"""Pure transform: vulnerability + evidence records → structured markdown report.

Used by export APIs and unit tests. Does not invent CVEs or findings.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


_SEV_ORDER = ("critical", "high", "medium", "low", "info", "unknown")


def _sev(v: dict[str, Any]) -> str:
    s = str(v.get("severity") or "unknown").strip().lower()
    return s or "unknown"


def _title(v: dict[str, Any]) -> str:
    t = str(v.get("title") or v.get("name") or "Untitled finding").strip()
    return t or "Untitled finding"


def _eids(v: dict[str, Any]) -> list[str]:
    raw = v.get("evidence_ids") or v.get("evidenceIds") or []
    if not isinstance(raw, list):
        return []
    return [str(x) for x in raw if x]


def build_engagement_report_markdown(
    *,
    title: str | None = None,
    target: str | None = None,
    scope: str | None = None,
    engagement: str | None = None,
    conversation_id: str | None = None,
    findings: list[dict[str, Any]] | None = None,
    evidence_by_id: dict[str, Any] | None = None,
    method_note: str | None = None,
    generated_at: str | None = None,
) -> str:
    findings = list(findings or [])
    evidence_by_id = evidence_by_id or {}
    findings = sorted(
        findings,
        key=lambda v: (
            _SEV_ORDER.index(_sev(v)) if _sev(v) in _SEV_ORDER else 99,
            _title(v),
        ),
    )
    counts: dict[str, int] = {}
    for v in findings:
        s = _sev(v)
        counts[s] = counts.get(s, 0) + 1

    gen = generated_at or datetime.now(timezone.utc).isoformat()
    lines: list[str] = [
        f"# {title or 'Penetration Test Report'}",
        "",
        "## 1. Executive summary",
        "",
        f"- Generated at: `{gen}`",
        f"- Conversation: `{conversation_id or '-'}`",
        f"- Target: `{target or '-'}`",
        f"- Scope: `{scope or target or '-'}`",
        f"- Engagement: `{engagement or 'pentest'}`",
        f"- Findings booked: **{len(findings)}**",
    ]
    sev_parts = [f"{s}: {counts[s]}" for s in _SEV_ORDER if s in counts]
    if sev_parts:
        lines.append(f"- By severity: {', '.join(sev_parts)}")
    lines.append("")
    if findings:
        lines.append("Top issues:")
        for v in findings[:8]:
            lines.append(f"- **[{_sev(v)}]** {_title(v)}")
        lines.append("")
    else:
        lines.append("_No confirmed findings in source data._")
        lines.append("")

    lines.extend(
        [
            "## 2. Scope and method",
            "",
            method_note
            or (
                "Authorized assessment within the stated scope. Report body is derived only from "
                "booked findings and linked evidence references; no vulnerability classes were invented."
            ),
            "",
            "## 3. Findings",
            "",
        ]
    )

    if not findings:
        lines.extend(["_None._", ""])
    else:
        for i, v in enumerate(findings, start=1):
            lines.append(f"### 3.{i} {_title(v)}")
            lines.append("")
            lines.append(f"- Severity: `{_sev(v)}`")
            if v.get("status"):
                lines.append(f"- Status: `{v.get('status')}`")
            loc = str(v.get("location") or v.get("url") or v.get("endpoint") or "").strip()
            if loc:
                lines.append(f"- Location: `{loc}`")
            cve = str(v.get("cve_id") or v.get("cve") or "").strip()
            lines.append(f"- CVE: `{cve}`" if cve else "- CVE: _(none in source data)_")
            lines.append("")
            desc = str(v.get("description") or v.get("detail") or v.get("summary") or "").strip()
            lines.append("**Description**")
            lines.append("")
            lines.append(desc or "_No description in source record._")
            lines.append("")
            poc = str(v.get("poc") or v.get("proof") or v.get("reproduction") or "").strip()
            lines.append("**Reproduction / PoC**")
            lines.append("")
            lines.append(poc or "_No PoC text; see evidence ids._")
            lines.append("")
            rem = str(v.get("remediation") or "").strip()
            lines.append("**Remediation**")
            lines.append("")
            lines.append(rem or "_No remediation text in source record._")
            lines.append("")
            eids = _eids(v)
            if eids:
                lines.append("**Evidence ids**")
                lines.append("")
                for eid in eids:
                    ev = evidence_by_id.get(eid)
                    if isinstance(ev, dict):
                        summary = str(ev.get("summary") or ev.get("type") or "").strip()
                        lines.append(f"- `{eid}`" + (f": {summary[:240]}" if summary else ""))
                    elif isinstance(ev, str) and ev:
                        lines.append(f"- `{eid}`: {ev[:240]}")
                    else:
                        lines.append(f"- `{eid}`")
                lines.append("")

    crit = [v for v in findings if _sev(v) in ("critical", "high")]
    med = [v for v in findings if _sev(v) == "medium"]
    low = [v for v in findings if _sev(v) in ("low", "info", "unknown")]
    lines.extend(
        [
            "## 4. Remediation roadmap",
            "",
            "- **P0 (critical/high):** " + ("; ".join(_title(v) for v in crit) or "_none_"),
            "- **P1 (medium):** " + ("; ".join(_title(v) for v in med) or "_none_"),
            "- **P2 (low/info):** " + ("; ".join(_title(v) for v in low) or "_none_"),
            "",
            "## 5. Appendix — finding titles",
            "",
        ]
    )
    if not findings:
        lines.append("_Empty._")
    else:
        for i, v in enumerate(findings, start=1):
            lines.append(f"{i}. [{_sev(v)}] {_title(v)}")
    lines.append("")
    return "\n".join(lines)
