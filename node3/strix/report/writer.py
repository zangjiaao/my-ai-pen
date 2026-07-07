"""Artifact writers for Strix scan reports."""

from __future__ import annotations

import csv
import io
import json
import logging
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from strix.core.paths import run_record_path
from strix.tools.run_memory.tools import evidence_from_file


logger = logging.getLogger(__name__)

_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}


def read_run_record(run_dir: Path) -> dict[str, Any]:
    path = run_record_path(run_dir)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"run.json at {path} is unreadable: {exc}") from exc
    if not isinstance(data, dict):
        raise TypeError(f"run.json at {path} is not an object")
    return data


def write_run_record(run_dir: Path, run_record: dict[str, Any]) -> None:
    _atomic_write_text(
        run_record_path(run_dir),
        json.dumps(run_record, ensure_ascii=False, indent=2, default=str),
    )


def write_executive_report(run_dir: Path, final_scan_result: str) -> None:
    path = run_dir / "penetration_test_report.md"
    with path.open("w", encoding="utf-8") as f:
        f.write("# Security Penetration Test Report\n\n")
        f.write(f"**Generated:** {datetime.now(UTC).strftime('%Y-%m-%d %H:%M:%S UTC')}\n\n")
        f.write(f"{final_scan_result}\n")
    logger.info("Saved final penetration test report to: %s", path)


def write_vulnerabilities(
    run_dir: Path,
    vulnerability_reports: list[dict[str, Any]],
    saved_vuln_ids: set[str],
) -> int:
    vuln_dir = run_dir / "vulnerabilities"
    vuln_dir.mkdir(exist_ok=True)

    new_reports = [r for r in vulnerability_reports if r["id"] not in saved_vuln_ids]
    evidence_by_id = _evidence_by_id(run_dir)

    for report in new_reports:
        _atomic_write_text(
            vuln_dir / f"{report['id']}.md",
            render_vulnerability_md(report, evidence_by_id),
        )
        saved_vuln_ids.add(report["id"])

    sorted_reports = sorted(
        vulnerability_reports,
        key=lambda r: (_SEVERITY_ORDER.get(r["severity"], 5), r["timestamp"]),
    )
    csv_path = run_dir / "vulnerabilities.csv"
    csv_buf = io.StringIO()
    fieldnames = ["id", "title", "severity", "timestamp", "file"]
    csv_writer = csv.DictWriter(csv_buf, fieldnames=fieldnames, lineterminator="\r\n")
    csv_writer.writeheader()
    for report in sorted_reports:
        csv_writer.writerow(
            {
                "id": report["id"],
                "title": report["title"],
                "severity": report["severity"].upper(),
                "timestamp": report["timestamp"],
                "file": f"vulnerabilities/{report['id']}.md",
            },
        )
    _atomic_write_text(csv_path, csv_buf.getvalue())

    _atomic_write_text(
        run_dir / "vulnerabilities.json",
        json.dumps(vulnerability_reports, ensure_ascii=False, indent=2, default=str),
    )

    if new_reports:
        logger.info(
            "Saved %d new vulnerability report(s) to: %s",
            len(new_reports),
            vuln_dir,
        )
    logger.info("Updated vulnerability index: %s", csv_path)
    return len(new_reports)


def _atomic_write_text(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp.write(payload)
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)


def _evidence_by_id(run_dir: Path) -> dict[str, dict[str, Any]]:
    return {
        str(item.get("evidence_id")): item
        for item in evidence_from_file(run_dir / ".state" / "evidence.json")
        if str(item.get("evidence_id") or "").strip()
    }


