#!/usr/bin/env python3
"""
Offline lab scorecard for Spec #139 process professionalism + discovery capability (#164).

Primary seam: Expert Graph Product state (host settlement, Finding Store, close-out).
No agent-facing spoilers or product answer keys. Human/script judgment only.

Usage:
  python3 node4/scripts/score-process-discovery-139.py /path/to/taskDir [--label DVWA|Juice]
  python3 node4/scripts/score-process-discovery-139.py --dual-root node4/workspace/lab-139-dual/STAMP

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


# Keep identical to platform REQUIRED_TOP_KEYS (engagement_closeout.py) + Node EngagementCloseout.
CLOSEOUT_REQUIRED = (
    "scope",
    "target",
    "graphId",
    "terminal",
    "stages",
    "surfaces",
    "findings",
    "priors",
    "feedback",
    "residual_risk",
)


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

    findings_obj = closeout.get("findings") if isinstance(closeout.get("findings"), dict) else {}
    closeout_schema_ok = bool(closeout) and all(k in closeout for k in CLOSEOUT_REQUIRED)
    if closeout_schema_ok:
        closeout_schema_ok = (
            isinstance(closeout.get("stages"), list)
            and isinstance(closeout.get("findings"), dict)
            and isinstance(closeout.get("priors"), dict)
            and isinstance(closeout.get("feedback"), list)
            and isinstance(closeout.get("scope"), dict)
            and isinstance(closeout.get("target"), dict)
            and isinstance(closeout.get("surfaces"), dict)
            and isinstance(findings_obj.get("by_severity"), dict)
        )

    process_complete = closeout.get("process_complete")
    process_complete_honest = True
    if terminal == "blocked":
        process_complete_honest = process_complete is False
    elif terminal == "completed":
        # Explicit True required — missing must not pass as honest.
        process_complete_honest = process_complete is True

    residual_class = closeout.get("residual_class")
    unbooked = findings_obj.get("feedback_ok_unbooked") or []
    residual_class_ok = True
    if terminal == "blocked" and isinstance(unbooked, list) and len(unbooked) > 0:
        residual_class_ok = residual_class == "blocked_with_unbooked_feedback_ok"
    elif residual_class == "blocked_with_unbooked_feedback_ok":
        residual_class_ok = terminal == "blocked" and bool(unbooked)

    feedback_gist = closeout.get("feedback") if isinstance(closeout.get("feedback"), list) else []
    l0_l1_present = bool(feedback_gist) and any(
        isinstance(row, dict) and (row.get("l0") or row.get("l1")) for row in feedback_gist
    )

    checks = {
        "has_run_result": bool(run),
        "has_closeout": bool(closeout),
        "closeout_schema_required_fields": closeout_schema_ok if closeout else False,
        "terminal_present": terminal in ("completed", "blocked", "aborted", "failed"),
        "stages_present": len(stages) > 0,
        "closeout_has_priors": isinstance(closeout.get("priors"), dict),
        "closeout_has_feedback_gist": isinstance(closeout.get("feedback"), list),
        "closeout_l0_l1_gist": l0_l1_present if closeout else False,
        "closeout_has_residual_risk": bool(str(closeout.get("residual_risk") or "").strip()),
        "process_complete_honest": process_complete_honest if closeout else False,
        "residual_class_consistent": residual_class_ok if closeout else False,
        "severity_not_all_medium_collapse": not all_medium if by_sev else True,
        "findings_have_severity_when_booked": all(
            str(f.get("severity") or "").strip() for f in findings
        )
        if findings
        else True,
    }

    process_score = sum(1 for v in checks.values() if v)
    process_total = len(checks)

    discovery_notes = {
        "multi_class_evidence_backed": "human/offline judgment",
        "non_menu_bias_juice": "human/offline judgment" if label.lower().startswith("juice") else "n/a",
        "no_product_answer_keys": True,
        "booked_n": len(findings_obj.get("booked_titles") or [])
        if isinstance(findings_obj.get("booked_titles"), list)
        else len(findings),
        "unbooked_feedback_ok_n": len(unbooked) if isinstance(unbooked, list) else 0,
        "unbookable_n": len(findings_obj.get("unbookable") or [])
        if isinstance(findings_obj.get("unbookable"), list)
        else 0,
    }

    return {
        "label": label,
        "task_dir": str(task_dir),
        "terminal": terminal,
        "process_complete": process_complete,
        "residual_class": residual_class,
        "booking_tail_ran": closeout.get("booking_tail_ran"),
        "severity_counts": by_sev,
        "process_checks": checks,
        "process_score": f"{process_score}/{process_total}",
        "discovery_notes": discovery_notes,
        "prior_n": (closeout.get("priors") or {}).get("prior_n"),
        "booked_titles_sample": (findings_obj.get("booked_titles") or [])[:8],
    }


def print_report(report: dict) -> None:
    print(f"## Spec #139 scorecard — {report['label']}")
    print(f"task_dir: {report['task_dir']}")
    print(f"terminal: {report['terminal']}")
    print(f"process_complete: {report.get('process_complete')}")
    print(f"residual_class: {report.get('residual_class')}")
    print(f"booking_tail_ran: {report.get('booking_tail_ran')}")
    print(f"process_score: {report['process_score']}")
    print(f"severity_counts: {report['severity_counts']}")
    print("checks:")
    for k, v in report["process_checks"].items():
        print(f"  [{'OK' if v else 'FAIL'}] {k}")
    print(f"priors: {report.get('prior_n')}")
    dn = report.get("discovery_notes") or {}
    print(
        f"discovery: booked={dn.get('booked_n')} unbooked_feedback_ok={dn.get('unbooked_feedback_ok_n')} "
        f"unbookable={dn.get('unbookable_n')} (offline human judgment; no product answer keys)"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Score Spec #139 process+discovery Product state (#164)")
    ap.add_argument("task_dir", type=Path, nargs="?", default=None)
    ap.add_argument("--label", default="lab")
    ap.add_argument("--json", action="store_true")
    ap.add_argument(
        "--dual-root",
        type=Path,
        default=None,
        help="Score both arms under a dual-arm stamp dir (expects */lab*/hard-graph or nested taskDirs)",
    )
    args = ap.parse_args()

    if args.dual_root:
        root = args.dual_root
        if not root.is_dir():
            print(f"error: not a directory: {root}", file=sys.stderr)
            return 2
        # find taskDirs containing hard-graph/engagement-closeout.json
        arms = sorted(root.rglob("engagement-closeout.json"))
        if not arms:
            print(f"error: no engagement-closeout.json under {root}", file=sys.stderr)
            return 2
        code = 0
        reports = []
        for co_path in arms:
            task_dir = co_path.parent.parent  # .../taskDir/hard-graph/file
            label = task_dir.name
            if "juice" in label.lower():
                label = "Juice"
            elif "dvwa" in label.lower():
                label = "DVWA"
            report = score_task(task_dir, label)
            reports.append(report)
            if not all(report["process_checks"].values()):
                code = 1
            if args.json:
                print(json.dumps(report, indent=2, ensure_ascii=False))
            else:
                print_report(report)
                print()
        return code

    if not args.task_dir or not args.task_dir.is_dir():
        print("error: task_dir required (or --dual-root)", file=sys.stderr)
        return 2
    report = score_task(args.task_dir, args.label)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print_report(report)
    return 0 if all(report["process_checks"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
