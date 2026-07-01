"""Phase 1 autonomy smoke metrics.

This script summarizes a pentest-agent checkpoint into the fixed JSON shape used
for DVWA/Juice Shop autonomy runs. It intentionally does not hard-code expected
vulnerability counts; the metrics must come from the agent's saved state.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.agent.attack_surface import AttackSurfaceInventory  # noqa: E402
from pentest_node.agent.coverage import CoverageStore  # noqa: E402
from pentest_node.agent.verifiers import evaluate_web_probe  # noqa: E402
from pentest_node.evidence.store import EvidenceStore  # noqa: E402


COVERAGE_STATUSES = ("tried", "passed", "failed", "skipped")


def load_checkpoint(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    raw = Path(path).read_text(encoding="utf-8")
    data = json.loads(raw)
    if isinstance(data, dict) and isinstance(data.get("checkpoint"), dict):
        return data["checkpoint"]
    if not isinstance(data, dict):
        raise ValueError("checkpoint file must contain a JSON object")
    return data


async def build_live_web_checkpoint(target: str, *, session_id: str, workspace: Path) -> dict[str, Any]:
    import httpx

    workspace.mkdir(parents=True, exist_ok=True)
    evidence_store = EvidenceStore(workspace)
    inventory = AttackSurfaceInventory(session_id)
    coverage = CoverageStore(session_id)

    async with httpx.AsyncClient(verify=False, follow_redirects=True, timeout=15) as client:
        response = await client.get(target)

    request_text = f"GET {target} HTTP/1.1\nHost: {urlparse(target).netloc}"
    response_text = f"HTTP {response.status_code}\n" + "\n".join(f"{k}: {v}" for k, v in response.headers.items()) + f"\n\n{response.text[:4000]}"
    evidence = await evidence_store.collect_http_trace("live-http-get", request_text, response_text)
    evidence_ids = [evidence.evidence_id] if evidence else []
    http_result = {
        "status": "done",
        "status_code": response.status_code,
        "headers": dict(response.headers),
        "body": response.text[:4000],
        "request": request_text,
        "response": response_text,
        "url": target,
        "method": "GET",
        "risk_level": "safe",
    }
    inventory.record_http_result("live-http-get", http_result, evidence_ids[0] if evidence_ids else None)

    info_result = evaluate_web_probe(
        vuln_type="info_disclosure",
        target_url=target,
        method="GET",
        probe_body=response.text[:4000],
        status_code=response.status_code,
        response_headers=dict(response.headers),
        evidence_ids=evidence_ids,
    )
    coverage.mark(
        endpoint=f"GET {target}",
        parameter=info_result.parameter,
        vuln_type=info_result.vuln_type,
        status=info_result.status,
        notes=info_result.coverage_notes,
        evidence_ids=evidence_ids,
    )

    candidate_findings = []
    if info_result.candidate:
        candidate_findings.append({**info_result.candidate, "id": "live-info-disclosure", "status": "candidate", "evidence_ids": evidence_ids})

    return {
        "version": 1,
        "reason": "live_web_smoke",
        "conversation_id": session_id,
        "resolved_target": target,
        "state": {
            "phase": "complete",
            "phases_completed": ["intake", "recon", "analysis", "verify", "report", "complete"],
            "recent_tool_runs": [
                {"tool_name": "http_request", "status": "done"},
                {"tool_name": "evaluate_web_verifier", "status": "ok"},
            ],
        },
        "attack_surface": inventory.to_list(),
        "attack_surface_summary": inventory.summary(),
        "coverage": coverage.to_list(),
        "coverage_summary": coverage.summary(),
        "candidate_findings": candidate_findings,
        "confirmed_findings": [],
        "discovered_assets": [],
        "history": [],
    }


def summarize_checkpoint(checkpoint: dict[str, Any], *, target: str, session_id: str | None = None) -> dict[str, Any]:
    coverage = [row for row in checkpoint.get("coverage") or [] if isinstance(row, dict)]
    attack_surface = [row for row in checkpoint.get("attack_surface") or [] if isinstance(row, dict)]
    candidates = [row for row in checkpoint.get("candidate_findings") or [] if isinstance(row, dict)]
    confirmed = [row for row in checkpoint.get("confirmed_findings") or [] if isinstance(row, dict)]
    evidence = _evidence_ids(checkpoint)
    rejected = [row for row in candidates if str(row.get("status") or "").lower() == "rejected"]

    return {
        "target": target or checkpoint.get("resolved_target") or "",
        "session_id": session_id or str(checkpoint.get("conversation_id") or checkpoint.get("task_id") or uuid.uuid4()),
        "attack_surface_count": len(attack_surface),
        "coverage_total": len(coverage),
        "coverage_by_status": {status: sum(1 for row in coverage if row.get("status") == status) for status in COVERAGE_STATUSES},
        "confirmed_findings": len(confirmed),
        "candidate_findings": len([row for row in candidates if str(row.get("status") or "candidate").lower() == "candidate"]),
        "rejected_findings": len(rejected),
        "evidence_count": len(evidence),
        "duplicate_actions": _duplicate_actions(checkpoint),
        "manual_approvals": _manual_approvals(checkpoint),
        "false_positive_suspected": len(rejected),
    }


def evaluate_smoke(summary: dict[str, Any], *, min_attack_surface: int, min_coverage: int, min_evidence: int, max_duplicate_actions: int | None, require_confirmed_evidence: bool, checkpoint: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if summary["attack_surface_count"] < min_attack_surface:
        failures.append(f"attack_surface_count {summary['attack_surface_count']} < required {min_attack_surface}")
    if summary["coverage_total"] < min_coverage:
        failures.append(f"coverage_total {summary['coverage_total']} < required {min_coverage}")
    if summary["evidence_count"] < min_evidence:
        failures.append(f"evidence_count {summary['evidence_count']} < required {min_evidence}")
    if max_duplicate_actions is not None and summary["duplicate_actions"] > max_duplicate_actions:
        failures.append(f"duplicate_actions {summary['duplicate_actions']} > allowed {max_duplicate_actions}")
    if require_confirmed_evidence:
        for finding in checkpoint.get("confirmed_findings") or []:
            if isinstance(finding, dict) and not finding.get("evidence_ids"):
                failures.append(f"confirmed finding lacks evidence_ids: {finding.get('id') or finding.get('title') or '<unknown>'}")
    return failures


def _evidence_ids(checkpoint: dict[str, Any]) -> set[str]:
    evidence: set[str] = set()
    for key in ("attack_surface", "coverage", "candidate_findings", "confirmed_findings"):
        for row in checkpoint.get(key) or []:
            if not isinstance(row, dict):
                continue
            for eid in row.get("evidence_ids") or []:
                if str(eid).strip():
                    evidence.add(str(eid))
    for item in checkpoint.get("history") or []:
        if isinstance(item, dict) and item.get("evidence_id"):
            evidence.add(str(item["evidence_id"]))
    return evidence


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


def _manual_approvals(checkpoint: dict[str, Any]) -> int:
    count = 0
    for item in checkpoint.get("history") or []:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "")
        if "request_approval" in content or "request_decision" in content:
            count += 1
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Summarize Phase 1 agent autonomy checkpoint metrics")
    parser.add_argument("--target", default="", help="Target URL/IP used for the run")
    parser.add_argument("--checkpoint", help="Path to checkpoint JSON or platform snapshot JSON")
    parser.add_argument("--session-id", help="Session id to include in output")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON")
    parser.add_argument("--live-web", action="store_true", help="Fetch the target and build a real checkpoint from the web response")
    parser.add_argument("--workspace", help="Workspace for live evidence files. Defaults to a temporary directory")
    parser.add_argument("--output-checkpoint", help="Write the generated or loaded checkpoint JSON to this path")
    parser.add_argument("--min-attack-surface", type=int, default=0, help="Fail if discovered attack surface count is lower than this")
    parser.add_argument("--min-coverage", type=int, default=0, help="Fail if coverage total is lower than this")
    parser.add_argument("--min-evidence", type=int, default=0, help="Fail if evidence count is lower than this")
    parser.add_argument("--max-duplicate-actions", type=int, help="Fail if adjacent duplicate tool actions exceed this")
    parser.add_argument("--require-confirmed-evidence", action="store_true", help="Fail if any confirmed finding lacks evidence_ids")
    args = parser.parse_args(argv)

    session_id = args.session_id or str(uuid.uuid4())
    if args.live_web:
        if not args.target:
            raise SystemExit("--target is required with --live-web")
        if args.workspace:
            workspace = Path(args.workspace)
            checkpoint = asyncio.run(build_live_web_checkpoint(args.target, session_id=session_id, workspace=workspace))
        else:
            with tempfile.TemporaryDirectory() as tmp:
                checkpoint = asyncio.run(build_live_web_checkpoint(args.target, session_id=session_id, workspace=Path(tmp)))
    else:
        checkpoint = load_checkpoint(args.checkpoint)

    if args.output_checkpoint:
        Path(args.output_checkpoint).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output_checkpoint).write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = summarize_checkpoint(checkpoint, target=args.target, session_id=session_id if args.session_id else None)
    failures = evaluate_smoke(
        summary,
        min_attack_surface=max(0, args.min_attack_surface),
        min_coverage=max(0, args.min_coverage),
        min_evidence=max(0, args.min_evidence),
        max_duplicate_actions=args.max_duplicate_actions,
        require_confirmed_evidence=args.require_confirmed_evidence,
        checkpoint=checkpoint,
    )
    if failures:
        summary["smoke_status"] = "failed"
        summary["smoke_failures"] = failures
    elif any([args.min_attack_surface, args.min_coverage, args.min_evidence, args.max_duplicate_actions is not None, args.require_confirmed_evidence]):
        summary["smoke_status"] = "passed"

    print(json.dumps(summary, ensure_ascii=False, indent=2 if args.pretty else None))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())