def _one_line(value: Any, *, limit: int = 240) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def _render_evidence_line(evidence_id: str, evidence_by_id: dict[str, dict[str, Any]] | None) -> str:
    evidence = (evidence_by_id or {}).get(evidence_id)
    if not evidence:
        return f"- `{evidence_id}` (not found in evidence ledger)"

    details = [
        _one_line(evidence.get("evidence_type"), limit=80),
        _one_line(evidence.get("source_tool"), limit=80),
        _one_line(evidence.get("target"), limit=120),
    ]
    details_text = ", ".join(detail for detail in details if detail)
    summary = _one_line(evidence.get("summary"), limit=240)
    if details_text and summary:
        return f"- `{evidence_id}` ({details_text}) - {summary}"
    if summary:
        return f"- `{evidence_id}` - {summary}"
    if details_text:
        return f"- `{evidence_id}` ({details_text})"
    return f"- `{evidence_id}`"


def render_vulnerability_md(
    report: dict[str, Any],
    evidence_by_id: dict[str, dict[str, Any]] | None = None,
) -> str:  # noqa: PLR0912, PLR0915
    lines: list[str] = [
        f"# {report.get('title', 'Untitled Vulnerability')}\n",
        f"**ID:** {report.get('id', 'unknown')}",
        f"**Severity:** {report.get('severity', 'unknown').upper()}",
        f"**Found:** {report.get('timestamp', 'unknown')}",
    ]

    metadata: list[tuple[str, Any]] = [
        ("Target", report.get("target")),
        ("Endpoint", report.get("endpoint")),
        ("Method", report.get("method")),
        ("CVE", report.get("cve")),
        ("CWE", report.get("cwe")),
    ]
    cvss = report.get("cvss")
    if cvss is not None:
        metadata.append(("CVSS", cvss))
    for label, value in metadata:
        if value:
            lines.append(f"**{label}:** {value}")

    lines.append("")
    lines.append("## Description\n")
    lines.append(report.get("description") or "No description provided.")
    lines.append("")

    if report.get("impact"):
        lines.append("## Impact\n")
        lines.append(str(report["impact"]))
        lines.append("")

    if report.get("technical_analysis"):
        lines.append("## Technical Analysis\n")
        lines.append(str(report["technical_analysis"]))
        lines.append("")

    if report.get("poc_description") or report.get("poc_script_code"):
        lines.append("## Proof of Concept\n")
        if report.get("poc_description"):
            lines.append(str(report["poc_description"]))
            lines.append("")
        if report.get("poc_script_code"):
            lines.append("```")
            lines.append(str(report["poc_script_code"]))
            lines.append("```")
            lines.append("")

    if report.get("code_locations"):
        lines.append("## Code Analysis\n")
        for i, loc in enumerate(report["code_locations"]):
            file_ref = loc.get("file", "unknown")
            line_ref = ""
            if loc.get("start_line") is not None:
                if loc.get("end_line") and loc["end_line"] != loc["start_line"]:
                    line_ref = f" (lines {loc['start_line']}-{loc['end_line']})"
                else:
                    line_ref = f" (line {loc['start_line']})"
            lines.append(f"**Location {i + 1}:** `{file_ref}`{line_ref}")
            if loc.get("label"):
                lines.append(f"  {loc['label']}")
            if loc.get("snippet"):
                lines.append(f"  ```\n  {loc['snippet']}\n  ```")
            if loc.get("fix_before") or loc.get("fix_after"):
                lines.append("\n  **Suggested Fix:**")
                lines.append("```diff")
                if loc.get("fix_before"):
                    lines.extend(f"- {ln}" for ln in str(loc["fix_before"]).splitlines())
                if loc.get("fix_after"):
                    lines.extend(f"+ {ln}" for ln in str(loc["fix_after"]).splitlines())
                lines.append("```")
            lines.append("")

    if report.get("evidence_ids"):
        lines.append("## Evidence\n")
        for evidence_id in report["evidence_ids"]:
            lines.append(_render_evidence_line(str(evidence_id), evidence_by_id))
        lines.append("")

    if report.get("remediation_steps"):
        lines.append("## Remediation\n")
        lines.append(str(report["remediation_steps"]))
        lines.append("")

    return "\n".join(lines)
