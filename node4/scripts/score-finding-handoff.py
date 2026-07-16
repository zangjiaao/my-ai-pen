#!/usr/bin/env python3
"""
Per-finding handoff quality for multi-expert collab.

Scores each finding on:
- location clarity (module path / URL)
- evidence support (linked, non-hollow, location-related)
- discovery process (poc steps + observation)
- next-expert usability (paths/excerpts a code-audit or retest expert can use)
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


def hollow(props: dict | None) -> bool:
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
    return True


def location_tokens(location: str) -> list[str]:
    raw = (location or "").strip()
    out: list[str] = []
    try:
        if re.match(r"^https?://", raw, re.I):
            u = urlparse(raw)
            if u.pathname and u.pathname != "/":
                out.append(u.pathname)
            for part in u.pathname.split("/"):
                if len(part) >= 4:
                    out.append(part)
    except Exception:
        pass
    for part in re.split(r"[/?#&\s=]+", raw):
        p = part.strip().strip("/")
        if len(p) >= 4 and not re.match(r"^https?:$", p, re.I):
            out.append(p)
    # unique preserve order
    seen = set()
    res = []
    for t in out:
        k = t.lower()
        if k not in seen:
            seen.add(k)
            res.append(t)
    return res[:12]


def excerpt_supports_location(excerpt: str, location: str) -> bool:
    tokens = location_tokens(location)
    if not tokens:
        return True
    hay = (excerpt or "").lower()
    return any(t.lower() in hay for t in tokens)


def poc_has_process(poc: str) -> dict:
    text = poc or ""
    has_steps = bool(re.search(r"(?m)^\s*\d+[\).\]]\s+\S", text)) or text.count("\n") >= 1
    has_action = bool(
        re.search(
            r"\b(get|post|put|curl|http|payload|inject|upload|request|login|write|cat|probe|visit|open|browse|submit|fetch|access)\b",
            text,
            re.I,
        )
        or re.search(r"https?://", text, re.I)
        or re.search(r"/vulnerabilities/[\w-]+", text, re.I)
    )
    has_obs = bool(
        re.search(
            r"\b(status|response|stdout|output|observed|returned|returns?|body|error|reflected|executed|preview|shows?|includes?)\b",
            text,
            re.I,
        )
        or re.search(r"(→|->|=>)", text)
        or re.search(r"\b\d{3}\b", text)
    )
    return {
        "has_steps_or_multiline": has_steps,
        "has_action": has_action,
        "has_observation": has_obs,
        "ok": has_action and has_obs and len(text.strip()) >= 40,
    }


def score_finding(v: dict, evidence_by_id: dict[str, dict]) -> dict:
    title = str(v.get("title") or "")
    location = str(v.get("location") or v.get("url") or "")
    poc = str(v.get("poc") or "")
    desc = str(v.get("description") or "")
    eids = [str(x) for x in (v.get("evidence_ids") or []) if x]
    pe = v.get("proof_excerpts") or []
    if not isinstance(pe, list):
        pe = []

    loc_ok = bool(location) and (
        "vulnerabilities/" in location
        or location.startswith("http")
        or location.startswith("/")
    )
    module = None
    m = re.search(r"vulnerabilities/([a-z0-9_]+)", location, re.I)
    if m:
        module = m.group(1)

    linked = []
    any_loc_support = False
    any_non_hollow = False
    material_paths = []
    for eid in eids:
        row = evidence_by_id.get(eid) or {}
        props = row.get("properties") if isinstance(row.get("properties"), dict) else {}
        # also accept nested from message shape
        if not props and isinstance(row.get("data"), dict):
            props = row["data"]
        excerpt = str(
            props.get("excerpt")
            or props.get("observation")
            or (props.get("proof") if isinstance(props.get("proof"), str) else "")
            or props.get("stdout")
            or props.get("body_preview")
            or props.get("preview")
            or ""
        )
        # proof_excerpts / proof field on finding
        for item in pe:
            if isinstance(item, dict) and str(item.get("evidence_id")) == eid:
                excerpt = excerpt or str(item.get("excerpt") or "")
        if not excerpt.strip():
            excerpt = str(v.get("proof") or "")
        is_hollow = hollow(props) and len(excerpt.strip()) < 8
        supports = excerpt_supports_location(excerpt, location) or excerpt_supports_location(
            str(
                props.get("path_or_url")
                or props.get("path")
                or props.get("location")
                or props.get("url")
                or ""
            ),
            location,
        )
        if supports:
            any_loc_support = True
        if not is_hollow:
            any_non_hollow = True
        path = str(props.get("path_or_url") or props.get("path") or props.get("url") or "")
        if "source_dump" in path or props.get("kind") in {"file", "source_excerpt"}:
            material_paths.append(path or eid)
        linked.append(
            {
                "evidence_id": eid,
                "tool": row.get("source_tool") or props.get("source_tool"),
                "role": props.get("role"),
                "kind": props.get("kind") or row.get("type") or row.get("evidence_type"),
                "hollow": is_hollow,
                "supports_location": supports,
                "excerpt_len": len(excerpt.strip()),
                "excerpt_preview": excerpt.strip().replace("\n", " ⏎ ")[:220],
                "path_or_url": path[:200] if path else None,
            }
        )

    poc_q = poc_has_process(poc)
    # discovery process: poc quality + proof excerpts present
    has_proof_blob = bool(str(v.get("proof") or "").strip()) or len(pe) > 0 or any(
        x["excerpt_len"] >= 24 for x in linked
    )
    process_ok = poc_q["ok"] and has_proof_blob

    # next expert usability (book-time proof is enough for retest; source dump optional)
    next_expert = {
        "can_see_location": loc_ok,
        "can_see_proof_excerpt": has_proof_blob,
        "can_see_module_path": bool(module),
        "has_material_for_code_audit": len(material_paths) > 0
        or "source_dump" in (poc + desc + json.dumps(linked)).lower()
        or bool(re.search(r"\.(php|java|py|js|jsp)\b", poc + desc + str(v.get("proof") or ""), re.I)),
        "retest_possible_from_poc": poc_q["ok"],
    }
    handoff_ok = (
        next_expert["can_see_location"]
        and next_expert["can_see_proof_excerpt"]
        and next_expert["retest_possible_from_poc"]
        and any_non_hollow
    )

    # numeric score 0-100
    score = 0
    score += 20 if loc_ok else 0
    score += 15 if module else 0
    score += 20 if eids and any_non_hollow else 0
    score += 15 if any_loc_support else 0
    score += 20 if process_ok else 0
    score += 10 if handoff_ok else 0

    grade = "strong" if score >= 75 else "usable" if score >= 55 else "weak"

    return {
        "title": title,
        "location": location,
        "module": module,
        "severity": v.get("severity"),
        "evidence_ids": eids,
        "score": score,
        "grade": grade,
        "location_ok": loc_ok,
        "evidence_non_hollow": any_non_hollow,
        "evidence_supports_location": any_loc_support,
        "discovery_process_ok": process_ok,
        "poc_quality": poc_q,
        "next_expert": next_expert,
        "handoff_ok": handoff_ok,
        "material_paths": material_paths,
        "linked_evidence": linked,
        "poc_preview": poc.replace("\n", " | ")[:280],
        "description_preview": desc.replace("\n", " ")[:200],
    }


def load_run(run: Path) -> tuple[list[dict], dict[str, dict], dict]:
    msgs_path = run / "platform-messages.json"
    msgs = json.loads(msgs_path.read_text(encoding="utf-8")) if msgs_path.exists() else []
    findings = [m for m in msgs if m.get("type") == "vuln_found"]
    evidence_msgs = [m for m in msgs if m.get("type") == "evidence_created"]
    by_id = {str(m.get("evidence_id")): m for m in evidence_msgs}

    # overlay Case API if present (authoritative for properties)
    case_ev = run / "case-evidence-api.json"
    if case_ev.exists():
        for row in json.loads(case_ev.read_text(encoding="utf-8")):
            eid = str(row.get("evidence_id") or "")
            if not eid:
                continue
            by_id[eid] = {
                **(by_id.get(eid) or {}),
                "evidence_id": eid,
                "source_tool": row.get("source_tool"),
                "type": row.get("type"),
                "summary": row.get("summary"),
                "properties": row.get("properties") or {},
            }

    # local findings files
    local_findings = []
    for p in run.rglob("findings/f_*.json"):
        try:
            local_findings.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            pass
    if local_findings and len(local_findings) >= len(findings):
        # prefer local full records
        findings = local_findings

    meta = {}
    if (run / "meta.json").exists():
        meta = json.loads((run / "meta.json").read_text(encoding="utf-8"))
    if (run / "run-result.json").exists():
        meta = {**meta, **json.loads((run / "run-result.json").read_text(encoding="utf-8"))}
    return findings, by_id, meta


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: score-finding-handoff.py <run_dir>", file=sys.stderr)
        return 2
    run = Path(sys.argv[1])
    findings, by_id, meta = load_run(run)
    scored = [score_finding(v, by_id) for v in findings]
    # de-dupe by title
    seen = set()
    uniq = []
    for s in scored:
        k = s["title"].strip().lower()
        if k in seen:
            continue
        seen.add(k)
        uniq.append(s)
    scored = uniq

    modules = sorted({s["module"] for s in scored if s.get("module")})
    strong = sum(1 for s in scored if s["grade"] == "strong")
    usable = sum(1 for s in scored if s["grade"] == "usable")
    weak = sum(1 for s in scored if s["grade"] == "weak")
    handoff = sum(1 for s in scored if s["handoff_ok"])

    # coverage expectation for DVWA low (soft)
    core = {"sqli", "exec", "xss_r"}
    core_hit = core & set(modules)
    count_ok = len(scored) >= 4
    core_ok = len(core_hit) >= 2  # at least 2 of 3 core; ideally 3

    summary = {
        "run": str(run),
        "meta": meta,
        "finding_count": len(scored),
        "modules": modules,
        "core_modules_hit": sorted(core_hit),
        "grades": {"strong": strong, "usable": usable, "weak": weak},
        "handoff_ready_count": handoff,
        "checks": {
            "finding_count_ge_4": count_ok,
            "core_modules_ge_2": core_ok,
            "core_modules_all_3": core_hit == core,
            "handoff_ready_ge_half": handoff >= max(1, len(scored) // 2) if scored else False,
            "all_have_location": all(s["location_ok"] for s in scored) if scored else False,
            "all_have_non_hollow_evidence": all(s["evidence_non_hollow"] for s in scored)
            if scored
            else False,
            "all_discovery_process_ok": all(s["discovery_process_ok"] for s in scored)
            if scored
            else False,
        },
        "findings": scored,
    }
    summary["pass_stable"] = (
        count_ok
        and core_ok
        and summary["checks"]["handoff_ready_ge_half"]
        and summary["checks"]["all_have_location"]
        and summary["checks"]["all_have_non_hollow_evidence"]
    )

    (run / "finding-handoff-score.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    md = [
        "# DVWA finding handoff quality",
        f"run: `{run}`",
        f"conversation: `{meta.get('conversationId') or meta.get('conversation_id') or ''}`",
        f"**stable_pass={summary['pass_stable']}**  findings={len(scored)}  handoff_ready={handoff}",
        f"modules: {', '.join(modules) or '(none)'}",
        f"core hit: {', '.join(sorted(core_hit)) or '(none)'} / sqli,exec,xss_r",
        "",
        "## Checks",
    ]
    for k, v in summary["checks"].items():
        md.append(f"- [{'x' if v else ' '}] {k}")
    md.append("")
    md.append("## Per finding")
    for s in scored:
        md.append(f"### [{s['grade']}/{s['score']}] {s['title']}")
        md.append(f"- location: `{s['location']}` module=`{s.get('module')}`")
        md.append(
            f"- evidence: non_hollow={s['evidence_non_hollow']} supports_location={s['evidence_supports_location']} eids={s['evidence_ids']}"
        )
        md.append(f"- discovery_process_ok={s['discovery_process_ok']} poc={s['poc_quality']}")
        md.append(f"- next_expert={s['next_expert']} handoff_ok={s['handoff_ok']}")
        if s.get("material_paths"):
            md.append(f"- materials: {s['material_paths']}")
        md.append(f"- poc: {s['poc_preview']}")
        for le in s["linked_evidence"]:
            md.append(
                f"  - {le['evidence_id']} tool={le.get('tool')} role={le.get('role')} hollow={le['hollow']} loc_support={le['supports_location']} excerpt_len={le['excerpt_len']}"
            )
            if le.get("excerpt_preview"):
                md.append(f"    excerpt: {le['excerpt_preview']}")
            if le.get("path_or_url"):
                md.append(f"    path: {le['path_or_url']}")
        md.append("")

    (run / "finding-handoff-score.md").write_text("\n".join(md), encoding="utf-8")
    print(json.dumps({k: summary[k] for k in summary if k != "findings"}, indent=2, ensure_ascii=False))
    print("\n--- per finding ---")
    for s in scored:
        print(
            f"[{s['grade']:6} {s['score']:3}] handoff={s['handoff_ok']} loc={s['location_ok']} hollow_ok={s['evidence_non_hollow']} process={s['discovery_process_ok']} | {s['title'][:70]}"
        )
    print(f"\nWrote {run / 'finding-handoff-score.md'}")
    return 0 if summary["pass_stable"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
