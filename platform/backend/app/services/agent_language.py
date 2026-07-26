"""
Agent output-language catalog for Node config (#134 / #136).

Source of truth: agent_language_catalog.json (shipped copy of shared/).
Must stay byte-identical to:
- shared/agent-language-catalog.json
- node4/src/runtime/agent-language-catalog.json
- platform/frontend/src/lib/agent-language-catalog.json

Adding a language = edit the shared JSON and re-copy to the three ship paths.
No session-path edits; no per-locale inject branches.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Final, Literal

_CATALOG_PATH = Path(__file__).with_name("agent_language_catalog.json")


def _alias_key(raw: str) -> str:
    s = raw.strip()
    if any("\u3040" <= ch <= "\u30ff" or "\u3400" <= ch <= "\u9fff" for ch in s):
        return s
    return s.lower().replace("_", "-")


def _load_catalog() -> dict:
    return json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))


_CATALOG = _load_catalog()

DEFAULT_AGENT_LANGUAGE: Final[str] = str(_CATALOG.get("default") or "auto")

SHIPPED_AGENT_LANGUAGES: Final[tuple[str, ...]] = tuple(
    str(row["code"]) for row in (_CATALOG.get("languages") or [])
)

ALLOWED_AGENT_LANGUAGES: Final[frozenset[str]] = frozenset(SHIPPED_AGENT_LANGUAGES)

_ALIAS_TO_CODE: Final[dict[str, str]] = {}
for _row in _CATALOG.get("languages") or []:
    _code = str(_row["code"])
    for _alias in _row.get("aliases") or []:
        _ALIAS_TO_CODE[_alias_key(str(_alias))] = _code


def resolve_agent_language(
    value: object,
    *,
    unknown: Literal["auto", "error"] = "auto",
) -> str:
    """
    Resolve free-form input to a shipped wire code.

    unknown=\"auto\"  — runtime / worker_limits (safe default)
    unknown=\"error\" — PATCH save (explicit 400 via ValueError)
    """
    raw = str(value if value is not None else "").strip()
    if not raw:
        if unknown == "error":
            raise ValueError(
                "agent_language must be one of: " + ", ".join(SHIPPED_AGENT_LANGUAGES)
            )
        return DEFAULT_AGENT_LANGUAGE
    if raw in ALLOWED_AGENT_LANGUAGES:
        return raw
    key = _alias_key(raw)
    for code in SHIPPED_AGENT_LANGUAGES:
        if code.lower() == key:
            return code
    mapped = _ALIAS_TO_CODE.get(key)
    if mapped:
        return mapped
    if unknown == "error":
        raise ValueError(
            "agent_language must be one of: " + ", ".join(SHIPPED_AGENT_LANGUAGES)
        )
    return DEFAULT_AGENT_LANGUAGE


def normalize_agent_language(value: object) -> str:
    """Return a shipped wire code; unknown / empty → auto."""
    return resolve_agent_language(value, unknown="auto")


def parse_agent_language_for_update(value: object) -> str:
    """Normalize a PATCH body value; raises ValueError on garbage / empty."""
    return resolve_agent_language(value, unknown="error")


def merge_worker_limits_into_message(
    msg: dict,
    limits: dict | None,
) -> dict:
    """
    Attach Node worker_limits (including agent_language) onto a task_assign
    or user_steer rebuild so language does not silently fall back to auto (#138).

    Pure: does not mutate the input dict.
    """
    out = dict(msg)
    if not limits:
        return out
    out["worker_limits"] = limits
    lang = limits.get("agent_language")
    if isinstance(lang, str) and lang.strip():
        if not out.get("agent_language") and not out.get("agentLanguage"):
            out["agent_language"] = lang.strip()
    return out


def catalog_path() -> Path:
    """Path to the shipped catalog JSON (lock tests)."""
    return _CATALOG_PATH
