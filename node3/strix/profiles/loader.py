from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from strix.utils.resource_paths import get_strix_resource_path


_PROFILE_FILES = {
    "dvwa_high": "dvwa_high.md",
    "dvwa_medium": "dvwa_medium.md",
    "juice_shop": "juice_shop.md",
    "vulhub_cve": "vulhub_cve.md",
}


@dataclass(frozen=True)
class TargetProfile:
    name: str
    title: str
    content: str


def infer_target_profile(task: dict[str, Any], target: str) -> str | None:
    explicit = _profile_name(task.get("target_profile") or task.get("profile"))
    if explicit:
        return explicit

    text = " ".join(
        str(part or "")
        for part in (
            target,
            task.get("instruction"),
            task.get("initial_instruction"),
            task.get("text"),
        )
    ).lower()

    if "dvwa" in text or "damn vulnerable web application" in text:
        if re.search(r"\bmedium\b|中等|中级", text):
            return "dvwa_medium"
        return "dvwa_high" if re.search(r"\bhigh\b|高级|高\s*级", text) else "dvwa_medium"
    if "juice shop" in text or "juice-shop" in text or "owasp juice" in text:
        return "juice_shop"
    if "vulhub" in text:
        return "vulhub_cve"
    return None


def load_target_profile(name: str | None) -> TargetProfile | None:
    profile_name = _profile_name(name)
    if not profile_name:
        return None
    path = _profile_path(profile_name)
    try:
        content = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    title = content.splitlines()[0].lstrip("# ").strip() if content else profile_name
    return TargetProfile(name=profile_name, title=title, content=content)


def _profile_name(value: object) -> str | None:
    name = str(value or "").strip().lower().replace("-", "_")
    return name if name in _PROFILE_FILES else None


def _profile_path(name: str) -> Path:
    return get_strix_resource_path("profiles", _PROFILE_FILES[name])
