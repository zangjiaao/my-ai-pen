"""Node expert offers: default pentest, install/uninstall, engagement gate, billing hooks.

Node is a container; experts are installable packs listed in ``node.config.offers``.
Pack **content** lives in the shared ``experts/`` catalog; platform offers are the
permission/billing layer. Assignment must carry structured engagement/role (no free-text NLP).
Billing events are structured hooks only — no payment provider.
"""
from __future__ import annotations

from typing import Any

from app.services.expert_catalog import catalog_alias_map, catalog_pack_ids

# Built-in seat is always available (not listed in offers).
# Extension offers: empty means no extension packs installed (not "default to pentest").
DEFAULT_OFFER = "pentest"  # historical label for billing helpers only
DEFAULT_OFFERS: tuple[str, ...] = ()

# Stable billing codes for install/uninstall/usage hooks (not real charges).
BILLING_CODES: dict[str, str] = {
    "pentest": "expert.pentest",
    "ctf": "expert.ctf",
    "consult": "expert.consult",
    "llm-security": "expert.llm-security",
    "code-audit": "expert.code-audit",
    "alert-triage": "expert.alert-triage",
}

# AuditLog.action values for billing-oriented events.
ACTION_INSTALL = "expert.install"
ACTION_UNINSTALL = "expert.uninstall"
ACTION_USAGE = "expert.usage"


def known_pack_ids() -> frozenset[str]:
    """Pack ids published under experts/catalog.json (or fallback)."""
    return catalog_pack_ids()


# Back-compat name used by API modules.
KNOWN_PACK_IDS = known_pack_ids()  # evaluated at import; tests can reload module


def _refresh_known() -> frozenset[str]:
    return catalog_pack_ids()


# Built-in Node seat — not a commercial pack; never offers-gated.
BUILTIN_SEAT_IDS = frozenset({"default", "consult", "workspace"})


def normalize_pack_id(value: object) -> str | None:
    """Map engagement/role/alias to a canonical pack id, or None if empty/unknown."""
    if value is None:
        return None
    key = str(value).strip().lower()
    if not key:
        return None
    if key in BUILTIN_SEAT_IDS:
        return "default"
    aliases = catalog_alias_map()
    if key in aliases:
        return aliases[key]
    if key in catalog_pack_ids():
        return key
    return None


def billing_code_for(pack_id: str | None) -> str:
    """Stable billing_code for a pack (hooks only)."""
    pid = normalize_pack_id(pack_id) or DEFAULT_OFFER
    return BILLING_CODES.get(pid, f"expert.{pid}")


def effective_offers(config: object) -> list[str]:
    """Return installed **extension** pack ids for a node.

    Built-in ``default`` is never listed. Missing/empty ``offers`` → ``[]``.
    Unknown / blank / builtin entries are dropped; duplicates preserve first-seen order.
    """
    cfg = config if isinstance(config, dict) else {}
    raw = cfg.get("offers")
    if raw is None or not isinstance(raw, (list, tuple)):
        return []
    known = catalog_pack_ids()
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        pid = normalize_pack_id(item)
        if not pid or pid in seen:
            continue
        if pid == "default" or pid in BUILTIN_SEAT_IDS:
            continue
        if pid not in known:
            continue
        seen.add(pid)
        out.append(pid)
    return out


def engagement_allowed(offers: object, engagement: object) -> bool:
    """True if the structured engagement/role resolves to a pack in offers.

    Built-in default seat (default/consult/workspace) is always allowed.
    Missing/blank engagement defaults to the **default seat** (always allowed).
    Unknown engagement strings do not invent a pack — treated as not allowed
    unless they normalize to a known pack that is offered.
    """
    raw = str(engagement or "").strip().lower()
    if not raw or raw in BUILTIN_SEAT_IDS or normalize_pack_id(raw) == "default":
        return True

    offer_list = (
        list(offers)
        if isinstance(offers, (list, tuple))
        else effective_offers({"offers": offers} if offers is not None else {})
    )
    offer_set = set()
    for o in offer_list:
        pid = normalize_pack_id(o) or (str(o).strip().lower() if o else "")
        if pid:
            offer_set.add(pid)
    pack = normalize_pack_id(raw)
    if pack is None:
        return False
    if pack == "default":
        return True
    return pack in offer_set


