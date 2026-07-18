"""Pure transform: booked findings → professional detection report (markdown + HTML).

Used by product export APIs and unit tests. Does not invent CVEs or findings.
HackerOne-aligned sections when source fields exist; honest placeholders otherwise.
"""
from __future__ import annotations

import html
import re
from datetime import datetime, timezone
from typing import Any


_SEV_ORDER = ("critical", "high", "medium", "low", "info", "unknown")

DEFAULT_METHOD_NOTE = (
    "This report is generated from **confirmed findings** booked during the engagement "
    "(with linked evidence references). Only issues that passed proof-gated booking are included. "
    "No vulnerability classes, CVEs, or PoCs were invented at export time."
)

DEFAULT_DISCLAIMER = (
    "This document is intended for the authorized assessment stakeholder. "
    "Findings should be validated in the target environment before production remediation decisions. "
    "Empty optional fields mean the source booking record did not contain that data."
)


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


def _first_str(v: dict[str, Any], *keys: str) -> str:
    for k in keys:
        if k not in v or v.get(k) is None:
            continue
        s = str(v.get(k)).strip()
        if s:
            return s
    return ""


def _props(v: dict[str, Any]) -> dict[str, Any]:
    raw = v.get("properties") or v.get("extra") or {}
    return raw if isinstance(raw, dict) else {}


def _cvss_score(v: dict[str, Any]) -> str:
    props = _props(v)
    for src in (v, props):
        for key in ("cvss", "cvss_score", "cvssScore"):
            if key not in src or src.get(key) is None:
                continue
            val = src.get(key)
            if isinstance(val, (int, float)):
                return str(val)
            s = str(val).strip()
            if s:
                return s
    return ""


def _cvss_vector(v: dict[str, Any]) -> str:
    props = _props(v)
    return _first_str(v, "cvss_vector", "cvssVector", "vector") or _first_str(
        props, "cvss_vector", "cvssVector", "vector"
    )


def _affected_asset(v: dict[str, Any]) -> str:
    props = _props(v)
    loc = _first_str(v, "location", "url", "endpoint", "path")
    asset = _first_str(v, "asset", "asset_name", "host", "hostname") or _first_str(
        props, "asset", "host", "hostname"
    )
    port = _first_str(v, "port") or _first_str(props, "port")
    asset_id = _first_str(v, "asset_id")
    parts: list[str] = []
    if asset:
        parts.append(asset)
    if port:
        parts.append(f"port {port}")
    if loc and loc != asset:
        parts.append(loc)
    # Only surface internal asset_id when we have no human-readable host/location
    if asset_id and not asset and not loc:
        parts.append(f"asset_id={asset_id}")
    return " · ".join(parts)


def _root_cause(v: dict[str, Any]) -> str:
    props = _props(v)
    return _first_str(v, "root_cause", "rootCause", "cause") or _first_str(
        props, "root_cause", "rootCause", "cause"
    )


def _impact(v: dict[str, Any]) -> str:
    props = _props(v)
    return _first_str(v, "impact", "business_impact") or _first_str(
        props, "impact", "business_impact"
    )


def _description(v: dict[str, Any]) -> str:
    return _first_str(v, "description", "detail", "summary")


def _poc(v: dict[str, Any]) -> str:
    return _first_str(v, "poc", "proof", "reproduction", "steps_to_reproduce")


def _remediation(v: dict[str, Any]) -> str:
    props = _props(v)
    return _first_str(v, "remediation", "fix", "remediation_steps") or _first_str(
        props, "remediation", "fix"
    )


def _append_section(lines: list[str], heading: str, body: str, empty_placeholder: str) -> None:
    lines.append(f"**{heading}**")
    lines.append("")
    lines.append(body if body else empty_placeholder)
    lines.append("")


def _sort_findings(findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        findings,
        key=lambda v: (
            _SEV_ORDER.index(_sev(v)) if _sev(v) in _SEV_ORDER else 99,
            _title(v),
        ),
    )


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
    customer_label: str | None = None,
) -> str:
    """Build a client-facing detection report from booked findings only."""
    findings = _sort_findings(list(findings or []))
    evidence_by_id = evidence_by_id or {}
    counts: dict[str, int] = {}
    for v in findings:
        s = _sev(v)
        counts[s] = counts.get(s, 0) + 1

    gen = generated_at or datetime.now(timezone.utc).isoformat()
    doc_title = (title or "").strip() or "Security Assessment Report"
    lines: list[str] = [
        f"# {doc_title}",
        "",
        "_Detection report — confirmed findings only_",
        "",
        "## 1. Executive summary",
        "",
        f"- **Generated:** `{gen}`",
        f"- **Session / Case ID:** `{conversation_id or '-'}`",
    ]
    if customer_label:
        lines.append(f"- **Engagement name:** {customer_label}")
    lines.extend(
        [
            f"- **Target:** `{target or '-'}`",
            f"- **Scope:** `{scope or target or '-'}`",
            f"- **Engagement mode:** `{engagement or 'pentest'}`",
            f"- **Confirmed findings:** **{len(findings)}**",
        ]
    )
    sev_parts = [f"{s}: {counts[s]}" for s in _SEV_ORDER if s in counts]
    if sev_parts:
        lines.append(f"- **By severity:** {', '.join(sev_parts)}")
    lines.append("")
    if findings:
        lines.append("**Priority highlights**")
        lines.append("")
        for v in findings[:8]:
            lines.append(f"- **[{_sev(v).upper()}]** {_title(v)}")
        lines.append("")
    else:
        lines.append("_No confirmed findings were booked for this session._")
        lines.append("")

    lines.extend(
        [
            "## 2. Scope and methodology",
            "",
            method_note or DEFAULT_METHOD_NOTE,
            "",
            "## 3. Findings",
            "",
        ]
    )

    if not findings:
        lines.extend(
            [
                "_None. The assessment session did not produce proof-gated booked findings._",
                "",
            ]
        )
    else:
        for i, v in enumerate(findings, start=1):
            lines.append(f"### 3.{i} {_title(v)}")
            lines.append("")
            lines.append(f"- **Title:** {_title(v)}")
            lines.append(f"- **Severity:** `{_sev(v)}`")
            score = _cvss_score(v)
            vector = _cvss_vector(v)
            if score and vector:
                lines.append(f"- **CVSS:** score `{score}` · vector `{vector}`")
            elif score:
                lines.append(f"- **CVSS score:** `{score}`")
            elif vector:
                lines.append(f"- **CVSS vector:** `{vector}`")
            else:
                lines.append("- **CVSS:** _(none in source data)_")
            if v.get("status"):
                lines.append(f"- **Status:** `{v.get('status')}`")
            asset = _affected_asset(v)
            lines.append(
                f"- **Affected asset / location:** `{asset}`"
                if asset
                else "- **Affected asset / location:** _(none in source data)_"
            )
            cve = _first_str(v, "cve_id", "cve")
            lines.append(f"- **CVE:** `{cve}`" if cve else "- **CVE:** _(none in source data)_")
            lines.append("")

            _append_section(
                lines,
                "Description / root cause",
                _description(v) or _root_cause(v),
                "_No description in source record._",
            )
            rc = _root_cause(v)
            desc = _description(v)
            if rc and desc and rc not in desc:
                _append_section(lines, "Root cause", rc, "_No root cause in source record._")

            _append_section(
                lines,
                "Proof of Concept / reproduction",
                _poc(v),
                "_No PoC text in source record; see evidence ids if present._",
            )
            _append_section(
                lines,
                "Impact",
                _impact(v),
                "_No impact statement in source record._",
            )
            _append_section(
                lines,
                "Remediation",
                _remediation(v),
                "_No remediation text in source record._",
            )

            eids = _eids(v)
            lines.append("**Evidence linkage**")
            lines.append("")
            if eids:
                for eid in eids:
                    ev = evidence_by_id.get(eid)
                    if isinstance(ev, dict):
                        summary = str(ev.get("summary") or ev.get("type") or "").strip()
                        lines.append(f"- `{eid}`" + (f": {summary[:240]}" if summary else ""))
                    elif isinstance(ev, str) and ev:
                        lines.append(f"- `{eid}`: {ev[:240]}")
                    else:
                        lines.append(f"- `{eid}`")
            else:
                lines.append("_No evidence ids in source record._")
            lines.append("")

    crit = [v for v in findings if _sev(v) in ("critical", "high")]
    med = [v for v in findings if _sev(v) == "medium"]
    low = [v for v in findings if _sev(v) in ("low", "info", "unknown")]
    lines.extend(
        [
            "## 4. Remediation roadmap",
            "",
            "- **P0 (critical / high):** " + ("; ".join(_title(v) for v in crit) or "_none_"),
            "- **P1 (medium):** " + ("; ".join(_title(v) for v in med) or "_none_"),
            "- **P2 (low / info):** " + ("; ".join(_title(v) for v in low) or "_none_"),
            "",
            "## 5. Appendix — finding index",
            "",
        ]
    )
    if not findings:
        lines.append("_Empty._")
    else:
        for i, v in enumerate(findings, start=1):
            lines.append(f"{i}. [{_sev(v)}] {_title(v)}")
    lines.extend(
        [
            "",
            "## 6. Disclaimer",
            "",
            DEFAULT_DISCLAIMER,
            "",
        ]
    )
    return "\n".join(lines)


