#!/usr/bin/env python3
"""Score a live DVWA Node4 run against evidence-quality-plan (book-time evidence model)."""
from __future__ import annotations

import json
import sys
from pathlib import Path


def hollow(props: dict) -> bool:
    if not isinstance(props, dict) or not props:
        return True
    for key in (
        "stdout",
        "excerpt",
        "body_preview",
        "response_body",
        "preview",
        "path",
        "path_or_url",
        "url",
        "location",
        "command",
        "observation",
        "proof",
        "text",
        "html",
    ):
        v = props.get(key)
        if isinstance(v, str) and v.strip():
            return False
    proof = props.get("proof")
    if isinstance(proof, dict):
        for key in ("stdout_excerpt", "body_excerpt", "observation"):
            v = proof.get(key)
            if isinstance(v, str) and v.strip():
                return False
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: score-dvwa-evidence.py <run_dir>", file=sys.stderr)
        return 2
    run = Path(sys.argv[1])
    msgs_path = run / "platform-messages.json"
    if not msgs_path.exists():
        candidates = list(run.rglob("platform-messages.json"))
        if not candidates:
            print(f"no platform-messages.json under {run}", file=sys.stderr)
            return 2
        msgs_path = candidates[0]
        run = msgs_path.parent

    msgs = json.loads(msgs_path.read_text(encoding="utf-8"))
    evidence = [m for m in msgs if m.get("type") == "evidence_created"]
    vulns = [m for m in msgs if m.get("type") == "vuln_found"]

    local_ev = list(run.rglob("evidence/ev_*.json"))
    findings = list(run.rglob("findings/f_*.json"))

    # Book-time model: product evidence is typically source_tool=finding / kind=proof.
    # Act tools no longer flood Case (legacy runs may still have shell/http rows).
    act_tools = {"http", "shell", "write", "script", "session", "browser", "captcha"}
    act = [m for m in evidence if str(m.get("source_tool") or "").lower() in act_tools]
    booked = [
        m
        for m in evidence
        if str(m.get("source_tool") or "").lower() == "finding"
        or str((m.get("properties") or {}).get("kind") or "") == "proof"
    ]
    act_proof = [
        m for m in act if str((m.get("properties") or {}).get("role") or "proof") == "proof"
    ]
    act_hollow = [m for m in act if hollow(m.get("properties") or {})]
    act_proof_hollow = [m for m in act_proof if hollow(m.get("properties") or {})]
    booked_hollow = [m for m in booked if hollow(m.get("properties") or {})]
    proof = [m for m in evidence if (m.get("properties") or {}).get("role") == "proof"]
    with_excerpt = [
        m
        for m in evidence
        if str(
            (m.get("properties") or {}).get("excerpt")
            or (m.get("properties") or {}).get("observation")
            or (m.get("properties") or {}).get("proof")
            or ""
        ).strip()
    ]
    file_mat = [
        m
        for m in evidence
        if str((m.get("properties") or {}).get("kind") or "") in {"file", "source_excerpt"}
        or m.get("evidence_type") == "file_artifact"
    ]

    linked_ids: set[str] = set()
    for v in vulns:
        for eid in v.get("evidence_ids") or []:
            linked_ids.add(str(eid))

    by_id = {str(m.get("evidence_id")): m for m in evidence}
    linked_hollow = 0
    linked_ok = 0
    for eid in linked_ids:
        m = by_id.get(eid)
        if not m:
            continue
        if hollow(m.get("properties") or {}):
            linked_hollow += 1
        else:
            linked_ok += 1

    orphan = len({str(m.get("evidence_id")) for m in evidence} - linked_ids)
    orphan_pct = (100.0 * orphan / len(evidence)) if evidence else 0.0

    snippets = []
    payload: dict = {}
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "platform" / "backend"))
        from app.services.case_context import build_case_context_payload

        rows = [
            {
                "evidence_id": m.get("evidence_id"),
                "summary": m.get("summary"),
                "source_tool": m.get("source_tool"),
                "type": m.get("evidence_type"),
                "properties": m.get("properties") or {},
            }
            for m in evidence
        ]
        findings_in = []
        for v in vulns:
            desc = str(v.get("description") or "")
            pe = v.get("proof_excerpts") or []
            if pe:
                desc += "\n\n[Proof]\n" + "\n---\n".join(
                    str(x.get("excerpt") or "")[:700] for x in pe if isinstance(x, dict)
                )
            elif v.get("proof"):
                desc += "\n\n[Proof]\n" + str(v.get("proof"))[:700]
            findings_in.append(
                {
                    "id": str(v.get("id") or v.get("title") or ""),
                    "title": v.get("title"),
                    "severity": v.get("severity"),
                    "status": v.get("status"),
                    "location": v.get("location") or v.get("url"),
                    "description": desc,
                    "evidence_ids": v.get("evidence_ids") or [],
                }
            )
        payload = build_case_context_payload(
            messages=[],
            findings=findings_in,
            evidence_rows=rows,
            conversation_id="live-dvwa",
        )
        snippets = payload.get("evidence_snippets") or []
        (run / "case_context_payload.json").write_text(
            json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    except Exception as e:
        payload = {"error": str(e)}

    book_time_mode = len(booked) >= len(vulns) > 0 and len(act) == 0

    checks = {
        # Book-time: Case proof rows non-hollow (replaces act-tool Case flood checks).
        "B.booked_proof_non_hollow": (len(booked) > 0 and len(booked_hollow) == 0)
        or (len(act_proof) > 0 and len(act_proof_hollow) == 0),
        "B.has_evidence_created": len(evidence) > 0,
        "B.findings_have_evidence_ids": all(bool(v.get("evidence_ids")) for v in vulns) if vulns else False,
        "B.findings_have_proof_excerpts": all(
            bool(v.get("proof_excerpts") or v.get("evidence_summary") or v.get("proof")) for v in vulns
        )
        if vulns
        else False,
        "B.linked_evidence_readable": linked_ok > 0 and linked_hollow == 0,
        "B.orphan_low_when_book_time": (orphan_pct <= 15.0) if book_time_mode or len(booked) >= len(vulns) > 0 else True,
        "C.file_or_source_material_optional": True,
        "D.proof_role_present": len(proof) > 0 or len(booked) > 0,
        "D.excerpts_present": len(with_excerpt) > 0,
        "D.trace_empty_not_in_snippets": not any(
            str(s.get("role") or "") == "trace" and not (s.get("excerpt") or s.get("path_or_url"))
            for s in snippets
        ),
        "E.case_context_snippets": len(snippets) > 0 if isinstance(payload, dict) and "error" not in payload else False,
        "E.snippet_has_path_or_excerpt": all(s.get("excerpt") or s.get("path_or_url") for s in snippets)
        if snippets
        else False,
        # Legacy labels kept for older reports (act Case rows optional under book-time).
        "B.act_proof_properties_non_hollow": (len(act_proof) == 0 and len(booked) > 0)
        or (len(act_proof) > 0 and len(act_proof_hollow) == 0),
        "B.act_properties_non_hollow": (len(act) == 0) or (len(act_hollow) == 0),
    }
    if file_mat:
        checks["C.file_or_source_material_optional"] = any(
            not hollow(m.get("properties") or {}) for m in file_mat
        )

    report = {
        "run": str(run),
        "model": "book_time" if book_time_mode else "legacy_or_mixed",
        "counts": {
            "evidence_created": len(evidence),
            "booked_evidence": len(booked),
            "booked_hollow": len(booked_hollow),
            "act_evidence": len(act),
            "act_hollow": len(act_hollow),
            "act_proof": len(act_proof),
            "act_proof_hollow": len(act_proof_hollow),
            "proof_role": len(proof),
            "with_excerpt": len(with_excerpt),
            "vuln_found": len(vulns),
            "linked_ids": len(linked_ids),
            "linked_readable": linked_ok,
            "linked_hollow": linked_hollow,
            "orphan": orphan,
            "orphan_pct": round(orphan_pct, 2),
            "file_material": len(file_mat),
            "local_evidence_files": len(local_ev),
            "local_findings": len(findings),
            "case_snippets": len(snippets),
        },
        "checks": checks,
        "sample_evidence": [
            {
                "id": m.get("evidence_id"),
                "tool": m.get("source_tool"),
                "role": (m.get("properties") or {}).get("role"),
                "kind": (m.get("properties") or {}).get("kind"),
                "path_or_url": (m.get("properties") or {}).get("path_or_url")
                or (m.get("properties") or {}).get("path")
                or (m.get("properties") or {}).get("location")
                or (m.get("properties") or {}).get("url"),
                "excerpt_len": len(
                    str(
                        (m.get("properties") or {}).get("excerpt")
                        or (m.get("properties") or {}).get("observation")
                        or ""
                    )
                ),
                "hollow": hollow(m.get("properties") or {}),
                "summary": str(m.get("summary") or "")[:120],
            }
            for m in evidence[:20]
        ],
        "findings": [
            {
                "title": v.get("title"),
                "evidence_ids": v.get("evidence_ids"),
                "proof_excerpts_n": len(v.get("proof_excerpts") or []),
                "has_proof_field": bool(v.get("proof")),
            }
            for v in vulns
        ],
    }

    report["vs_phase_A"] = {
        "case_properties_with_stdout_or_body_was": "~0%",
        "booked_hollow_now": f"{len(booked_hollow)}/{len(booked)}",
        "act_case_rows_now": f"{len(act)} (0 expected under book-time)",
        "linked_readable_now": f"{linked_ok}/{len(linked_ids)}",
        "orphan_pct_now": f"{orphan_pct:.1f}%",
    }

    required = [
        "B.booked_proof_non_hollow",
        "B.has_evidence_created",
        "D.excerpts_present",
    ]
    if vulns:
        required.extend(
            [
                "B.findings_have_evidence_ids",
                "B.findings_have_proof_excerpts",
                "B.linked_evidence_readable",
                "B.orphan_low_when_book_time",
            ]
        )
    if isinstance(payload, dict) and "error" not in payload:
        required.append("E.case_context_snippets")

    failed = [k for k in required if not checks.get(k)]
    report["required"] = required
    report["failed"] = failed
    report["pass"] = len(failed) == 0

    out_path = run / "evidence-plan-score.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    md = [
        "# DVWA live evidence score",
        f"run: `{run}`",
        f"model: **{report['model']}**",
        f"**PASS={report['pass']}**",
        "",
        "## Counts",
    ]
    for k, v in report["counts"].items():
        md.append(f"- {k}: {v}")
    md.append("")
    md.append("## Checks")
    for k, v in checks.items():
        md.append(f"- [{'x' if v else ' '}] {k}")
    if failed:
        md.append("")
        md.append("## Failed required")
        for k in failed:
            md.append(f"- {k}")
    md.append("")
    md.append("## Findings")
    for f in report["findings"]:
        md.append(f"- {f['title']} eids={f['evidence_ids']} proof_n={f['proof_excerpts_n']}")
    (run / "evidence-plan-score.md").write_text("\n".join(md) + "\n", encoding="utf-8")

    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"\nWrote {out_path}")
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
