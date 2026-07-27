#!/usr/bin/env python3
"""
Offline lab scorecard for Spec #139 process professionalism + discovery capability.

Primary seam: Expert Graph Product state (host settlement, Finding Store, close-out).
No agent-facing spoilers or product answer keys. Human/script judgment only.

Usage:
  python3 node4/scripts/score-process-discovery-139.py /path/to/taskDir [--label DVWA|Juice]

Expects under taskDir:
  hard-graph/run-result.json
  hard-graph/engagement-closeout.json (preferred)
  findings/*.json (optional)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def score_task(task_dir: Path, label: str) -> dict:
    hg = task_dir / "hard-graph"
    run = load_json(hg / "run-result.json") or {}
    closeout = load_json(hg / "engagement-closeout.json") or {}
    findings_dir = task_dir / "findings"
    findings = []
    if findings_dir.is_dir():
        for p in findings_dir.glob("*.json"):
            row = load_json(p)
            if isinstance(row, dict):
                findings.append(row)

    stages = run.get("stages") or closeout.get("stages") or []
    terminal = run.get("terminal") or closeout.get("terminal") or "unknown"
    by_sev = {}
    for f in findings:
        sev = str(f.get("severity") or "unset").lower()
        by_sev[sev] = by_sev.get(sev, 0) + 1
    if not by_sev and isinstance(closeout.get("findings"), dict):
        by_sev = closeout["findings"].get("by_severity") or {}

    all_medium = (
        sum(by_sev.values()) >= 3
        and by_sev.get("medium", 0) == sum(v for k, v in by_sev.items() if k != "unset")
        and by_sev.get("critical", 0) == 0
        and by_sev.get("high", 0) == 0
    )

    checks = {
        "has_run_result": bool(run),
        "has_closeout": bool(closeout),
        "terminal_present": terminal in ("completed", "blocked", "aborted", "failed"),
        "stages_present": len(stages) > 0,
        "closeout_has_priors": isinstance(closeout.get("priors"), dict),
        "closeout_has_feedback_gist": isinstance(closeout.get("feedback"), list),
        "closeout_has_residual_risk": bool(str(closeout.get("residual_risk") or "").strip()),
        "severity_not_all_medium_collapse": not all_medium if by_sev else True,
        "findings_have_severity_when_booked": all(
            str(f.get("severity") or "").strip() for f in findings
        )
        if findings
        else True,
    }

    process_score = sum(1 for v in checks.values() if v)
    process_total = len(checks)

    # Discovery capability is offline/human — record placeholders only
    discovery_notes = {
        "multi_class_evidence_backed": "human/offline judgment",
        "non_menu_bias_juice": "human/offline judgment" if label.lower().startswith("juice") else "n/a",
        "no_product_answer_keys": True,
    }

    return {
        "label": label,
        "task_dir": str(task_dir),
        "terminal": terminal,
        "severity_counts": by_sev,
        "process_checks": checks,
        "process_score": f"{process_score}/{process_total}",
        "discovery_notes": discovery_notes,
        "prior_n": (closeout.get("priors") or {}).get("prior_n"),
        "booked_titles_sample": (closeout.get("findings") or {}).get("booked_titles", [])[:8],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Score Spec #139 process+discovery Product state")
    ap.add_argument("task_dir", type=Path)
    ap.add_argument("--label", default="lab")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    if not args.task_dir.is_dir():
        print(f"error: not a directory: {args.task_dir}", file=sys.stderr)
        return 2
    report = score_task(args.task_dir, args.label)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"## Spec #139 scorecard — {report['label']}")
        print(f"task_dir: {report['task_dir']}")
        print(f"terminal: {report['terminal']}")
        print(f"process_score: {report['process_score']}")
        print(f"severity_counts: {report['severity_counts']}")
        print("checks:")
        for k, v in report["process_checks"].items():
            print(f"  [{'OK' if v else 'FAIL'}] {k}")
        print(f"priors: {report.get('prior_n')}")
        print("discovery: offline human judgment (no product answer keys)")
    return 0 if all(report["process_checks"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