_SECTION_HEADING_RE = re.compile(r"^(##\s+)(\d+)(\.\s+)(.*)$")
_FINDING_HEADING_RE = re.compile(r"^(###\s+)(\d+\.\d+|\d+)(\s+)(.*)$")


def normalize_report_markdown_sections(markdown: str) -> str:
    """Renumber top-level ``## N.`` headings to 1..k without gaps.

    Agent-authored reports often jump 4 → 6 when the appendix is omitted;
    delivery HTML/MD downloads should not show a missing chapter 5.
    Also ensures a short finding index exists before Disclaimer when missing.
    """
    text = markdown or ""
    lines = text.splitlines()

    # Collect ### finding titles for optional appendix injection
    finding_titles: list[str] = []
    for line in lines:
        m = _FINDING_HEADING_RE.match(line)
        if m:
            finding_titles.append(m.group(4).strip())

    has_appendix = any(
        re.match(r"^##\s+\d+\.\s+.*(Appendix|附录|finding index|漏洞索引)", line, re.I)
        for line in lines
    )
    has_disclaimer = any(
        re.match(r"^##\s+\d+\.\s+.*(Disclaimer|免责)", line, re.I) for line in lines
    )

    # Inject appendix before disclaimer if findings exist and appendix missing
    if finding_titles and not has_appendix:
        insert_at = None
        for i, line in enumerate(lines):
            if re.match(r"^##\s+\d+\.\s+.*(Disclaimer|免责)", line, re.I):
                insert_at = i
                break
        appendix_block = [
            "## 5. Appendix — finding index",
            "",
            *[f"{i}. {t}" for i, t in enumerate(finding_titles, start=1)],
            "",
        ]
        if insert_at is not None:
            lines = lines[:insert_at] + appendix_block + lines[insert_at:]
        elif has_disclaimer is False:
            lines = lines + [""] + appendix_block

    # Renumber ## N. sequentially (leave non-numbered ## alone)
    n = 0
    out: list[str] = []
    for line in lines:
        m = _SECTION_HEADING_RE.match(line)
        if m:
            n += 1
            out.append(f"{m.group(1)}{n}{m.group(3)}{m.group(4)}")
        else:
            out.append(line)
    return "\n".join(out) + ("\n" if text.endswith("\n") else "")


def build_engagement_report_html(
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
    customer_label: str | None = None,
    markdown: str | None = None,
) -> str:
    """HTML delivery report from the same findings model (or prebuilt markdown)."""
    md = markdown or build_engagement_report_markdown(
        title=title,
        target=target,
        scope=scope,
        engagement=engagement,
        conversation_id=conversation_id,
        findings=findings,
        evidence_by_id=evidence_by_id,
        method_note=method_note,
        generated_at=generated_at,
        customer_label=customer_label,
    )
    md = normalize_report_markdown_sections(md)
    doc_title = (title or "").strip() or "Security Assessment Report"
    meta = _extract_cover_meta(md, conversation_id=conversation_id, target=target, engagement=engagement)
    return _markdown_to_delivery_html(md, page_title=doc_title, cover_meta=meta)


