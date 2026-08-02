"""Vulnerability fingerprint + dedupe helpers (pure, unit-testable).

Ledger identity (Spec #275 / docs/specs/finding-identity.md):
  asset_id OR host-string + optional port + required vuln_type + file-level location_key

Title / title-stem / upload path-class aliases are NOT merge keys.
CVE+asset still matches when both sides carry the same CVE.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse
from uuid import UUID


# Closed enum — reject anything outside this set at Node + platform.
VALID_VULN_TYPES: frozenset[str] = frozenset(
    {
        "rce",
        "command_injection",
        "file_upload",
        "credential_exposure",
        "info_disclosure",
        "dir_listing",
        "sqli",
        "xss",
        "csrf",
        "lfi",
        "ssrf",
        "xxe",
        "idor",
        "auth_bypass",
        "session",
        "misconfig",
        "other",
    }
)


def normalize_vuln_type(value: object) -> str | None:
    """Return canonical enum id, or None when missing/unknown (reject at boundary)."""
    raw = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not raw:
        return None
    if raw in VALID_VULN_TYPES:
        return raw
    return None


def ports_equal(a: object, b: object) -> bool:
    pa = str(a or "").strip()
    pb = str(b or "").strip()
    if not pa and not pb:
        return True
    return pa == pb


def location_host_key(location: object, *, host: object = None) -> str:
    """Normalized host for identity when asset_id is absent."""
    explicit = str(host or "").strip().lower()
    if explicit:
        # Strip brackets / trailing dots
        return explicit.strip("[]").rstrip(".").lower()
    raw = str(location or "").strip()
    if not raw:
        return ""
    m = re.search(r"https?://([^/\s?#]+)", raw, flags=re.IGNORECASE)
    if m:
        hostport = m.group(1)
        # drop userinfo
        if "@" in hostport:
            hostport = hostport.rsplit("@", 1)[-1]
        # drop port
        if hostport.startswith("["):
            # ipv6 [addr]:port
            end = hostport.find("]")
            if end > 0:
                return hostport[1:end].lower()
        return hostport.split(":", 1)[0].lower().rstrip(".")
    # bare host:port or host/path
    m2 = re.match(
        r"^(?:https?://)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}|"
        r"localhost|host\.docker\.internal|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?",
        raw,
        flags=re.I,
    )
    if m2:
        return m2.group(1).lower()
    return ""


def location_resource_key(location: object) -> str:
    """
    File/resource-level path for identity.

    Strip scheme/host; strip query/fragment by default; keep final path segment / file.
    Does **not** apply upload-family aliases (e.g. /hackable/uploads/* stays distinct
    from /vulnerabilities/upload).
    """
    raw = str(location or "").strip()
    if not raw:
        return ""

    path = ""
    # Prefer first URL-looking token.
    m = re.search(r"https?://[^\s,;)\]}>'\"]+", raw, flags=re.IGNORECASE)
    if m:
        try:
            path = urlparse(m.group(0)).path or ""
        except Exception:
            path = ""
    elif raw.startswith("/"):
        path = raw.split("?", 1)[0].split("#", 1)[0]
    else:
        # "… at /vulnerabilities/sqli/" or "GET /path/file.php"
        pm = re.search(r"(/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-])+)", raw)
        if pm:
            path = pm.group(1).split("?", 1)[0].split("#", 1)[0]
        else:
            return ""

    path = path.strip()
    if not path:
        return ""
    # Normalize case + collapse //; keep file-level (do not strip last segment)
    path = path.lower()
    while "//" in path:
        path = path.replace("//", "/")
    # Drop trailing slash except root
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    if not path or path == "/":
        return ""
    return path[:500]


def finding_fingerprint(
    *,
    vuln_type: object,
    asset_id: object = None,
    host: object = None,
    port: object = None,
    cve_id: object = None,
    location: object = None,
    location_key: object = None,
) -> str:
    """Composite identity key for one logical finding under a user ledger."""
    vtype = normalize_vuln_type(vuln_type) or ""
    asset_key = str(asset_id or "").strip().lower()
    host_key = location_host_key(location, host=host) if not asset_key else ""
    port_key = str(port or "").strip()
    cve_key = str(cve_id or "").strip().upper()
    loc_key = str(location_key or "").strip().lower() or location_resource_key(location)
    scope = f"asset:{asset_key}" if asset_key else f"host:{host_key}"
    if cve_key and asset_key:
        return f"{scope}|cve:{cve_key}|port:{port_key}"
    return f"{scope}|port:{port_key}|type:{vtype}|loc:{loc_key}"


def is_same_finding(
    existing: dict[str, Any],
    *,
    title: object = None,  # kept for call-site compat; NOT a merge key
    asset_id: object = None,
    port: object = None,
    cve_id: object = None,
    location: object = None,
    description: object = None,  # unused for identity
    poc: object = None,  # unused for identity
    vuln_type: object = None,
    location_key: object = None,
    host: object = None,
) -> bool:
    """True when existing row matches the incoming agent finding identity."""
    del title, description, poc  # not merge keys (Spec #275)

    ea = existing.get("asset_id")
    # Prefer asset identity when both sides have it.
    if ea is not None and asset_id is not None and str(ea) != str(asset_id):
        return False

    same_port = ports_equal(existing.get("port"), port)
    linked = ea is not None and asset_id is not None
    unlinked = ea is None and asset_id is None

    # CVE short-circuit: same CVE on same asset (or either missing asset) is same finding.
    ecve = str(existing.get("cve_id") or "").strip().upper()
    icve = str(cve_id or "").strip().upper()
    if ecve and icve and ecve == icve:
        if ea is None or asset_id is None or str(ea) == str(asset_id):
            if same_port or not (existing.get("port") or port):
                return True

    # Required typed identity — no legacy row compatibility.
    e_type = normalize_vuln_type(existing.get("vuln_type"))
    i_type = normalize_vuln_type(vuln_type)
    if not e_type or not i_type or e_type != i_type:
        return False

    e_loc = str(existing.get("location_key") or "").strip().lower()
    if not e_loc:
        e_loc = location_resource_key(
            existing.get("location")
            or existing.get("poc")
            or existing.get("description")
            or ""
        )
    i_loc = str(location_key or "").strip().lower() or location_resource_key(location)
    if not e_loc or not i_loc or e_loc != i_loc:
        return False

    if not same_port:
        # When either side has a port, both must match.
        if existing.get("port") or port:
            return False

    if linked:
        return True

    if unlinked:
        e_host = location_host_key(
            existing.get("location") or existing.get("poc") or "",
            host=existing.get("host"),
        )
        i_host = location_host_key(location, host=host)
        # Incomplete keys: both hosts empty is allowed only when no host material;
        # non-empty hosts must match. Different non-empty hosts → no merge.
        if e_host and i_host and e_host != i_host:
            return False
        if (e_host and not i_host) or (i_host and not e_host):
            # One side has host, other doesn't — do not false-merge.
            return False
        return True

    # Mixed linkedness: do not false-merge.
    return False


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


def rediscovery_count(history: object) -> int:
    """How many times this finding was re-confirmed after first discovery."""
    if not isinstance(history, list):
        return 0
    n = 0
    for item in history:
        if not isinstance(item, dict):
            continue
        if str(item.get("event") or "").strip().lower() in {"rediscovered", "rediscover"}:
            n += 1
    return n


def discovery_count(history: object) -> int:
    """Total discovery events (first + rediscoveries). At least 1 when history empty."""
    if not isinstance(history, list) or not history:
        return 1
    n = 0
    for item in history:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("event") or "").strip().lower()
        if kind in {"discovered", "rediscovered", "rediscover"}:
            n += 1
    return max(1, n)


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
    """
    Best-effort location text from an ORM row or dict for location_key derivation.
    """
    if isinstance(row, dict):
        # Prefer explicit location_key / location before narrative fields.
        if row.get("location_key"):
            return str(row.get("location_key"))
        parts = [
            row.get("location"),
            row.get("poc"),
            row.get("description"),
            row.get("title"),
        ]
    else:
        if getattr(row, "location_key", None):
            return str(getattr(row, "location_key"))
        parts = [
            getattr(row, "location", None),
            getattr(row, "poc", None),
            getattr(row, "description", None),
            getattr(row, "title", None),
        ]
    chunks: list[str] = []
    for part in parts:
        text = str(part or "").strip()
        if text:
            chunks.append(text)
    return "\n".join(chunks)
