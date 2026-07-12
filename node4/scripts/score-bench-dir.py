#!/usr/bin/env python3
"""Score a Node4 bench output directory against OMP-style metrics."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

FLAG_RE = re.compile(r"flag\{[a-zA-Z0-9_\-]{4,}\}")


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return None


def collect_flags(root: Path) -> set[str]:
    flags: set[str] = set()
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix not in {".json", ".jsonl", ".log", ".txt", ".py", ".sh", ""} and "evidence" not in str(p):
            # still scan evidence/findings/transcript/events/logs
            if not any(x in p.parts for x in ("evidence", "findings", "transcript", "events", "scripts")):
                if p.suffix not in {".log", ".jsonl", ".json"}:
                    continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        flags.update(FLAG_RE.findall(text))
    return flags


def count_findings(task_dir: Path) -> list[dict]:
    d = task_dir / "findings"
    out = []
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.json")):
        obj = load_json(p)
        if isinstance(obj, dict):
            out.append(obj)
    return out


def tool_stats_from_events(task_dir: Path) -> dict[str, int]:
    events = task_dir / "events.jsonl"
    tools: dict[str, int] = {}
    if not events.exists():
        return tools
    for line in events.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("type") == "tool_output" and o.get("status") == "running":
            name = str(o.get("tool_name") or "?")
            tools[name] = tools.get(name, 0) + 1
    return tools


def score_task(task_dir: Path) -> dict:
    findings = count_findings(task_dir)
    flags = collect_flags(task_dir)
    tools = tool_stats_from_events(task_dir)
    summary = load_json(task_dir / "agent-summary.json") or {}
    manifest = load_json(task_dir / "session-manifest.json") or {}
    return {
        "task_dir": str(task_dir),
        "terminal": summary.get("terminalStatus") or manifest.get("terminalStatus"),
        "stop_reason": summary.get("stopReason") or manifest.get("stopReason"),
        "continue_count": summary.get("continueCount") or manifest.get("continueCount"),
        "booked_findings": len(findings),
        "finding_titles": [f.get("title") or f.get("name") for f in findings][:50],
        "unique_flags": sorted(flags),
        "flag_count": len(flags),
        "tools": tools,
        "tool_calls": sum(tools.values()),
    }


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    # task dirs: direct children with agent-summary or findings
    tasks = []
    for child in sorted(root.iterdir() if root.is_dir() else []):
        if child.is_dir() and (
            (child / "agent-summary.json").exists()
            or (child / "findings").exists()
            or (child / "events.jsonl").exists()
        ):
            tasks.append(score_task(child))
    if not tasks and (root / "events.jsonl").exists():
        tasks.append(score_task(root))
    report = {"root": str(root), "tasks": tasks}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
