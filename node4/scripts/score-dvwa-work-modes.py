#!/usr/bin/env python3
"""Score Free / soft Graph / hard Graph DVWA bench directories.

Usage:
  python3 scripts/score-dvwa-work-modes.py workspace/bench-dvwa-modes/<stamp>
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ACT_TOOLS = {"shell", "http", "session", "browser", "script"}
MAIN_TOOLS_INTEREST = ACT_TOOLS | {"subagent", "finding", "todo", "skill", "fact"}


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return None


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


def tool_stats(task_dir: Path) -> dict[str, int]:
    events = task_dir / "events.jsonl"
    tools: Counter[str] = Counter()
    if not events.exists():
        return {}
    for line in events.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("type") == "tool_output" and o.get("status") == "running":
            tools[str(o.get("tool_name") or "?")] += 1
    return dict(tools)


def work_mode_from_events(task_dir: Path) -> str | None:
    events = task_dir / "events.jsonl"
    if not events.exists():
        return None
    for line in events.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("type") == "status_update" and o.get("work_mode"):
            return str(o["work_mode"])
        msg = str(o.get("message") or "")
        if "work_mode=" in msg:
            for part in msg.split():
                if part.startswith("work_mode="):
                    return part.split("=", 1)[1]
    return None


def score_one(task_dir: Path, mode_label: str) -> dict:
    findings = count_findings(task_dir)
    tools = tool_stats(task_dir)
    summary = load_json(task_dir / "agent-summary.json") or {}
    act_main = sum(tools.get(t, 0) for t in ACT_TOOLS)
    sub_n = tools.get("subagent", 0)
    find_n = tools.get("finding", 0)
    titles = []
    for f in findings:
        t = f.get("title") or f.get("name") or ""
        if t:
            titles.append(str(t)[:80])
    return {
        "mode": mode_label,
        "task_dir": str(task_dir),
        "work_mode_event": work_mode_from_events(task_dir),
        "terminal": summary.get("terminalStatus") or summary.get("terminal_status"),
        "booked_findings": len(findings),
        "finding_titles": titles[:30],
        "tool_counts": {k: tools[k] for k in sorted(tools) if k in MAIN_TOOLS_INTEREST or tools[k] >= 2},
        "act_tool_calls": act_main,
        "subagent_calls": sub_n,
        "finding_calls": find_n,
        "subagent_ratio": round(sub_n / max(act_main + sub_n, 1), 3),
    }


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: score-dvwa-work-modes.py <bench_out_dir>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    if not root.is_dir():
        print(f"not a dir: {root}", file=sys.stderr)
        return 2

    modes = []
    for mode in ("free", "soft", "hard"):
        # task dirs: dvwa-{mode}-*
        matches = sorted(root.glob(f"dvwa-{mode}-*"))
        # also flat task id folders
        if not matches:
            matches = [p for p in root.iterdir() if p.is_dir() and mode in p.name]
        if not matches:
            # standalone may write taskId as directory name under OUT
            for p in root.iterdir():
                if p.is_dir() and p.name.startswith(f"dvwa-{mode}-"):
                    matches.append(p)
        if matches:
            modes.append(score_one(matches[0], mode))
        else:
            modes.append(
                {
                    "mode": mode,
                    "task_dir": None,
                    "error": "task dir not found",
                    "booked_findings": 0,
                }
            )

    compare = {
        "root": str(root),
        "modes": modes,
        "ranking_by_findings": sorted(
            [m for m in modes if m.get("task_dir")],
            key=lambda m: (-int(m.get("booked_findings") or 0), m["mode"]),
        ),
        "notes": [
            "Higher booked_findings with grounded proof is better (not chat claims).",
            "hard should show high subagent_calls and low main act_tool_calls if discipline holds.",
            "free may act heavily on Main; soft is prompt-only delegate preference.",
        ],
    }
    out_json = root / "compare.json"
    out_json.write_text(json.dumps(compare, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = ["# DVWA work-mode comparison", f"root: {root}", ""]
    lines.append("| mode | findings | act_calls | subagent | finding tool | work_mode |")
    lines.append("|------|----------|-----------|----------|--------------|-----------|")
    for m in modes:
        lines.append(
            f"| {m.get('mode')} | {m.get('booked_findings', 0)} | {m.get('act_tool_calls', 0)} | "
            f"{m.get('subagent_calls', 0)} | {m.get('finding_calls', 0)} | {m.get('work_mode_event') or m.get('error') or '-'} |"
        )
    lines.append("")
    for m in modes:
        titles = m.get("finding_titles") or []
        if titles:
            lines.append(f"## {m.get('mode')} titles")
            for t in titles:
                lines.append(f"- {t}")
            lines.append("")
    text = "\n".join(lines)
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