def _extract_cover_meta(
    markdown: str,
    *,
    conversation_id: str | None = None,
    target: str | None = None,
    engagement: str | None = None,
) -> dict[str, Any]:
    """Pull summary fields from cover bullets / **Key**: value lines for the letterhead."""
    meta: dict[str, Any] = {}
    if conversation_id:
        meta["session"] = str(conversation_id)
    if target:
        meta["target"] = str(target)
    if engagement:
        meta["engagement"] = str(engagement)

    def _set(key: str, val: str) -> None:
        val = re.sub(r"^`+|`+$", "", (val or "").strip()).strip()
        if val and key not in meta:
            meta[key] = val

    for line in (markdown or "").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            # stop cover scan at first real section heading after some content
            if s.startswith("## ") and meta:
                break
            continue
        # **Key**: value  or  - **Key:** value
        km = re.match(
            r"^(?:[-*+]\s+)?\*\*([^*]+?)\*\*\s*[：:]\s*(.+)$",
            s,
        )
        if km:
            key_raw = km.group(1).strip().lower()
            val = km.group(2).strip()
            if any(k in key_raw for k in ("target", "目标地址", "目标")) and "报告" not in key_raw:
                _set("target", val)
            elif "报告编号" in key_raw or key_raw in ("report id", "report no", "report number"):
                _set("report_id", val)
            elif any(k in key_raw for k in ("session", "case", "conversation", "会话")):
                _set("session", val)
            elif any(k in key_raw for k in ("engagement", "测试类型", "测试方式")):
                _set("engagement", val)
            elif any(k in key_raw for k in ("generated", "报告生成", "生成日期", "生成时间")):
                _set("generated", val)
            elif any(k in key_raw for k in ("测试日期", "date", "评估日期")):
                _set("test_date", val)
            elif any(k in key_raw for k in ("测试人员", "author", "评估人员", "tester")):
                _set("author", val)
            elif any(k in key_raw for k in ("报告整理", "整理", "writer")):
                _set("prepared_by", val)
            continue
        if not s.startswith("-"):
            continue
        low = s.lower()
        if "target" in low and "target" not in meta:
            _set("target", re.sub(r"^[-*]\s*\*?\*?target\*?\*?\s*[：:]\s*", "", s, flags=re.I))
        elif ("session" in low or "case id" in low or "conversation" in low) and "session" not in meta:
            _set(
                "session",
                re.sub(
                    r"^[-*]\s*\*?\*?(session|case id|conversation)[^*]*\*?\*?\s*[：:]\s*",
                    "",
                    s,
                    flags=re.I,
                ),
            )
        elif "engagement" in low and "engagement" not in meta:
            _set(
                "engagement",
                re.sub(r"^[-*]\s*\*?\*?engagement[^*]*\*?\*?\s*[：:]\s*", "", s, flags=re.I),
            )
        elif (
            "confirmed findings" in low or "findings booked" in low or "确认" in s or "漏洞数" in s
        ) and "findings" not in meta:
            m = re.search(r"(\d+)", s)
            if m:
                meta["findings"] = m.group(1)
        elif "generated" in low and "generated" not in meta:
            _set(
                "generated",
                re.sub(r"^[-*]\s*\*?\*?generated[^*]*\*?\*?\s*[：:]\s*", "", s, flags=re.I),
            )

    # Severity rollup: **[CRITICAL]** bullets and emoji table rows
    counts: dict[str, int] = {}
    for line in (markdown or "").splitlines():
        m = re.search(r"\*\*\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\*\*", line, re.I)
        if m:
            k = m.group(1).lower()
            counts[k] = counts.get(k, 0) + 1
            continue
        # table rows: | 🔴 **严重 (Critical)** | 3 | 50% |
        m2 = re.search(
            r"\|\s*(?:🔴|🟠|🟡|🟢|🔵)?\s*\*?\*?(严重|高危|中危|低危|信息|critical|high|medium|low|info)"
            r"[^*|]*\*?\*?\s*\|\s*(\d+)\s*\|",
            line,
            re.I,
        )
        if m2:
            lab = m2.group(1).lower()
            mapping = {
                "严重": "critical",
                "critical": "critical",
                "高危": "high",
                "high": "high",
                "中危": "medium",
                "medium": "medium",
                "低危": "low",
                "low": "low",
                "信息": "info",
                "info": "info",
            }
            k = mapping.get(lab)
            if k:
                counts[k] = int(m2.group(2))
    if counts:
        meta["severity_counts"] = counts  # type: ignore[assignment]
        meta["severity_rollup"] = ", ".join(f"{k}: {v}" for k, v in counts.items() if v)
        if "findings" not in meta:
            meta["findings"] = str(sum(int(v) for v in counts.values()))
    return meta

def _severity_class(text: str) -> str:
    """Map free text / table blob to a sev-* class.

    Avoid matching the field label 「严重级别」 itself as Critical.
    Prefer explicit emoji / English tokens / 高危·中危 style words.
    """
    raw = text or ""
    # strip common label noise that contains 严重/高/中/低
    cleaned = re.sub(
        r"严重级别|风险级别|危险等级|severity\s*level|severity\s*rating",
        " ",
        raw,
        flags=re.I,
    )
    t = cleaned.lower()
    if "🔴" in cleaned or re.search(r"\bcritical\b", t) or "超危" in cleaned:
        return "sev-critical"
    if re.search(r"(?<![级栏栏位列])严重(?!级别)", cleaned):
        return "sev-critical"
    if "🟠" in cleaned or re.search(r"\bhigh\b", t) or "高危" in cleaned:
        return "sev-high"
    if "🟡" in cleaned or re.search(r"\bmedium\b", t) or "中危" in cleaned:
        return "sev-medium"
    if "🟢" in cleaned or re.search(r"\blow\b", t) or "低危" in cleaned:
        return "sev-low"
    if "🔵" in cleaned or re.search(r"\binfo(?:rmational)?\b", t) or "信息" in cleaned:
        return "sev-info"
    return ""


def _severity_label(cls: str) -> str:
    return {
        "sev-critical": "Critical",
        "sev-high": "High",
        "sev-medium": "Medium",
        "sev-low": "Low",
        "sev-info": "Info",
    }.get(cls, "")


def _inline_md(text: str) -> str:
    """Escape + inline markdown: code, bold, italic, links."""
    s = html.escape(text or "")
    s = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", s)
    s = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        r'<a href="\2" rel="noopener noreferrer">\1</a>',
        s,
    )
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    parts = re.split(r"(<code>.*?</code>)", s)
    out: list[str] = []
    for part in parts:
        if part.startswith("<code>"):
            out.append(part)
            continue
        part = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", part)
        part = re.sub(r"__([^_]+)__", r"<strong>\1</strong>", part)
        part = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", part)
        part = re.sub(r"(?<!_)_([^_]+)_(?!_)", r"<em>\1</em>", part)
        out.append(part)
    return "".join(out)


def _is_table_sep(line: str) -> bool:
    s = line.strip()
    if "|" not in s:
        return False
    cells = [c.strip() for c in s.strip("|").split("|")]
    if not cells:
        return False
    return all(re.fullmatch(r":?-{2,}:?", c or "-") for c in cells)


def _parse_table_row(line: str) -> list[str]:
    s = line.strip().strip("|")
    return [c.strip() for c in s.split("|")]


def _is_kv_table(headers: list[str]) -> bool:
    """Two-column attribute tables (属性/内容, Field/Value, …)."""
    if len(headers) != 2:
        return False
    blob = " ".join(headers).lower()
    keys = ("属性", "内容", "项目", "字段", "field", "value", "attribute", "item", "key")
    return any(k in blob for k in keys)


