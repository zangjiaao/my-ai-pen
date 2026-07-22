"""Read-only loader for experts/pentest graphs + skills (no pack install)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def repo_root() -> Path | None:
    """Locate monorepo root (directory containing experts/pentest)."""
    # Prefer walking from CWD (CLI run from repo or node5/)
    cwd = Path.cwd().resolve()
    for p in [cwd, *cwd.parents]:
        if (p / "experts" / "pentest" / "graphs").is_dir():
            return p
    # Editable install: node5/src/node5/pack_loader.py → parents[3] = repo
    here = Path(__file__).resolve()
    for p in here.parents:
        if (p / "experts" / "pentest" / "graphs").is_dir():
            return p
    return None


def default_pack_root() -> Path:
    root = repo_root()
    if root is None:
        raise FileNotFoundError(
            "cannot find experts/pentest — run from monorepo or pass --pack-root"
        )
    return root / "experts" / "pentest"


def load_graph(pack_root: Path, graph_id: str = "app_assessment") -> dict[str, Any]:
    path = pack_root / "graphs" / f"{graph_id}.json"
    if not path.is_file():
        raise FileNotFoundError(f"graph not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("id") and data["id"] != graph_id:
        # allow file name alias
        pass
    return data


def list_skill_ids(pack_root: Path) -> list[str]:
    skills = pack_root / "skills"
    if not skills.is_dir():
        return []
    return sorted(p.name for p in skills.iterdir() if (p / "SKILL.md").is_file())


def load_skill(pack_root: Path, skill_id: str, max_chars: int = 8000) -> str:
    path = pack_root / "skills" / skill_id / "SKILL.md"
    if not path.is_file():
        return f"(skill missing: {skill_id})"
    text = path.read_text(encoding="utf-8")
    if len(text) > max_chars:
        return text[:max_chars] + "\n\n…[truncated for stage context]…"
    return text


def stage_skills(graph: dict[str, Any], stage: str) -> list[str]:
    nodes = graph.get("nodes") or {}
    node = nodes.get(stage) or {}
    skills = node.get("skills") or []
    return list(skills)


def stage_success(graph: dict[str, Any], stage: str) -> str:
    nodes = graph.get("nodes") or {}
    node = nodes.get(stage) or {}
    return str(node.get("success") or f"complete stage {stage}")


def default_plan(graph: dict[str, Any]) -> list[str]:
    plan = graph.get("default_plan")
    if isinstance(plan, list) and plan:
        return [str(x) for x in plan]
    nodes = graph.get("nodes") or {}
    return list(nodes.keys())