def dispatch_gate_error(node_config: object, engagement: object) -> str | None:
    """Return a user-facing error if engagement is not offered; else None."""
    raw = str(engagement or "").strip().lower()
    if not raw or raw in BUILTIN_SEAT_IDS or normalize_pack_id(raw) == "default":
        return None
    offers = effective_offers(node_config)
    if engagement_allowed(offers, engagement):
        return None
    pack = normalize_pack_id(engagement)
    eng_label = str(engagement or "").strip() or "(default/pentest)"
    pack_label = pack or eng_label
    return (
        f"Expert pack '{pack_label}' is not installed on this node. "
        f"Installed offers: {', '.join(offers) or 'none'}. "
        f"Install the expert on the node before assigning this engagement."
    )


def install_offer(config: object, expert_id: object) -> tuple[dict[str, Any], dict[str, Any]]:
    """Add an expert pack to config.offers. Returns (new_config, billing_detail).

    Raises ValueError for unknown expert ids.
    Idempotent: re-installing an already-present pack still returns success detail.
    """
    pack = normalize_pack_id(expert_id)
    known = catalog_pack_ids()
    if pack is None or pack not in known:
        raise ValueError(
            f"Unknown expert pack id: {expert_id!r}. Known: {', '.join(sorted(known))}"
        )
    cfg = dict(config) if isinstance(config, dict) else {}
    current = effective_offers(cfg)
    if "offers" not in cfg or not isinstance(cfg.get("offers"), (list, tuple)):
        offers = list(current)
    else:
        offers = list(current)
    already = pack in offers
    if not already:
        offers.append(pack)
    cfg["offers"] = offers
    detail = {
        "billing_code": billing_code_for(pack),
        "expert_id": pack,
        "action": "install",
        "already_installed": already,
        "offers": list(offers),
    }
    return cfg, detail


def uninstall_offer(config: object, expert_id: object) -> tuple[dict[str, Any], dict[str, Any]]:
    """Remove an expert pack from config.offers. Returns (new_config, billing_detail).

    Raises ValueError for unknown expert ids.
    Cannot remove the last remaining offer (node must always offer at least one pack).
    """
    pack = normalize_pack_id(expert_id)
    known = catalog_pack_ids()
    if pack is None or pack not in known:
        raise ValueError(
            f"Unknown expert pack id: {expert_id!r}. Known: {', '.join(sorted(known))}"
        )
    cfg = dict(config) if isinstance(config, dict) else {}
    current = effective_offers(cfg)
    if pack not in current:
        detail = {
            "billing_code": billing_code_for(pack),
            "expert_id": pack,
            "action": "remove",
            "was_installed": False,
            "offers": list(current),
        }
        cfg["offers"] = list(current)
        return cfg, detail
    offers = [o for o in current if o != pack]
    if not offers:
        raise ValueError(
            f"Cannot uninstall '{pack}': node must keep at least one expert offer"
        )
    cfg["offers"] = offers
    detail = {
        "billing_code": billing_code_for(pack),
        "expert_id": pack,
        "action": "remove",
        "was_installed": True,
        "offers": list(offers),
    }
    return cfg, detail


def usage_billing_detail(
    *,
    expert_id: object = None,
    engagement: object = None,
    task_id: object = None,
    conversation_id: object = None,
    node_id: object = None,
    status: object = None,
) -> dict[str, Any]:
    """Build a usage billing event detail for task settlement (hooks only)."""
    pack = normalize_pack_id(expert_id) or normalize_pack_id(engagement) or DEFAULT_OFFER
    detail: dict[str, Any] = {
        "billing_code": billing_code_for(pack),
        "expert_id": pack,
        "action": "usage",
    }
    if engagement is not None and str(engagement).strip():
        detail["engagement"] = str(engagement).strip()
    if task_id is not None and str(task_id).strip():
        detail["task_id"] = str(task_id).strip()
    if conversation_id is not None and str(conversation_id).strip():
        detail["conversation_id"] = str(conversation_id).strip()
    if node_id is not None and str(node_id).strip():
        detail["node_id"] = str(node_id).strip()
    if status is not None and str(status).strip():
        detail["status"] = str(status).strip()
    return detail


def engagement_from_task_message(msg: dict | None) -> str:
    """Read structured engagement/role from a task/user message (no free-text NLP)."""
    if not isinstance(msg, dict):
        return ""
    for key in ("engagement", "role"):
        val = msg.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    snap = msg.get("snapshot")
    if isinstance(snap, dict):
        for key in ("engagement", "role"):
            val = snap.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    return ""