_FIELD_HEAD_RE = re.compile(
    r"^(描述|漏洞描述|影响|影响分析|修复建议|复现步骤|利用证明|证据|建议|root cause|"
    r"description|impact|remediation|recommendation|proof|poc|reproduction|"
    r"evidence|proof of concept)(\s|/|\(|（|$)",
    re.I,
)


def _is_field_heading(text: str) -> bool:
    t = re.sub(r"^[\d.]+\s*", "", (text or "").strip())
    t = re.sub(r"^\*\*|\*\*$", "", t).strip()
    return bool(_FIELD_HEAD_RE.match(t))


def _is_finding_heading(text: str, in_findings_section: bool) -> bool:
    """Only real vulnerability titles become finding cards (not §1.1 / §2.1)."""
    if not in_findings_section:
        return False
    t = (text or "").strip()
    # 3.1 / 3.12 style under findings chapter
    if re.match(r"^\d+\.\d+\b", t):
        return True
    if re.search(r"[🔴🟠🟡🟢🔵]", t):
        return True
    if re.search(
        r"critical|high|medium|漏洞|注入|xss|sql|上传|包含|rce|csrf|ssrf|lfi|rfi",
        t,
        re.I,
    ):
        return True
    return False


def _render_table(headers: list[str], rows: list[list[str]]) -> str:
    kv = _is_kv_table(headers)
    cls = "md-table kv-table" if kv else "md-table"
    if kv:
        # key/value tables: no thead noise, first col as th
        body_rows = []
        # include header row only if it looks like real data labels, skip "属性|内容"
        data_rows = rows
        for row in data_rows:
            cells = (row + [""] * 2)[:2]
            body_rows.append(
                "<tr>"
                f"<th scope='row'>{_inline_md(cells[0])}</th>"
                f"<td>{_inline_md(cells[1])}</td>"
                "</tr>"
            )
        return (
            f'<div class="table-wrap"><table class="{cls}"><tbody>'
            + "".join(body_rows)
            + "</tbody></table></div>"
        )
    thead = "<thead><tr>" + "".join(f"<th>{_inline_md(h)}</th>" for h in headers) + "</tr></thead>"
    tbody_rows = []
    for row in rows:
        cells = (row + [""] * len(headers))[: len(headers)]
        # severity cell coloring
        tds = []
        for c in cells:
            sev = _severity_class(c)
            extra = f' class="cell-{sev}"' if sev else ""
            tds.append(f"<td{extra}>{_inline_md(c)}</td>")
        tbody_rows.append("<tr>" + "".join(tds) + "</tr>")
    return (
        f'<div class="table-wrap"><table class="{cls}">'
        + thead
        + "<tbody>"
        + "".join(tbody_rows)
        + "</tbody></table></div>"
    )


def _render_meta_lines(lines: list[str]) -> str:
    """Cover / doc-control lines: **Key**: value → definition table."""
    rows = []
    for line in lines:
        m = re.match(r"^(?:[-*+]\s+)?\*\*([^*]+?)\*\*\s*[：:]\s*(.+)$", line.strip())
        if m:
            rows.append((m.group(1).strip(), m.group(2).strip()))
        else:
            rows.append(("", line.strip()))
    if not rows:
        return ""
    if all(k for k, _ in rows):
        body = "".join(
            f"<tr><th scope='row'>{_inline_md(k)}</th><td>{_inline_md(v)}</td></tr>"
            for k, v in rows
        )
        return (
            '<div class="table-wrap doc-control"><table class="md-table kv-table"><tbody>'
            + body
            + "</tbody></table></div>"
        )
    return "<p>" + " · ".join(_inline_md(f"**{k}**: {v}" if k else v) for k, v in rows) + "</p>"


def _set_finding_card_sev(tag: str, sev: str) -> str:
    """Update finding-card severity class without dropping id= anchors."""
    if not sev or not tag.startswith("<article"):
        return tag
    # strip previous sev-* class tokens
    tag = re.sub(r"\ssev-(?:critical|high|medium|low|info)\b", "", tag)
    if 'class="finding-card"' in tag:
        return tag.replace('class="finding-card"', f'class="finding-card {sev}"', 1)
    if 'class="finding-card ' in tag:
        return tag.replace('class="finding-card ', f'class="finding-card {sev} ', 1)
    return tag


def _heading_anchor(text: str, *, prefix: str = "sec", fallback: str = "x") -> str:
    """Build a stable id from numbered headings (1 / 1.1 / 3.2) or a short slug."""
    m = re.match(r"^(\d+(?:\.\d+)*)\b", (text or "").strip())
    if m:
        return f"{prefix}-{m.group(1).replace('.', '-')}"
    slug = re.sub(r"[^\w\u4e00-\u9fff]+", "-", (text or "").strip(), flags=re.UNICODE)
    slug = re.sub(r"-+", "-", slug).strip("-")[:48] or fallback
    return f"{prefix}-{slug}"


def _toc_label(text: str, *, max_len: int = 72) -> str:
    """Readable TOC label; keep original numbering, trim ultra-long finding titles."""
    t = re.sub(r"\s+", " ", (text or "").strip())
    if len(t) > max_len:
        t = t[: max_len - 1].rstrip() + "…"
    return t


def _render_toc(entries: list[tuple[int, str, str]]) -> str:
    """Nested TOC from (level, anchor, label). level 2 = chapter, 3 = subsection.

    Uses plain lists (not <ol>) so markdown numbers like ``1.`` / ``1.1`` are not
    doubled by browser auto-numbering.
    """
    if not entries:
        return ""
    roots: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for level, anchor, label in entries:
        node = {"anchor": anchor, "label": label, "children": []}
        if level <= 2:
            current = node
            roots.append(current)
        else:
            if current is None:
                roots.append(node)
                current = node
            else:
                current["children"].append(node)

    def _item(node: dict[str, Any]) -> str:
        link = (
            f'<a href="#{html.escape(str(node["anchor"]))}">'
            f'{_inline_md(str(node["label"]))}</a>'
        )
        kids = node.get("children") or []
        if not kids:
            return link
        sub = "".join(f"<li>{_item(c)}</li>" for c in kids)
        return f'{link}<ul class="toc-sub">{sub}</ul>'

    lis = "".join(f"<li>{_item(r)}</li>" for r in roots)
    return (
        '<nav class="toc" aria-label="Table of contents">'
        '<div class="toc-title">目录 · Contents</div>'
        f'<ul class="toc-list">{lis}</ul></nav>'
    )


