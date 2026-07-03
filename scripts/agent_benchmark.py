"""Offline benchmark report builder for agent autonomy runs.

The benchmark answer key remains docs/agent-autonomy-benchmark.md. This script
does not decide whether a case passed; it extracts session facts into a stable
JSON and Markdown report so a developer can compare the run against that answer
key without querying the Agent or changing product UI.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tarfile
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ANSWERS = ROOT / "docs" / "agent-autonomy-benchmark.md"


@dataclass
class SessionFacts:
    source_type: str
    source_path: str
    session_id: str
    target: str
    status: str
    instruction: str
    confirmed_findings: list[dict[str, Any]]
    candidate_findings: list[dict[str, Any]]
    evidence: list[dict[str, Any]]
    attack_surface: list[dict[str, Any]]
    coverage: list[dict[str, Any]]
    history: list[dict[str, Any]]
    checkpoint: dict[str, Any]


def load_answers(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8-sig")
    return {
        "path": str(path),
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "cases": parse_markdown_cases(text),
    }


def parse_markdown_cases(text: str) -> list[dict[str, str]]:
    cases: list[dict[str, str]] = []
    section = ""
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("### "):
            section = line.removeprefix("### ").strip()
            continue
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < 4 or cells[0] in {"Case", "---"}:
            continue
        case_id = cells[0]
        if not (case_id.startswith("DVWA-") or case_id.startswith("JS-")):
            continue
        cases.append({
            "id": case_id,
            "section": section,
            "type": cells[1],
            "target_ability": cells[2],
            "hit_standard": cells[3],
        })
    return cases


def load_checkpoint_file(path: Path) -> SessionFacts:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    checkpoint = data.get("checkpoint") if isinstance(data.get("checkpoint"), dict) else data
    if not isinstance(checkpoint, dict):
        raise ValueError("checkpoint must be a JSON object")
    return facts_from_checkpoint(checkpoint, source_type="checkpoint", source_path=str(path))


def load_report_file(path: Path) -> SessionFacts:
    with tarfile.open(path, "r:gz") as tar:
        members = {member.name: member for member in tar.getmembers() if member.isfile()}
        manifest = _read_json(tar, members, "manifest.json", {})
        checkpoint = _read_json(tar, members, "checkpoints/latest.json", {})
        vulnerabilities = _read_json(tar, members, "vulnerabilities.json", [])
        evidence = _read_json(tar, members, "evidence.json", [])
        attack_surface = _read_json(tar, members, "attack_surface.json", [])
        coverage = _read_json(tar, members, "coverage.json", [])
        messages = _read_jsonl(tar, members, "conversation.jsonl")

    target = manifest.get("target") if isinstance(manifest.get("target"), dict) else {}
    return SessionFacts(
        source_type="report",
        source_path=str(path),
        session_id=str(manifest.get("session_id") or checkpoint.get("conversation_id") or ""),
        target=str(target.get("value") or checkpoint.get("resolved_target") or ""),
        status=str(manifest.get("status") or checkpoint.get("phase") or ""),
        instruction=str(manifest.get("instruction") or ""),
        confirmed_findings=[item for item in vulnerabilities if _is_confirmed(item)],
        candidate_findings=[item for item in checkpoint.get("candidate_findings") or [] if isinstance(item, dict)],
        evidence=[item for item in evidence if isinstance(item, dict)],
        attack_surface=[item for item in attack_surface if isinstance(item, dict)],
        coverage=[item for item in (coverage or checkpoint.get("coverage") or []) if isinstance(item, dict)],
        history=messages,
        checkpoint=checkpoint,
    )


def facts_from_checkpoint(checkpoint: dict[str, Any], *, source_type: str, source_path: str) -> SessionFacts:
    state = checkpoint.get("state") if isinstance(checkpoint.get("state"), dict) else {}
    return SessionFacts(
        source_type=source_type,
        source_path=source_path,
        session_id=str(checkpoint.get("conversation_id") or checkpoint.get("task_id") or ""),
        target=str(checkpoint.get("resolved_target") or ""),
        status=str(state.get("phase") or checkpoint.get("phase") or ""),
        instruction=str(checkpoint.get("instruction") or ""),
        confirmed_findings=[item for item in checkpoint.get("confirmed_findings") or [] if isinstance(item, dict)],
        candidate_findings=[item for item in checkpoint.get("candidate_findings") or [] if isinstance(item, dict)],
        evidence=_checkpoint_evidence_rows(checkpoint),
        attack_surface=[item for item in checkpoint.get("attack_surface") or [] if isinstance(item, dict)],
        coverage=[item for item in checkpoint.get("coverage") or [] if isinstance(item, dict)],
        history=[item for item in checkpoint.get("history") or [] if isinstance(item, dict)],
        checkpoint=checkpoint,
    )


def build_report(facts: SessionFacts, answers: dict[str, Any], review: dict[str, Any] | None = None) -> dict[str, Any]:
    confirmed = [_finding_summary(item) for item in facts.confirmed_findings]
    candidates = [_finding_summary(item) for item in facts.candidate_findings]
    coverage = [_coverage_summary(item) for item in facts.coverage]
    attack_surface = [_surface_summary(item) for item in facts.attack_surface]
    evidence = [_evidence_summary(item) for item in facts.evidence]
    review_map = _review_map(review)
    expected_cases = [
        {
            **case,
            "review_status": review_map.get(case["id"], {}).get("status", "manual_review"),
            "review_notes": review_map.get(case["id"], {}).get("notes", ""),
            "related_findings": _related_indexes(case, confirmed + candidates),
            "related_coverage": _related_indexes(case, coverage),
            "related_attack_surface": _related_indexes(case, attack_surface),
            "related_evidence": _related_indexes(case, evidence),
        }
        for case in answers["cases"]
    ]
    denominator = [case for case in expected_cases if "P0" in case["section"] or "P1" in case["section"]]
    score = _score_review(expected_cases, denominator) if review_map else None

    return {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "answer_key": {
            "path": answers["path"],
            "sha256": answers["sha256"],
            "case_count": len(expected_cases),
            "denominator_case_count": len(denominator),
            "scoring_mode": "manual_review_against_markdown",
        },
        "session": {
            "source_type": facts.source_type,
            "source_path": facts.source_path,
            "session_id": facts.session_id,
            "target": facts.target,
            "status": facts.status,
            "instruction": facts.instruction,
        },
        "counts": {
            "confirmed_findings": len(confirmed),
            "candidate_findings": len(candidates),
            "evidence": len(evidence),
            "attack_surface": len(attack_surface),
            "coverage": len(coverage),
            "history": len(facts.history),
        },
        "score": score,
        "expected_cases": expected_cases,
        "confirmed_findings": confirmed,
        "candidate_findings": candidates,
        "coverage": coverage,
        "attack_surface": attack_surface,
        "evidence": evidence,
        "audit_hints": {
            "duplicate_adjacent_tool_actions": _duplicate_actions(facts.checkpoint),
            "manual_approval_mentions": _approval_mentions(facts.history),
            "confirmed_without_evidence": [item["id"] or item["title"] for item in confirmed if not item["evidence_ids"]],
        },
    }



def load_review(path: Path | None) -> dict[str, Any] | None:
    if not path:
        return None
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError("review file must be a JSON object")
    return data


def _review_map(review: dict[str, Any] | None) -> dict[str, dict[str, str]]:
    if not review:
        return {}
    out: dict[str, dict[str, str]] = {}
    for case_id in review.get("hits") or []:
        out[str(case_id)] = {"status": "hit", "notes": ""}
    for item in review.get("cases") or []:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        status = str(item.get("status") or "manual_review").lower()
        if status not in {"hit", "miss", "partial", "false_positive", "manual_review"}:
            status = "manual_review"
        out[str(item["id"])] = {"status": status, "notes": str(item.get("notes") or "")}
    return out


def _score_review(expected_cases: list[dict[str, Any]], denominator: list[dict[str, Any]]) -> dict[str, Any]:
    denominator_ids = {case["id"] for case in denominator}
    hit_ids = {case["id"] for case in expected_cases if case["id"] in denominator_ids and case.get("review_status") == "hit"}
    partial_ids = {case["id"] for case in expected_cases if case["id"] in denominator_ids and case.get("review_status") == "partial"}
    miss_ids = {case["id"] for case in expected_cases if case["id"] in denominator_ids and case.get("review_status") == "miss"}
    reviewed_ids = hit_ids | partial_ids | miss_ids | {case["id"] for case in expected_cases if case["id"] in denominator_ids and case.get("review_status") == "false_positive"}
    score = len(hit_ids) + len(partial_ids) * 0.5
    total = len(denominator_ids)
    percent = round((score / total) * 100, 2) if total else 0.0
    return {
        "mode": "manual_review",
        "target_percent": 80.0,
        "passed": percent >= 80.0,
        "percent": percent,
        "score": score,
        "denominator": total,
        "hit": len(hit_ids),
        "partial": len(partial_ids),
        "miss": len(miss_ids),
        "reviewed": len(reviewed_ids),
        "unreviewed": max(0, total - len(reviewed_ids)),
    }
def write_reports(report: dict[str, Any], output_dir: Path, *, write_review_template: bool = False) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "benchmark-report.json"
    md_path = output_dir / "benchmark-report.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    if write_review_template:
        review_path = output_dir / "benchmark-review-template.json"
        review_path.write_text(json.dumps(build_review_template(report), ensure_ascii=False, indent=2), encoding="utf-8")
    return json_path, md_path


def build_review_template(report: dict[str, Any]) -> dict[str, Any]:
    denominator_sections = ("P0", "P1")
    cases = []
    for case in report.get("expected_cases") or []:
        section = str(case.get("section") or "")
        if not any(marker in section for marker in denominator_sections):
            continue
        cases.append({
            "id": case.get("id"),
            "status": "manual_review",
            "notes": "",
            "section": section,
            "type": case.get("type"),
            "target_ability": case.get("target_ability"),
            "hit_standard": case.get("hit_standard"),
            "related_findings": case.get("related_findings") or [],
            "related_coverage": case.get("related_coverage") or [],
            "related_evidence": case.get("related_evidence") or [],
        })
    return {
        "review_schema": "agent-benchmark-manual-review-v1",
        "instructions": "Set each case status to hit, miss, partial, false_positive, or manual_review. Only P0/P1 cases are scored for TASK-042.",
        "session_id": report.get("session", {}).get("session_id", ""),
        "target": report.get("session", {}).get("target", ""),
        "answer_key_sha256": report.get("answer_key", {}).get("sha256", ""),
        "cases": cases,
    }


def render_markdown(report: dict[str, Any]) -> str:
    session = report["session"]
    counts = report["counts"]
    lines = [
        "# Agent Benchmark Report",
        "",
        f"- Answer key: `{report['answer_key']['path']}`",
        f"- Answer key SHA-256: `{report['answer_key']['sha256']}`",
        f"- Scoring mode: `{report['answer_key']['scoring_mode']}`",
        f"- Session: `{session['session_id']}`",
        f"- Target: `{session['target']}`",
        f"- Source: `{session['source_type']}` `{session['source_path']}`",
        f"- Status: `{session['status']}`",
        "",
        "## Counts",
        "",
        "| Item | Count |",
        "|---|---:|",
    ]
    for key, value in counts.items():
        lines.append(f"| {key} | {value} |")

    lines.extend([
        "",
        "## Manual Checklist",
        "",
        "Use this table against `docs/agent-autonomy-benchmark.md`. Related indexes are hints only, not automatic pass/fail.",
        "",
        "| Case | Section | Type | Review | Related findings | Related coverage | Related evidence |",
        "|---|---|---|---|---|---|---|",
    ])
    for case in report["expected_cases"]:
        lines.append(
            "| {id} | {section} | {type} | {review} | {findings} | {coverage} | {evidence} |".format(
                id=case["id"],
                section=case["section"],
                type=case["type"],
                review=case.get("review_status", "manual_review"),
                findings=_join_indexes(case["related_findings"]),
                coverage=_join_indexes(case["related_coverage"]),
                evidence=_join_indexes(case["related_evidence"]),
            )
        )

    _append_items(lines, "Confirmed Findings", report["confirmed_findings"], ["title", "vuln_type", "status", "location", "evidence_ids"])
    _append_items(lines, "Candidate Findings", report["candidate_findings"], ["title", "vuln_type", "status", "location", "evidence_ids"])
    _append_items(lines, "Coverage", report["coverage"], ["endpoint", "parameter", "vuln_type", "status", "evidence_ids"])
    _append_items(lines, "Attack Surface", report["attack_surface"], ["kind", "method", "url", "parameters", "evidence_ids"])
    _append_items(lines, "Evidence", report["evidence"], ["evidence_id", "type", "source_tool", "summary"])

    hints = report["audit_hints"]
    lines.extend([
        "",
        "## Audit Hints",
        "",
        f"- Duplicate adjacent tool actions: `{hints['duplicate_adjacent_tool_actions']}`",
        f"- Manual approval mentions: `{hints['manual_approval_mentions']}`",
        f"- Confirmed findings without evidence: `{', '.join(hints['confirmed_without_evidence']) or 'none'}`",
        "",
    ])
    return "\n".join(lines)


def _read_json(tar: tarfile.TarFile, members: dict[str, tarfile.TarInfo], name: str, default: Any) -> Any:
    member = members.get(name)
    if not member:
        return default
    extracted = tar.extractfile(member)
    if extracted is None:
        return default
    return json.loads(extracted.read().decode("utf-8"))


def _read_jsonl(tar: tarfile.TarFile, members: dict[str, tarfile.TarInfo], name: str) -> list[dict[str, Any]]:
    member = members.get(name)
    if not member:
        return []
    extracted = tar.extractfile(member)
    if extracted is None:
        return []
    rows = []
    for line in extracted.read().decode("utf-8").splitlines():
        if line.strip():
            item = json.loads(line)
            if isinstance(item, dict):
                rows.append(item)
    return rows


def _checkpoint_evidence_rows(checkpoint: dict[str, Any]) -> list[dict[str, Any]]:
    rows = checkpoint.get("evidence")
    if isinstance(rows, list):
        return [row for row in rows if isinstance(row, dict)]
    evidence_ids: set[str] = set()
    for key in ("confirmed_findings", "candidate_findings", "coverage", "attack_surface"):
        for item in checkpoint.get(key) or []:
            if isinstance(item, dict):
                evidence_ids.update(str(eid) for eid in item.get("evidence_ids") or [] if str(eid).strip())
    for item in checkpoint.get("history") or []:
        if isinstance(item, dict) and item.get("evidence_id"):
            evidence_ids.add(str(item["evidence_id"]))
    return [{"evidence_id": eid, "summary": ""} for eid in sorted(evidence_ids)]


def _finding_summary(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(item.get("id") or item.get("finding_id") or ""),
        "title": str(item.get("title") or "Untitled finding"),
        "vuln_type": str(item.get("vuln_type") or item.get("category") or item.get("type") or ""),
        "severity": str(item.get("severity") or ""),
        "status": str(item.get("status") or ""),
        "location": str(item.get("location") or item.get("target_url") or item.get("affected_asset") or item.get("asset") or ""),
        "evidence_ids": [str(eid) for eid in item.get("evidence_ids") or []],
        "summary": _clip(str(item.get("summary") or item.get("description") or item.get("impact") or "")),
    }


def _coverage_summary(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "coverage_id": str(item.get("coverage_id") or ""),
        "endpoint": str(item.get("endpoint") or ""),
        "parameter": str(item.get("parameter") or ""),
        "vuln_type": str(item.get("vuln_type") or ""),
        "status": str(item.get("status") or ""),
        "evidence_ids": [str(eid) for eid in item.get("evidence_ids") or []],
        "notes": _clip(str(item.get("notes") or "")),
    }


def _surface_summary(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "surface_id": str(item.get("surface_id") or item.get("id") or ""),
        "kind": str(item.get("kind") or item.get("type") or ""),
        "method": str(item.get("method") or ""),
        "url": str(item.get("url") or item.get("address") or ""),
        "parameters": [str(param) for param in item.get("parameters") or []],
        "evidence_ids": [str(eid) for eid in item.get("evidence_ids") or []],
    }


def _evidence_summary(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "evidence_id": str(item.get("evidence_id") or item.get("id") or ""),
        "type": str(item.get("evidence_type") or item.get("type") or ""),
        "source_tool": str(item.get("source_tool") or ""),
        "summary": _clip(str(item.get("summary") or item.get("raw_ref") or "")),
    }


def _related_indexes(case: dict[str, str], items: list[dict[str, Any]]) -> list[int]:
    tokens = _case_tokens(case)
    related = []
    for index, item in enumerate(items, start=1):
        haystack = json.dumps(item, ensure_ascii=False).lower()
        if any(token in haystack for token in tokens):
            related.append(index)
    return related[:8]


def _case_tokens(case: dict[str, str]) -> set[str]:
    raw = " ".join([case.get("id", ""), case.get("target_ability", ""), case.get("hit_standard", "")]).lower()
    tokens = {token for token in re.split(r"[^a-z0-9_]+", raw) if len(token) >= 3}
    aliases = {
        "sqli": {"sql", "injection", "sql_injection"},
        "xss": {"cross", "script", "payload"},
        "auth": {"login", "cookie", "session", "jwt"},
        "session": {"cookie", "jwt", "login"},
        "info": {"disclosure", "sensitive", "config"},
        "idor": {"access", "control", "authorization", "user"},
        "api": {"rest", "graphql", "endpoint"},
    }
    for token in list(tokens):
        tokens.update(aliases.get(token, set()))
    return tokens


def _duplicate_actions(checkpoint: dict[str, Any]) -> int:
    state = checkpoint.get("state") if isinstance(checkpoint.get("state"), dict) else {}
    runs = state.get("recent_tool_runs") or []
    duplicates = 0
    previous = None
    for run in runs:
        if not isinstance(run, dict):
            continue
        current = (run.get("tool_name"), run.get("status"))
        if current == previous:
            duplicates += 1
        previous = current
    return duplicates


def _approval_mentions(history: list[dict[str, Any]]) -> int:
    count = 0
    for item in history:
        content = item.get("content")
        text = json.dumps(content, ensure_ascii=False) if isinstance(content, (dict, list)) else str(content or item)
        if "approval" in text.lower() or "authorize" in text.lower() or "授权" in text:
            count += 1
    return count


def _is_confirmed(item: dict[str, Any]) -> bool:
    return str(item.get("status") or "confirmed").lower() in {"confirmed", "done", "verified"}


def _clip(value: str, limit: int = 500) -> str:
    value = " ".join(str(value or "").split())
    return value if len(value) <= limit else value[: limit - 3] + "..."


def _append_items(lines: list[str], title: str, items: list[dict[str, Any]], fields: list[str]) -> None:
    lines.extend(["", f"## {title}", ""])
    if not items:
        lines.append("_None_")
        return
    for index, item in enumerate(items, start=1):
        lines.append(f"### {index}. {_clip(str(item.get('title') or item.get('endpoint') or item.get('url') or item.get('evidence_id') or item.get('id') or 'item'), 120)}")
        for field in fields:
            value = item.get(field)
            if isinstance(value, list):
                value = ", ".join(str(v) for v in value) or "none"
            lines.append(f"- {field}: `{_clip(str(value or ''), 300)}`")
        if item.get("summary"):
            lines.append(f"- summary: {_clip(str(item['summary']), 500)}")
        if item.get("notes"):
            lines.append(f"- notes: {_clip(str(item['notes']), 500)}")


def _join_indexes(values: list[int]) -> str:
    return ", ".join(str(value) for value in values) if values else "-"


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Build offline Agent benchmark reports for manual review")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--checkpoint", help="Path to checkpoint JSON or platform snapshot JSON")
    source.add_argument("--report", help="Path to standalone report.tar.gz")
    parser.add_argument("--answers", default=str(DEFAULT_ANSWERS), help="Markdown answer key. Defaults to docs/agent-autonomy-benchmark.md")
    parser.add_argument("--output-dir", default=".", help="Directory for benchmark-report.json and benchmark-report.md")
    parser.add_argument("--review", help="Optional manual review JSON with hits/cases statuses to compute the 80% score")
    parser.add_argument("--require-passing-score", action="store_true", help="Exit non-zero unless --review yields a passing score")
    parser.add_argument("--write-review-template", action="store_true", help="Write benchmark-review-template.json for manual P0/P1 scoring")
    parser.add_argument("--print-json", action="store_true", help="Print report JSON to stdout")
    args = parser.parse_args(argv)

    answers = load_answers(Path(args.answers))
    facts = load_report_file(Path(args.report)) if args.report else load_checkpoint_file(Path(args.checkpoint))
    report = build_report(facts, answers, load_review(Path(args.review)) if args.review else None)
    json_path, md_path = write_reports(report, Path(args.output_dir), write_review_template=args.write_review_template)
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"Wrote {json_path}")
        print(f"Wrote {md_path}")
    if args.require_passing_score:
        score = report.get("score")
        if not score:
            print("TASK-042 score gate failed: --review is required", file=sys.stderr)
            return 2
        if not score.get("passed"):
            print(f"TASK-042 score gate failed: {score.get('percent')}% < {score.get('target_percent')}%", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
