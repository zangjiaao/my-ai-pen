"""Routing primitives shared by platform orchestration code."""
from __future__ import annotations

import re
from dataclasses import dataclass, field


TARGET_RE = re.compile(r"https?://[A-Za-z0-9._~:/?#\[\]@!$&()*+=%-]+|\b(?:\d{1,3}\.){3}\d{1,3}(?:/\d{1,2})?\b", re.I)


@dataclass(frozen=True)
class RoutingDecision:
    action: str
    capability: str = ""
    mode: str = ""
    agent: str = ""
    agent_node_id: str | None = None
    requires_target: bool = False
    reason: str = ""
    message: str = ""
    targets: list[str] = field(default_factory=list)


def extract_target(text: str) -> str:
    targets = extract_targets(text)
    return targets[0] if targets else ""


def extract_targets(text: str) -> list[str]:
    return _dedupe_targets(match.strip() for match in TARGET_RE.findall(str(text or "")) if match.strip())


def _dedupe_targets(targets) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for target in targets:
        key = str(target).strip().rstrip("/")
        if not key or key.lower() in seen:
            continue
        seen.add(key.lower())
        result.append(str(target).strip())
    return result