def markdown_to_html_fragments(markdown: str) -> str:
    """Convert GFM-ish markdown to professional report HTML fragments."""
    lines = (markdown or "").replace("\r\n", "\n").split("\n")
    i = 0
    out: list[str] = []
    n = len(lines)
    in_findings_section = False
    finding_open = False
    # (level 2|3, anchor, label) — level 3 = 二级标题 / findings
    toc: list[tuple[int, str, str]] = []
    used_anchors: set[str] = set()
    cover_buf: list[str] = []
    seen_section = False
    h2_count = 0
    h3_count = 0

    def close_finding() -> None:
        nonlocal finding_open
        if finding_open:
            out.append("</div></article>")
            finding_open = False

    def flush_cover() -> None:
        nonlocal cover_buf
        if cover_buf:
            out.append(_render_meta_lines(cover_buf))
            cover_buf = []

    def unique_anchor(text: str, *, fallback: str) -> str:
        base = _heading_anchor(text, fallback=fallback)
        anchor = base
        n_dup = 2
        while anchor in used_anchors:
            anchor = f"{base}-{n_dup}"
            n_dup += 1
        used_anchors.add(anchor)
        return anchor

    while i < n:
        line = lines[i]
        stripped = line.strip()

        # fenced code
        if stripped.startswith("```"):
            flush_cover()
            lang = stripped[3:].strip()
            i += 1
            buf: list[str] = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            if i < n:
                i += 1
            code = html.escape("\n".join(buf))
            cls = f' class="lang-{html.escape(lang)}"' if lang else ""
            out.append(f"<pre><code{cls}>{code}</code></pre>")
            continue

        # horizontal rule (skip decorative rules before first real section)
        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", stripped):
            flush_cover()
            close_finding()
            if seen_section and (not out or out[-1] != "<hr />"):
                out.append("<hr />")
            i += 1
            continue

        # headings
        hm = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if hm:
            flush_cover()
            level = len(hm.group(1))
            text = hm.group(2).strip()
            if level == 1:
                close_finding()
                # cover owns H1
                i += 1
                continue
            if level == 2:
                close_finding()
                seen_section = True
                h2_count += 1
                in_findings_section = bool(
                    re.search(r"漏洞详情|Findings|Detailed findings|漏洞清单", text, re.I)
                )
                m = re.match(r"^(\d+)\.\s*(.+)$", text)
                if m:
                    num, label = m.group(1), m.group(2)
                    anchor = unique_anchor(text, fallback=str(h2_count))
                    # TOC shows full "1. 执行摘要"; body badge shows num only once
                    toc.append((2, anchor, _toc_label(f"{num}. {label}")))
                    out.append(
                        f'<h2 class="section" id="{html.escape(anchor)}">'
                        f'<span class="sec-num">{html.escape(num)}</span>'
                        f'<span class="sec-label">{_inline_md(label)}</span></h2>'
                    )
                else:
                    anchor = unique_anchor(text, fallback=str(h2_count))
                    toc.append((2, anchor, _toc_label(text)))
                    out.append(
                        f'<h2 class="section" id="{html.escape(anchor)}">'
                        f'<span class="sec-label">{_inline_md(text)}</span></h2>'
                    )
                i += 1
                continue
            if level == 3:
                close_finding()
                h3_count += 1
                anchor = unique_anchor(text, fallback=f"s{h3_count}")
                toc.append((3, anchor, _toc_label(text)))
                if _is_finding_heading(text, in_findings_section):
                    sev = _severity_class(text)
                    badge = ""
                    if sev:
                        badge = (
                            f'<span class="badge {sev}">{html.escape(_severity_label(sev))}</span>'
                        )
                    out.append(f'<article class="finding-card {sev}" id="{html.escape(anchor)}">')
                    out.append('<header class="finding-head">')
                    out.append(
                        f'<h3 class="finding-title" title="{html.escape(text, quote=True)}">'
                        f"{_inline_md(text)}</h3>"
                    )
                    if badge:
                        out.append(badge)
                    out.append("</header>")
                    out.append('<div class="finding-body">')
                    finding_open = True
                else:
                    out.append(
                        f'<h3 class="subsec" id="{html.escape(anchor)}">{_inline_md(text)}</h3>'
                    )
                i += 1
                continue
            # #### field headings inside findings (not in TOC)
            if level >= 4 and finding_open and _is_field_heading(text):
                out.append(f'<h4 class="field-label">{_inline_md(text)}</h4>')
            else:
                out.append(f"<h{level} class='subh'>{_inline_md(text)}</h{level}>")
            i += 1
            continue

        # table
        if "|" in stripped and i + 1 < n and _is_table_sep(lines[i + 1]):
            flush_cover()
            headers = _parse_table_row(line)
            i += 2
            rows: list[list[str]] = []
            while i < n and "|" in lines[i] and not lines[i].strip().startswith("#"):
                if not lines[i].strip():
                    break
                if _is_table_sep(lines[i]):
                    i += 1
                    continue
                rows.append(_parse_table_row(lines[i]))
                i += 1
            if finding_open:
                blob = " ".join(headers) + " " + " ".join(" ".join(r) for r in rows)
                sev = _severity_class(blob)
                if sev:
                    for j in range(len(out) - 1, -1, -1):
                        if out[j].startswith("<article") and "finding-card" in out[j]:
                            out[j] = _set_finding_card_sev(out[j], sev)
                            break
                    # inject badge if missing
                    for j in range(len(out) - 1, -1, -1):
                        if out[j].startswith('<header class="finding-head">'):
                            # look ahead for badge
                            if j + 2 < len(out) and "badge" not in out[j + 2]:
                                out.insert(
                                    j + 2,
                                    f'<span class="badge {sev}">{html.escape(_severity_label(sev))}</span>',
                                )
                            break
            out.append(_render_table(headers, rows))
            continue

        # blank
        if not stripped:
            i += 1
            continue

        # cover-area **Key**: value lines before first ## — letterhead already
        # surfaces these via cover_meta; skip duplicate body table.
        if (
            not seen_section
            and not finding_open
            and re.match(r"^(?:[-*+]\s+)?\*\*[^*]+?\*\*\s*[：:]", stripped)
        ):
            i += 1
            continue

        flush_cover()

        # unordered list
        if re.match(r"^[-*+]\s+", stripped):
            items: list[str] = []
            while i < n and re.match(r"^[-*+]\s+", lines[i].strip()):
                items.append(re.sub(r"^[-*+]\s+", "", lines[i].strip()))
                i += 1
            lis = []
            prop_vals: list[str] = []
            for it in items:
                hl = re.match(
                    r"^\*\*\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\*\*\s*(.*)$", it, re.I
                )
                if hl:
                    cls = _severity_class(hl.group(1))
                    lis.append(
                        f'<li class="priority-item">'
                        f'<span class="badge {cls}">{html.escape(hl.group(1).upper())}</span> '
                        f"{_inline_md(hl.group(2))}</li>"
                    )
                    continue
                # property-style: **Key:** value  OR  **Key**: value
                pm = re.match(
                    r"^\*\*([^*：:]+?)[：:]?\*\*\s*[：:]?\s*(.*)$", it
                )
                if pm and finding_open and pm.group(1).strip():
                    k, v = pm.group(1).strip(), pm.group(2).strip()
                    prop_vals.append(f"{k} {v}")
                    lis.append(
                        f'<li class="prop-item"><span class="prop-k">{_inline_md(k)}</span>'
                        f'<span class="prop-v">{_inline_md(v)}</span></li>'
                    )
                else:
                    lis.append(f"<li>{_inline_md(it)}</li>")
            # upgrade finding severity from property list
            if finding_open and prop_vals:
                sev = _severity_class(" ".join(prop_vals))
                if sev:
                    for j in range(len(out) - 1, -1, -1):
                        if out[j].startswith("<article") and "finding-card" in out[j]:
                            out[j] = _set_finding_card_sev(out[j], sev)
                            break
                    # inject badge into finding-head if missing
                    for j in range(len(out) - 1, -1, -1):
                        if out[j].startswith('<header class="finding-head">'):
                            # badge is typically right after title
                            if j + 2 < len(out) and "badge" not in out[j + 2]:
                                out.insert(
                                    j + 2,
                                    f'<span class="badge {sev}">{html.escape(_severity_label(sev))}</span>',
                                )
                            break
            if lis and all('class="prop-item"' in x for x in lis):
                out.append("<ul class='prop-list'>" + "".join(lis) + "</ul>")
            else:
                out.append("<ul class='md-ul'>" + "".join(lis) + "</ul>")
            continue

        # ordered list (allow multi-line items until blank / next marker / special)
        if re.match(r"^\d+\.\s+", stripped):
            items = []
            while i < n:
                cur = lines[i].strip()
                if re.match(r"^\d+\.\s+", cur):
                    items.append(re.sub(r"^\d+\.\s+", "", cur))
                    i += 1
                    # continuation lines (indented or plain prose, not special)
                    while i < n:
                        nxt_raw = lines[i]
                        nxt = nxt_raw.strip()
                        if not nxt:
                            break
                        if nxt.startswith("#") or nxt.startswith("```") or nxt.startswith("|"):
                            break
                        if re.match(r"^\d+\.\s+", nxt) or re.match(r"^[-*+]\s+", nxt):
                            break
                        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", nxt):
                            break
                        items[-1] = items[-1] + " " + nxt
                        i += 1
                    continue
                break
            out.append(
                "<ol class='md-ol'>"
                + "".join(f"<li>{_inline_md(it)}</li>" for it in items)
                + "</ol>"
            )
            continue

        # standalone **Field label** line (no trailing text) → field header
        alone = re.match(r"^\*\*([^*]+)\*\*\s*$", stripped)
        if alone and _is_field_heading(alone.group(1)):
            out.append(f'<h4 class="field-label">{_inline_md(alone.group(1))}</h4>')
            i += 1
            continue

        # paragraph: gather consecutive non-blank non-special lines
        para: list[str] = [stripped]
        i += 1
        while i < n:
            nxt = lines[i].strip()
            if not nxt:
                break
            if nxt.startswith("#") or nxt.startswith("```") or nxt.startswith("|"):
                break
            if re.match(r"^[-*+]\s+", nxt) or re.match(r"^\d+\.\s+", nxt):
                break
            if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", nxt):
                break
            if re.match(r"^\*\*[^*]+\*\*\s*$", nxt):
                break
            para.append(nxt)
            i += 1
        out.append("<p>" + _inline_md(" ".join(para)) + "</p>")

    flush_cover()
    if finding_open:
        out.append("</div></article>")

    body = "\n".join(out)
    # prepend nested TOC when there is more than one top-level chapter
    top_level = sum(1 for lvl, _, _ in toc if lvl <= 2)
    if top_level >= 2 or len(toc) >= 3:
        body = _render_toc(toc) + "\n" + body
    return body


