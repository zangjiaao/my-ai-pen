"""Vulnerability fingerprint + dedupe helpers (pure, unit-testable).

Agent rediscover of the same finding should update the existing row's
timeline / last-seen time instead of inserting a duplicate.

Identity (strongest → weakest):
  1. same CVE on same asset
  2. same asset + port + location path class (title may drift)
  3. same asset + port + exact normalized title
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse
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


def location_path_class(location: object) -> str:
    """
    Stable path class for soft dedupe (host ignored — pair with asset_id).

    Examples:
      http://h:8080/vulnerabilities/sqli/?id=1  → /vulnerabilities/sqli
      /vulnerabilities/exec/                    → /vulnerabilities/exec
      /level1/index.php                         → /level1
      bare module name without path             → "" (fall back to title)
    """
    raw = str(location or "").strip()
    if not raw:
        return ""
    # Prefer first URL-looking token.
    m = re.search(r"https?://[^\s,;)\]}>'\"]+", raw, flags=re.IGNORECASE)
    if m:
        raw = m.group(0)
    path = ""
    if "://" in raw or raw.startswith("//"):
        try:
            path = urlparse(raw if "://" in raw else f"http:{raw}").path or ""
        except Exception:
            path = ""
    elif raw.startswith("/"):
        path = raw.split("?", 1)[0].split("#", 1)[0]
    else:
        # "… at /vulnerabilities/sqli/" or "GET /vulnerabilities/sqli/"
        pm = re.search(r"(/(?:vulnerabilities|vuln|level\d+)[^\s,;)\]}>'\"]*)", raw, flags=re.I)
        if pm:
            path = pm.group(1).split("?", 1)[0].split("#", 1)[0]
        else:
            return ""

    path = path.strip().lower()
    if not path or path == "/":
        return ""
    # Collapse // and trailing slash
    while "//" in path:
        path = path.replace("//", "/")
    path = path.rstrip("/") or "/"
    parts = [p for p in path.split("/") if p]
    if not parts:
        return ""

    # DVWA-style modules: /vulnerabilities/<module>
    if parts[0] in {"vulnerabilities", "vuln"} and len(parts) >= 2:
        return f"/{parts[0]}/{parts[1]}"
    # CTF-style: /levelN[/page]
    if re.fullmatch(r"level\d+", parts[0]):
        if len(parts) >= 2 and not parts[1].endswith((".php", ".html", ".jsp", ".asp")):
            return f"/{parts[0]}/{parts[1]}"
        return f"/{parts[0]}"
    # Generic: first two path segments (avoid merging entire site as "/")
    if len(parts) >= 2:
        return f"/{parts[0]}/{parts[1]}"
    # Single segment only if it looks module-like (not index.php alone)
    if "." in parts[0]:
        return ""
    return f"/{parts[0]}"


def path_classes_match(a: object, b: object) -> bool:
    ka, kb = location_path_class(a), location_path_class(b)
    return bool(ka) and ka == kb


def finding_fingerprint(
    *,
    title: object,
    asset_id: object = None,
    port: object = None,
    cve_id: object = None,
    location: object = None,
) -> str:
    """
    Composite key for one logical finding under a user ledger.

    Prefers path class when available so title drift does not fork rows.
    """
    title_key = normalize_finding_title(title)
    asset_key = str(asset_id or "").strip().lower()
    port_key = str(port or "").strip()
    cve_key = str(cve_id or "").strip().upper()
    path_key = location_path_class(location)
    if path_key:
        return f"{asset_key}|{port_key}|path:{path_key}|{cve_key}"
    return f"{asset_key}|{port_key}|title:{title_key}|{cve_key}"


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
    location: object = None,
) -> bool:
    """True when existing row matches the incoming agent finding identity."""
    ea = existing.get("asset_id")
    # Prefer asset identity when both sides have it.
    if ea is not None and asset_id is not None and str(ea) != str(asset_id):
        return False

    # CVE short-circuit: same CVE on same asset (or either missing asset) is same finding.
    ecve = str(existing.get("cve_id") or "").strip().upper()
    icve = str(cve_id or "").strip().upper()
    if ecve and icve and ecve == icve:
        if ea is None or asset_id is None or str(ea) == str(asset_id):
            if ports_equal(existing.get("port"), port) or not (existing.get("port") or port):
                return True

    # Path class on same asset+port: title may drift across runs.
    eloc = existing.get("location") or existing.get("poc") or existing.get("description") or ""
    if path_classes_match(eloc, location):
        if ea is not None and asset_id is not None:
            return ports_equal(existing.get("port"), port)
        # Both unlinked: still merge if path+port match (soft).
        if ea is None and asset_id is None:
            return ports_equal(existing.get("port"), port)

    if not titles_match(existing.get("title"), title):
        return False
    if ea is not None and asset_id is not None:
        if not ports_equal(existing.get("port"), port):
            return False
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


def row_location_blob(row: Any) -> str:
    """Best-effort location text from an ORM row or dict for path-class match."""
    if isinstance(row, dict):
        return str(row.get("location") or row.get("poc") or row.get("description") or "")
    return str(
        getattr(row, "poc", None)
        or getattr(row, "description", None)
        or getattr(row, "title", None)
        or ""
    )
