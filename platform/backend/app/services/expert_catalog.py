"""Load expert pack ids/aliases from the shared repo `experts/catalog.json`.

Keeps platform offers in sync with the experts catalog (no divergent hard-coded triple).
Falls back to a minimal built-in list only if the catalog file is missing.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

# expert_catalog.py → services → app → backend → platform → repo root
_REPO_ROOT = Path(__file__).resolve().parents[4]
_CATALOG_PATH = _REPO_ROOT / "experts" / "catalog.json"

# Last-resort fallback if catalog is absent (dev mis-checkout).
_FALLBACK_PACKS: tuple[dict, ...] = (
    {"id": "pentest", "aliases": ["assess", "verify", "retest"]},
    {"id": "ctf", "aliases": ["ctf-web", "challenge"]},
    {"id": "consult", "aliases": []},
)


@lru_cache(maxsize=1)
def load_experts_catalog() -> dict:
    """Return {packs: [{id, label?, aliases}], path, source}."""
    if _CATALOG_PATH.is_file():
        data = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
        packs = data.get("packs") if isinstance(data, dict) else None
        if isinstance(packs, list) and packs:
            return {
                "path": str(_CATALOG_PATH),
                "source": "file",
                "packs": packs,
            }
    return {
        "path": str(_CATALOG_PATH),
        "source": "fallback",
        "packs": list(_FALLBACK_PACKS),
    }


def catalog_pack_ids() -> frozenset[str]:
    packs = load_experts_catalog()["packs"]
    ids: set[str] = set()
    for p in packs:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id") or "").strip().lower()
        if pid:
            ids.add(pid)
    return frozenset(ids) or frozenset({"pentest"})


def catalog_alias_map() -> dict[str, str]:
    """alias/id → canonical pack id."""
    out: dict[str, str] = {}
    for p in load_experts_catalog()["packs"]:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id") or "").strip().lower()
        if not pid:
            continue
        out[pid] = pid
        aliases = p.get("aliases") or []
        if isinstance(aliases, list):
            for a in aliases:
                key = str(a or "").strip().lower()
                if key:
                    out[key] = pid
    return out


def clear_catalog_cache() -> None:
    load_experts_catalog.cache_clear()