def _severity_dashboard(counts: dict[str, int] | None) -> str:
    if not counts:
        return ""
    order = [
        ("critical", "Critical", "严重"),
        ("high", "High", "高危"),
        ("medium", "Medium", "中危"),
        ("low", "Low", "低危"),
        ("info", "Info", "信息"),
    ]
    cells = []
    for key, en, zh in order:
        n = int(counts.get(key) or 0)
        if n <= 0 and key == "info":
            continue
        cells.append(
            f'<div class="sev-cell sev-{key}">'
            f'<span class="sev-n">{n}</span>'
            f'<span class="sev-l">{zh}<small>{en}</small></span>'
            f"</div>"
        )
    if not cells:
        return ""
    return '<div class="sev-dashboard">' + "".join(cells) + "</div>"


def _markdown_to_delivery_html(
    markdown: str,
    *,
    page_title: str,
    cover_meta: dict[str, Any] | None = None,
) -> str:
    """Professional penetration-test delivery HTML (offline, no external deps).

    Layout inspired by industry templates (document control, severity rollup,
    numbered sections, finding cards with attribute tables) — see
    https://www.pentestreports.com/templates
    """
    cover_meta = cover_meta or {}
    body = markdown_to_html_fragments(markdown)
    safe_title = html.escape(page_title)

    counts = cover_meta.get("severity_counts")
    if not isinstance(counts, dict):
        counts = {}
    dashboard = _severity_dashboard({str(k).lower(): int(v) for k, v in counts.items()})

    # Document control rows for letterhead
    control_specs = [
        ("report_id", "报告编号"),
        ("session", "会话编号"),
        ("target", "测试目标"),
        ("engagement", "测试类型"),
        ("test_date", "测试日期"),
        ("generated", "生成时间"),
        ("author", "测试人员"),
        ("prepared_by", "报告整理"),
        ("findings", "漏洞数量"),
    ]
    control_rows = []
    for key, label in control_specs:
        val = cover_meta.get(key)
        if val and not isinstance(val, dict):
            control_rows.append(
                f"<tr><th scope='row'>{html.escape(label)}</th>"
                f"<td>{html.escape(str(val))}</td></tr>"
            )
    control_html = ""
    if control_rows:
        control_html = (
            '<div class="doc-control-wrap"><table class="doc-control">'
            + "".join(control_rows)
            + "</table></div>"
        )

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{safe_title}</title>
  <style>
    :root {{
      --ink: #111827;
      --muted: #6b7280;
      --line: #e5e7eb;
      --bg: #e8edf3;
      --paper: #ffffff;
      --navy: #0b1f33;
      --navy-2: #12304d;
      --accent: #0e4a6b;
      --critical: #b42318;
      --high: #c4320a;
      --medium: #b54708;
      --low: #175cd3;
      --info: #475467;
      --critical-soft: #fef3f2;
      --high-soft: #fff6ed;
      --medium-soft: #fffaeb;
      --low-soft: #eff8ff;
      --info-soft: #f3f4f6;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      color: var(--ink);
      font-family: "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
        "Noto Sans SC", Inter, system-ui, sans-serif;
      background: var(--bg);
      line-height: 1.65;
      font-size: 14.5px;
    }}
    .sheet {{
      max-width: 920px;
      margin: 20px auto 48px;
      background: var(--paper);
      box-shadow: 0 12px 40px rgba(15, 23, 42, 0.12);
      border: 1px solid #d5dde8;
    }}
    /* —— Cover —— */
    .conf-bar {{
      background: #7f1d1d;
      color: #fff;
      text-align: center;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.22em;
      padding: 7px 12px;
      text-transform: uppercase;
    }}
    .letterhead {{
      background: linear-gradient(135deg, var(--navy) 0%, var(--navy-2) 55%, #1a4a6e 100%);
      color: #fff;
      padding: 28px 36px 24px;
    }}
    .letterhead-top {{
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }}
    .brand {{
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      opacity: 0.85;
    }}
    .brand small {{
      display: block;
      margin-top: 4px;
      font-size: 11px;
      letter-spacing: 0.02em;
      font-weight: 500;
      opacity: 0.7;
      text-transform: none;
    }}
    .doc-type {{
      font-size: 11px;
      font-weight: 800;
      color: var(--navy);
      background: #fff;
      padding: 6px 12px;
      letter-spacing: 0.08em;
    }}
    .letterhead h1 {{
      margin: 0 0 10px;
      font-size: 1.65rem;
      line-height: 1.3;
      font-weight: 750;
      max-width: 100%;
      overflow-wrap: anywhere;
      word-break: break-word;
    }}
    .letterhead .tagline {{
      margin: 0 0 18px;
      opacity: 0.78;
      font-size: 0.9rem;
    }}
    .doc-control-wrap {{
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.14);
      padding: 4px 0;
    }}
    table.doc-control {{
      width: 100%;
      border-collapse: collapse;
      font-size: 12.5px;
    }}
    table.doc-control th {{
      text-align: left;
      width: 7.5rem;
      padding: 7px 14px;
      font-weight: 600;
      opacity: 0.75;
      vertical-align: top;
    }}
    table.doc-control td {{
      padding: 7px 14px;
      font-weight: 650;
      overflow-wrap: anywhere;
      word-break: break-word;
    }}
    .sev-dashboard {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
      gap: 0;
      border-top: 1px solid var(--line);
    }}
    .sev-cell {{
      padding: 14px 12px;
      text-align: center;
      border-right: 1px solid var(--line);
      background: #fafbfc;
    }}
    .sev-cell:last-child {{ border-right: 0; }}
    .sev-n {{
      display: block;
      font-size: 1.6rem;
      font-weight: 800;
      line-height: 1.1;
      font-variant-numeric: tabular-nums;
    }}
    .sev-l {{
      display: block;
      font-size: 12px;
      font-weight: 700;
      margin-top: 2px;
      color: var(--muted);
    }}
    .sev-l small {{
      display: block;
      font-weight: 500;
      font-size: 10px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      opacity: 0.85;
    }}
    .sev-cell.sev-critical .sev-n {{ color: var(--critical); }}
    .sev-cell.sev-high .sev-n {{ color: var(--high); }}
    .sev-cell.sev-medium .sev-n {{ color: var(--medium); }}
    .sev-cell.sev-low .sev-n {{ color: var(--low); }}
    .sev-cell.sev-info .sev-n {{ color: var(--info); }}
    .sev-cell.sev-critical {{ background: var(--critical-soft); }}
    .sev-cell.sev-high {{ background: var(--high-soft); }}
    .sev-cell.sev-medium {{ background: var(--medium-soft); }}
    .sev-cell.sev-low {{ background: var(--low-soft); }}
    /* —— TOC (no auto-numbering — labels already carry 1. / 1.1) —— */
    .toc {{
      margin: 0 0 28px;
      padding: 16px 18px;
      background: #f8fafc;
      border: 1px solid var(--line);
    }}
    .toc-title {{
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 10px;
    }}
    .toc-list, .toc-sub {{
      list-style: none;
      margin: 0;
      padding: 0;
    }}
    .toc-list > li {{
      margin: 8px 0;
      break-inside: avoid;
      font-weight: 700;
      font-size: 0.95rem;
    }}
    .toc-sub {{
      margin: 4px 0 6px;
      padding-left: 1.15rem;
      border-left: 2px solid var(--line);
    }}
    .toc-sub > li {{
      margin: 3px 0;
      font-weight: 450;
      font-size: 0.88rem;
      color: #374151;
    }}
    .toc a {{ color: inherit; text-decoration: none; }}
    .toc a:hover {{ color: var(--accent); text-decoration: underline; }}
    /* —— Body —— */
    .content {{
      padding: 28px 36px 40px;
      overflow-wrap: anywhere;
      word-break: break-word;
    }}
    h2.section {{
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 36px 0 16px;
      padding: 0 0 10px;
      border-bottom: 2px solid var(--navy);
      font-size: 1.18rem;
      color: var(--navy);
      scroll-margin-top: 12px;
    }}
    h2.section:first-of-type {{ margin-top: 8px; }}
    h2.section .sec-num {{
      flex: 0 0 auto;
      min-width: 1.9rem;
      height: 1.9rem;
      padding: 0 7px;
      background: var(--navy);
      color: #fff;
      font-size: 12px;
      font-weight: 800;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }}
    h2.section .sec-label {{ font-weight: 750; }}
    h3.subsec {{
      margin: 22px 0 10px;
      font-size: 1.02rem;
      color: var(--ink);
      padding-left: 10px;
      border-left: 3px solid var(--accent);
      scroll-margin-top: 12px;
    }}
    h3.finding-title {{
      margin: 0;
      font-size: 1.05rem;
      font-weight: 750;
      line-height: 1.4;
      flex: 1 1 auto;
      min-width: 0;
    }}
    .finding-card {{ scroll-margin-top: 12px; }}
    h4.subh, h4, h5.subh, h5, h6.subh, h6 {{
      margin: 14px 0 8px;
      font-size: 0.92rem;
      color: var(--accent);
      font-weight: 750;
    }}
    h4.field-label {{
      margin: 16px 0 8px;
      font-size: 0.78rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
      border-bottom: 1px dashed var(--line);
      padding-bottom: 4px;
    }}
    p {{ margin: 8px 0 12px; color: #1f2937; }}
    p em {{ color: var(--muted); }}
    hr {{
      border: 0;
      border-top: 1px solid var(--line);
      margin: 22px 0;
    }}
    ul.md-ul, ol.md-ol {{
      margin: 8px 0 16px;
      padding-left: 1.35rem;
    }}
    li {{ margin: 5px 0; }}
    li.priority-item {{
      list-style: none;
      margin-left: -1.35rem;
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 9px 12px;
      border: 1px solid var(--line);
      background: #f8fafc;
      margin-bottom: 6px;
    }}
    ul.prop-list {{
      list-style: none;
      margin: 8px 0 14px;
      padding: 0;
      border: 1px solid var(--line);
    }}
    li.prop-item {{
      display: grid;
      grid-template-columns: 8rem 1fr;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
      margin: 0;
    }}
    li.prop-item:last-child {{ border-bottom: 0; }}
    .prop-k {{ font-weight: 700; color: var(--muted); font-size: 0.88rem; }}
    .prop-v {{ min-width: 0; }}
    /* —— Findings —— */
    .finding-card {{
      margin: 20px 0 28px;
      border: 1px solid var(--line);
      background: #fff;
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
      overflow: hidden;
    }}
    .finding-card.sev-critical {{ border-top: 3px solid var(--critical); }}
    .finding-card.sev-high {{ border-top: 3px solid var(--high); }}
    .finding-card.sev-medium {{ border-top: 3px solid var(--medium); }}
    .finding-card.sev-low {{ border-top: 3px solid var(--low); }}
    .finding-card.sev-info {{ border-top: 3px solid var(--info); }}
    .finding-head {{
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      background: #f8fafc;
      border-bottom: 1px solid var(--line);
    }}
    .finding-card.sev-critical .finding-head {{ background: var(--critical-soft); }}
    .finding-card.sev-high .finding-head {{ background: var(--high-soft); }}
    .finding-card.sev-medium .finding-head {{ background: var(--medium-soft); }}
    .finding-card.sev-low .finding-head {{ background: var(--low-soft); }}
    .finding-body {{ padding: 14px 16px 16px; }}
    .badge {{
      display: inline-block;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.06em;
      padding: 4px 10px;
      color: #fff;
      background: #667085;
      white-space: nowrap;
      flex: 0 0 auto;
      text-transform: uppercase;
    }}
    .badge.sev-critical {{ background: var(--critical); }}
    .badge.sev-high {{ background: var(--high); }}
    .badge.sev-medium {{ background: var(--medium); }}
    .badge.sev-low {{ background: var(--low); }}
    .badge.sev-info {{ background: var(--info); }}
    /* —— Tables —— */
    .table-wrap {{
      width: 100%;
      overflow-x: auto;
      margin: 10px 0 16px;
      border: 1px solid var(--line);
    }}
    table.md-table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
      min-width: 320px;
    }}
    table.md-table th {{
      background: var(--navy);
      color: #fff;
      text-align: left;
      font-weight: 650;
      padding: 9px 12px;
    }}
    table.md-table td {{
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      overflow-wrap: anywhere;
      word-break: break-word;
    }}
    table.md-table tbody tr:nth-child(even) td {{ background: #f9fafb; }}
    table.md-table tr:last-child td {{ border-bottom: 0; }}
    table.kv-table {{ min-width: 0; }}
    table.kv-table th[scope="row"] {{
      background: #f3f5f8;
      color: var(--ink);
      font-weight: 700;
      width: 8.5rem;
      border-bottom: 1px solid var(--line);
      border-right: 1px solid var(--line);
      white-space: nowrap;
    }}
    table.kv-table td {{ background: #fff; }}
    table.kv-table tbody tr:nth-child(even) td {{ background: #fcfcfd; }}
    td.cell-sev-critical, td.cell-sev-high, td.cell-sev-medium, td.cell-sev-low {{
      font-weight: 700;
    }}
    td.cell-sev-critical {{ color: var(--critical); }}
    td.cell-sev-high {{ color: var(--high); }}
    td.cell-sev-medium {{ color: var(--medium); }}
    td.cell-sev-low {{ color: var(--low); }}
    .doc-control.table-wrap, .table-wrap.doc-control {{
      margin-top: 4px;
    }}
    code {{
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: #eef2f6;
      padding: 1px 5px;
      font-size: 0.86em;
      word-break: break-all;
      white-space: pre-wrap;
    }}
    pre {{
      background: #0b1220;
      color: #e2e8f0;
      padding: 12px 14px;
      overflow-x: auto;
      max-width: 100%;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.82rem;
      border-left: 3px solid #334155;
      margin: 10px 0 14px;
    }}
    pre code {{ background: transparent; padding: 0; color: inherit; }}
    a {{ color: #175cd3; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    .footer {{
      margin-top: 36px;
      padding-top: 14px;
      border-top: 2px solid var(--navy);
      color: var(--muted);
      font-size: 0.78rem;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }}
    .footer .cls {{
      font-weight: 800;
      letter-spacing: 0.08em;
      color: #7f1d1d;
      text-transform: uppercase;
    }}
    @media print {{
      body {{ background: #fff; }}
      .sheet {{ margin: 0; box-shadow: none; border: 0; max-width: none; }}
      .finding-card {{ break-inside: avoid; }}
      .toc {{ break-after: avoid; }}
      .letterhead, .conf-bar, table.md-table th, .sev-cell {{
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }}
    }}
    @media (max-width: 720px) {{
      .letterhead, .content {{ padding: 18px 14px; }}
      .sheet {{ margin: 0; border: 0; }}
      .toc-sub {{ padding-left: 0.85rem; }}
      li.prop-item {{ grid-template-columns: 1fr; }}
      table.kv-table th[scope="row"] {{ width: auto; white-space: normal; }}
    }}
  </style>
</head>
<body>
  <div class="sheet">
    <div class="conf-bar">Confidential · 机密 · Authorized recipients only</div>
    <header class="letterhead">
      <div class="letterhead-top">
        <div class="brand">
          Security Assessment Report
          <small>Penetration Test Delivery · 渗透测试交付报告</small>
        </div>
        <div class="doc-type">PENTEST REPORT</div>
      </div>
      <h1>{safe_title}</h1>
      <p class="tagline">基于已确认漏洞与可复核证据生成 · 供授权方决策与修复跟踪</p>
{control_html}
    </header>
{dashboard}
    <main class="content">
{body}
      <div class="footer">
        <span class="cls">Confidential</span>
        <span>Confirmed findings only · Not a raw scanner dump</span>
        <span>Security Assessment Platform</span>
      </div>
    </main>
  </div>
</body>
</html>
"""
