"""Salvage surface paths when the model fails to write surfaces[] in JSON.

Deterministic extraction from raw agent text, candidate locations, and payload
aliases — keeps Task Graph State Handoff alive without target answer keys.
"""

from __future__ import annotations

import re
from typing import Any

from node5.identity import normalize_path
from node5.state import PenState, Surface

_PATH_PATTERNS = [
    re.compile(r"/vulnerabilities/[A-Za-z0-9_.-]+/?", re.I),
    re.compile(r"/(?:login|logout|setup|security|phpinfo|about|instructions|changelog)\.php", re.I),
    re.compile(r"/(?:config|hackable|uploads|docs|external)(?:/[A-Za-z0-9_.-]*)*", re.I),
    # SPA/API style paths often only appear in prose summaries
    re.compile(
        r"/(?:api|rest|b2b)/[A-Za-z0-9_.{}~-][A-Za-z0-9_./{}~-]{0,80}",
        re.I,
    ),
    re.compile(r"/profile/[A-Za-z0-9_./-]{1,60}", re.I),
    re.compile(r"/ftp/?[A-Za-z0-9_./-]{0,40}", re.I),
    re.compile(r"https?://[^\s\"'<>]+", re.I),
]


def extract_paths_from_text(text: str, target: str = "") -> list[str]:
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for rx in _PATH_PATTERNS:
        for m in rx.finditer(text):
            raw = m.group(0).rstrip(".,);]'\"")
            n = normalize_path(raw, target)
            if not n or n in {"/", "/get", "/post"}:
                continue
            if n not in seen:
                seen.add(n)
                found.append(n)
    return found


def salvage_surfaces(
    state: PenState,
    *,
    raw: str = "",
    payload: dict[str, Any] | None = None,
    source: str = "salvage",
) -> int:
    """Add missing surfaces from payload/raw. Returns count added."""
    paths: list[str] = []
    if payload:
        for key in ("surfaces", "paths", "urls", "endpoints", "modules", "attack_surface"):
            val = payload.get(key)
            if isinstance(val, list):
                for item in val:
                    if isinstance(item, str):
                        paths.append(item)
                    elif isinstance(item, dict):
                        paths.append(
                            str(
                                item.get("path")
                                or item.get("url")
                                or item.get("uri")
                                or item.get("endpoint")
                                or ""
                            )
                        )
            elif isinstance(val, str):
                paths.append(val)
        for c in payload.get("candidates") or []:
            if isinstance(c, dict) and c.get("location"):
                paths.append(str(c["location"]))
        if payload.get("summary"):
            paths.extend(extract_paths_from_text(str(payload["summary"]), state.target))
        if payload.get("notes"):
            paths.extend(extract_paths_from_text(json_dumps_notes(payload["notes"]), state.target))

    paths.extend(extract_paths_from_text(raw or "", state.target))
    # Also scan recent notes (agent may have streamed paths only in prose)
    for note in state.notes[-15:]:
        if note.startswith("surface:") or "vulnerabilit" in note.lower():
            paths.extend(extract_paths_from_text(note, state.target))

    existing = {normalize_path(s.path, state.target) for s in state.surfaces}
    added = 0
    for p in paths:
        n = normalize_path(p, state.target)
        if not n or n in existing:
            continue
        state.surfaces.append(
            Surface(path=n, method="GET", note=f"{source}", status="open")
        )
        existing.add(n)
        added += 1
    if added:
        state.note(f"surface_salvage: added {added} path(s) via {source}")
        state.feedback_log("surface_salvage", state.stage or "surface", True, f"added={added}")
    return added


def json_dumps_notes(notes: Any) -> str:
    if isinstance(notes, list):
        return "\n".join(str(x) for x in notes)
    return str(notes or "")
