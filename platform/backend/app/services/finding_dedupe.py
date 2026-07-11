"""Vulnerability fingerprint + dedupe helpers (pure, unit-testable).

Agent rediscover of the same finding should update the existing row's
timeline / last-seen time instead of inserting a duplicate.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from uuid import UUID


def normalize_finding_title(title: object) -> str:
    """Stable title key for dedupe (case/whitespace insensitive)."""
    text = str(title or "").strip().lower()
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text)
    # Drop trailing punctuation noise agents sometimes append.
    text = text.rstrip(" .;:|-/")
    return text[:500]


def ports_equal(a: object, b: object) -> bool:
    pa = str(a or "").strip()
    pb = str(b or "").strip()
    if not pa and not pb:
        return True
    return pa == pb


def finding_fingerprint(
    *,
    title: object,
    asset_id: object = None,
    port: object = None,
    cve_id: object = None,
) -> str:
    """
    Composite key for one logical finding under a user ledger.

    Primary: asset + port + normalized title
    When CVE is present it is included so CVE-tagged rows stay distinct.
    """
    title_key = normalize_finding_title(title)
    asset_key = str(asset_id or "").strip().lower()
    port_key = str(port or "").strip()
    cve_key = str(cve_id or "").strip().upper()
    return f"{asset_key}|{port_key}|{title_key}|{cve_key}"


def titles_match(a: object, b: object) -> bool:
    ka, kb = normalize_finding_title(a), normalize_finding_title(b)
    return bool(ka) and ka == kb


def is_same_finding(
    existing: dict[str, Any],
    *,
    title: object,
    asset_id: object = None,
    port: object = None,
    cve_id: object = None,
) -> bool:
    """True when existing row matches the incoming agent finding identity."""
    if not titles_match(existing.get("title"), title):
        return False
    # Prefer asset identity when both sides have it.
    ea = existing.get("asset_id")
    if ea is not None and asset_id is not None:
        if str(ea) != str(asset_id):
            return False
        if not ports_equal(existing.get("port"), port):
            return False
    # CVE short-circuit: same CVE on same asset is same finding even if title drifts slightly
    ecve = str(existing.get("cve_id") or "").strip().upper()
    icve = str(cve_id or "").strip().upper()
    if ecve and icve and ecve == icve:
        if ea is None or asset_id is None or str(ea) == str(asset_id):
            return True
    return True


def append_discovery_event(
    history: object,
    *,
    event: str,
    conversation_id: object = None,
    evidence_ids: list[str] | None = None,
    at: datetime | None = None,
) -> list[dict[str, Any]]:
    """Append a discovery / rediscovery event to the finding timeline."""
    now = at or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    base: list[dict[str, Any]] = []
    if isinstance(history, list):
        for item in history:
            if isinstance(item, dict):
                base.append(dict(item))
    entry: dict[str, Any] = {
        "event": str(event or "discovered"),
        "at": now.isoformat(),
    }
    if conversation_id:
        entry["conversation_id"] = str(conversation_id)
    if evidence_ids:
        entry["evidence_ids"] = [str(x) for x in evidence_ids if str(x).strip()]
    base.append(entry)
    # Cap history length for storage hygiene.
    return base[-50:]


def pick_canonical_vuln(rows: list[Any]) -> Any | None:
    """Prefer earliest-created row as the survivor when merging duplicates."""
    if not rows:
        return None
    return sorted(
        rows,
        key=lambda r: (
            getattr(r, "discovered_at", None) is None,
            getattr(r, "discovered_at", None) or datetime.min.replace(tzinfo=timezone.utc),
            str(getattr(r, "id", "")),
        ),
    )[0]


def as_uuid(value: object) -> UUID | None:
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except (ValueError, TypeError):
        return None
