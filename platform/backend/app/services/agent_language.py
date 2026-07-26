"""
Agent output-language catalog for Node config (#134 / #136).

Must stay in lockstep with:
- node4/src/runtime/agent-language.ts (AGENT_LANGUAGE_REGISTRY)
- platform/frontend/src/lib/agentLanguages.ts

Adding a language = extend SHIPPED_AGENT_LANGUAGES + aliases here,
plus Node registry and FE options. No session-path edits.
"""
from __future__ import annotations

from typing import Final

DEFAULT_AGENT_LANGUAGE: Final[str] = "auto"

# Wire codes accepted on Node config / worker_limits (including auto).
SHIPPED_AGENT_LANGUAGES: Final[tuple[str, ...]] = (
    "auto",
    "zh-CN",
    "zh-TW",
    "en",
    "ja",
)

ALLOWED_AGENT_LANGUAGES: Final[frozenset[str]] = frozenset(SHIPPED_AGENT_LANGUAGES)

# Alias (lowercased latin / as-is CJK) → canonical code.
# Exact wire codes are accepted before this map.
_ALIAS_TO_CODE: Final[dict[str, str]] = {
    # auto
    "follow": "auto",
    "match": "auto",
    "跟随用户": "auto",
    "跟随": "auto",
    # zh-CN
    "zh": "zh-CN",
    "zh-cn": "zh-CN",
    "chinese": "zh-CN",
    "simplified": "zh-CN",
    "simplified-chinese": "zh-CN",
    "simplified chinese": "zh-CN",
    "中文": "zh-CN",
    "简体": "zh-CN",
    "简体中文": "zh-CN",
    # zh-TW (never collapse into zh-CN)
    "zh-tw": "zh-TW",
    "zh-hant": "zh-TW",
    "zh-hk": "zh-TW",
    "traditional": "zh-TW",
    "traditional-chinese": "zh-TW",
    "traditional chinese": "zh-TW",
    "繁體": "zh-TW",
    "繁体": "zh-TW",
    "繁體中文": "zh-TW",
    "繁体中文": "zh-TW",
    # en
    "en-us": "en",
    "en-gb": "en",
    "english": "en",
    # ja
    "jp": "ja",
    "ja-jp": "ja",
    "japanese": "ja",
    "日本語": "ja",
}


def _alias_key(raw: str) -> str:
    s = raw.strip()
    if any("\u3040" <= ch <= "\u30ff" or "\u3400" <= ch <= "\u9fff" for ch in s):
        return s
    return s.lower().replace("_", "-")


def normalize_agent_language(value: object) -> str:
    """
    Return a shipped wire code (auto | zh-CN | zh-TW | en | ja).
    Unknown / empty → auto (safe default for worker_limits inject).
    """
    raw = str(value if value is not None else DEFAULT_AGENT_LANGUAGE).strip()
    if not raw:
        return DEFAULT_AGENT_LANGUAGE
    if raw in ALLOWED_AGENT_LANGUAGES:
        return raw
    key = _alias_key(raw)
    if key in ALLOWED_AGENT_LANGUAGES:
        return key
    # Case-insensitive match on shipped codes (e.g. JA → ja).
    for code in SHIPPED_AGENT_LANGUAGES:
        if code.lower() == key:
            return code
    mapped = _ALIAS_TO_CODE.get(key)
    if mapped:
        return mapped
    return DEFAULT_AGENT_LANGUAGE


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
        # Belt-and-suspenders: top-level field for Node normalizeTask readers.
        if not out.get("agent_language") and not out.get("agentLanguage"):
            out["agent_language"] = lang.strip()
    return out


def parse_agent_language_for_update(value: object) -> str:
    """
    Normalize a PATCH body value to a shipped code.
    Raises ValueError if the input is free-form garbage (not alias/code).
    Empty string is treated as invalid (prefer explicit 400).
    """
    raw = str(value if value is not None else "").strip()
    if not raw:
        raise ValueError("agent_language must be one of: " + ", ".join(SHIPPED_AGENT_LANGUAGES))
    if raw in ALLOWED_AGENT_LANGUAGES:
        return raw
    key = _alias_key(raw)
    if key in ALLOWED_AGENT_LANGUAGES:
        # only if key is a real code form (ja, en, …) — not alias-only keys in ALLOWED
        return key
    for code in SHIPPED_AGENT_LANGUAGES:
        if code.lower() == key:
            return code
    mapped = _ALIAS_TO_CODE.get(key)
    if mapped:
        return mapped
    raise ValueError(
        "agent_language must be one of: " + ", ".join(SHIPPED_AGENT_LANGUAGES)
    )
