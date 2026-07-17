"""Expert instance helpers: name validation, offer gate, mention resolution.

Product model:
  1. Install pack on Node (offers) — runtime capability.
  2. Create Expert instance bound to Node + pack — routing persona.
  3. Conversation @Expert → node_id + engagement (structured, no NLP).
"""
from __future__ import annotations

import re
from typing import Any
from uuid import UUID

from app.services.expert_offers import (
    effective_offers,
    engagement_allowed,
    normalize_pack_id,
)

# Align with WS NODE_MENTION_RE token body.
# \w is Unicode-aware (CJK letters, Latin, digits, underscore); also allow . : -
# Intentionally excludes spaces, quotes, braces, newlines — names are also injected
# into Node system prompts as display labels (prompt-injection surface).
EXPERT_NAME_RE = re.compile(r"^[\w.:-]{1,64}$", re.UNICODE)
# Product accent color for partner chips (optional).
EXPERT_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
# Soft block for names that look like instruction smuggling (display label only).
_EXPERT_NAME_INJECTION_HINT = re.compile(
    r"(ignore\s*(all|previous|prior)|system\s*prompt|developer\s*message|"
    r"you\s*are\s*now|jailbreak|override\s*instructions)",
    re.IGNORECASE,
)


def validate_expert_name(name: object) -> str:
    """Return normalized mention name or raise ValueError.

    Allows Unicode letters (including Chinese), digits, and _ . : -
    No spaces or @ (token is used as @mention and prompt persona label).
    Max 64 chars — keep short to limit prompt-injection payload size.
    """
    raw = str(name or "").strip().lstrip("@")
    if not raw:
        raise ValueError("专家提及名不能为空")
    if len(raw) > 64:
        raise ValueError("专家提及名最多 64 个字符")
    # Reject control / format characters even if they sneak past \w on some engines.
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in raw):
        raise ValueError("专家提及名不能包含控制字符")
    if not EXPERT_NAME_RE.match(raw):
        raise ValueError(
            "专家提及名支持中英文、数字及 _ . : -，不能含空格或特殊符号（用于 @ 路由）"
        )
    # Names are display labels only; block obvious instruction-smuggling phrases.
    if _EXPERT_NAME_INJECTION_HINT.search(raw.replace("_", " ").replace(".", " ").replace("-", " ")):
        raise ValueError("专家提及名不能包含疑似指令注入内容")
    return raw


def validate_expert_color(color: object) -> str | None:
    """Return normalized #RRGGBB or None; raise ValueError if non-empty but invalid."""
    if color is None:
        return None
    raw = str(color).strip()
    if not raw:
        return None
    if not EXPERT_COLOR_RE.match(raw):
        raise ValueError("专家颜色须为 #RRGGBB 格式")
    return raw.upper()


def validate_pack_for_node(node_config: object, pack_id: object) -> str:
    """Ensure pack is known and available on the node. Returns canonical pack id.

    Built-in ``default`` (aliases consult/workspace) is always available.
    Other packs must be installed as node extension offers.
    """
    from app.services.expert_offers import BUILTIN_SEAT_IDS

    pack = normalize_pack_id(pack_id)
    if pack is None:
        raise ValueError(f"Unknown expert pack: {pack_id!r}")
    if pack == "default" or str(pack_id or "").strip().lower() in BUILTIN_SEAT_IDS:
        return "default"
    offers = effective_offers(node_config)
    if not engagement_allowed(offers, pack):
        raise ValueError(
            f"Pack '{pack}' is not installed on this node. "
            f"Installed extensions: {', '.join(offers) or 'none'}. "
            f"Install under Nodes → 扩展 first (default seat is always built-in)."
        )
    return pack


def expert_to_dict(
    expert: Any,
    *,
    node_name: str | None = None,
    node_status: str | None = None,
    node_offers: list[str] | None = None,
) -> dict[str, Any]:
    """Serialize expert ORM/row for API responses."""
    out: dict[str, Any] = {
        "id": str(expert.id),
        "name": expert.name,
        "display_name": expert.name,  # single name field; legacy column always mirrors name
        "pack_id": expert.pack_id,
        "node_id": str(expert.node_id),
        "description": expert.description,
        "color": getattr(expert, "color", None),
        "enabled": bool(expert.enabled),
        "created_at": expert.created_at.isoformat() if getattr(expert, "created_at", None) else None,
        "updated_at": expert.updated_at.isoformat() if getattr(expert, "updated_at", None) else None,
    }
    if node_name is not None:
        out["node_name"] = node_name
    if node_status is not None:
        out["node_status"] = node_status
    if node_offers is not None:
        out["node_offers"] = list(node_offers)
    if getattr(expert, "user_id", None) is not None:
        out["user_id"] = str(expert.user_id)
    return out


def match_expert_by_mention_token(
    token: str,
    experts: list[Any],
) -> Any | None:
    """Exact case-insensitive name match among enabled experts. Ambiguous → None."""
    key = str(token or "").strip().lower().lstrip("@")
    if not key:
        return None
    matches = [
        e
        for e in experts
        if bool(getattr(e, "enabled", True))
        and str(getattr(e, "name", "") or "").strip().lower() == key
    ]
    if len(matches) == 1:
        return matches[0]
    return None


def as_uuid(value: object) -> UUID | None:
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None
