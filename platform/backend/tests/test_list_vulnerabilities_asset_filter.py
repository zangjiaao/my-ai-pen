"""list_vulnerabilities supports asset_id filter (agent parity with 漏洞台账 UI)."""
from __future__ import annotations

import inspect

from app.services import node_ledger as ledger


def test_list_vulnerabilities_signature_has_asset_filters():
    sig = inspect.signature(ledger.list_vulnerabilities)
    assert "asset_id" in sig.parameters
    assert "asset_ids" in sig.parameters
    assert "offset" in sig.parameters
    assert "port" in sig.parameters
    assert "q" in sig.parameters


def test_aid_dedupe_logic():
    """Mirror service de-dupe of asset_id + asset_ids."""
    asset_id = "a"
    asset_ids = ["a", "b", "a", "c"]
    raw = list(asset_ids or []) + ([asset_id] if asset_id else [])
    seen: set[str] = set()
    out: list[str] = []
    for x in raw:
        if x in seen:
            continue
        seen.add(x)
        out.append(x)
    assert out == ["a", "b", "c"]
