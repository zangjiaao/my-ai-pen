"""Spec #368 / #373 / #376 / #379 — Case surface_ledger store / project (pure + context merge).

SoT lives on conversation.context["surface_ledger"]:
  { version: 2, updated_at, surfaces: [...] }

Identity: origin_key + path_key (mirrors node4 surface-identity pure core).
Status v2 (D3): seen → touched → booked; legacy open/in_probe/probed accepted on read.
Ordinary upsert: merge methods/params; never downgrade status; cannot set booked.
Finding book path: apply_booked_side_effect (allow_booked; cap-skip create soft).
"""
from __future__ import annotations

import re
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote, urlparse

# Spec D4: write hard-cap per Case (configurable ceiling ≤5000).
DEFAULT_ROW_CAP = 2000
# Spec D9: version 2 when status vocabulary (seen/touched/booked) ships (#379).
LEDGER_VERSION = 2

# Write statuses: normative v2 + optional retained terminals (deadend/skipped_roe).
SURFACE_STATUSES = frozenset(
    {
        "seen",
        "touched",
        "booked",
        "deadend",
        "skipped_roe",
    }
)

# Legacy v1 statuses accepted on read; normalized via LEGACY_STATUS_MAP on write.
LEGACY_SURFACE_STATUSES = frozenset({"open", "in_probe", "probed"})

ACCEPTED_SURFACE_STATUSES = SURFACE_STATUSES | LEGACY_SURFACE_STATUSES

# open→seen, in_probe/probed→touched, booked→booked;
# deadend/skipped_roe retained as optional terminals (not collapsed to touched+tag).
LEGACY_STATUS_MAP: dict[str, str] = {
    "open": "seen",
    "in_probe": "touched",
    "probed": "touched",
    "seen": "seen",
    "touched": "touched",
    "booked": "booked",
    "deadend": "deadend",
    "skipped_roe": "skipped_roe",
}

# Rank for monotonic advance (post-normalize). Peers cannot lateral-transition.
STATUS_RANK: dict[str, int] = {
    "seen": 0,
    "touched": 1,
    "deadend": 1,
    "skipped_roe": 1,
    "booked": 2,
}

# Well-known default ports (generic IANA-style; not product-target-specific).
DEFAULT_PORTS: dict[str, int] = {
    "http": 80,
    "https": 443,
    "ws": 80,
    "wss": 443,
    "ssh": 22,
    "sftp": 22,
    "redis": 6379,
    "mysql": 3306,
    "postgres": 5432,
    "postgresql": 5432,
    "mongodb": 27017,
    "mongo": 27017,
    "ftp": 21,
    "smtp": 25,
    "telnet": 23,
    "rdp": 3389,
    "mssql": 1433,
    "amqp": 5672,
    "mqtt": 1883,
    "ldap": 389,
    "ldaps": 636,
}

_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)
_PATH_SEG_RE = re.compile(r"(/[\w./%-]+)")
# Absolute URL token (http/https or other schemes) inside free-text blobs.
_ABS_URL_TOKEN_RE = re.compile(
    r"[a-z][a-z0-9+.-]*://[^\s,;)\]}>'\"]+",
    re.IGNORECASE,
)
# METHOD /path or bare /path; allow OpenAPI braces in segments.
_METHOD_PATH_RE = re.compile(
    r"^(?:[A-Z]{3,10}\s+)(/(?:[^\s?#]+))",
    re.IGNORECASE,
)
_PATH_IN_TEXT_RE = re.compile(
    r"(/(?:[A-Za-z0-9._~!$&'()*+,;=:@%{}-]|%[0-9A-Fa-f]{2})+)"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _str_or_none(value: Any, *, max_len: int | None = None) -> str | None:
    if value is None:
        return None
    text = str(value)
    if max_len is not None and len(text) > max_len:
        return text[:max_len]
    return text


def _extract_abs_url_tokens(text: str | None) -> list[str]:
    """Return absolute URL tokens found in free text (order preserved, de-duped)."""
    raw = str(text or "").strip()
    if not raw:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for m in _ABS_URL_TOKEN_RE.finditer(raw):
        tok = m.group(0).rstrip(").,;]'\"")
        if tok and tok not in seen:
            seen.add(tok)
            out.append(tok)
    return out


def _normalize_booking_path(path: str | None) -> str:
    """Normalize a path fragment for host+port+location_key composition."""
    p = str(path or "").strip()
    if not p:
        return ""
    # Accidental full URL passed as location_key → take path only.
    if _SCHEME_RE.match(p):
        try:
            u = urlparse(p)
            p = u.path or "/"
        except Exception:
            return ""
    if not p.startswith("/"):
        p = f"/{p}"
    p = p.split("?", 1)[0].split("#", 1)[0]
    while "//" in p:
        p = p.replace("//", "/")
    if p != "/" and p.endswith("/"):
        p = p.rstrip("/")
    # Light lower-case for identity stability (mirrors http_path_key).
    return p.lower() if p else ""


def path_from_location_blob(raw: str | None) -> str:
    """Extract a path from method-path or prose finding locations.

    Handles field forms like ``PUT /api/Products/{id} (...)`` that are not absolute URLs.
    """
    s = str(raw or "").strip()
    if not s:
        return ""
    # Prefer leading METHOD /path
    m = _METHOD_PATH_RE.match(s)
    if m:
        return _normalize_booking_path(m.group(1).rstrip(").,;]'\" "))
    if s.startswith("/"):
        token = s.split("?", 1)[0].split("#", 1)[0].split()[0]
        return _normalize_booking_path(token.rstrip(").,;]'\" "))
    # Prose: "... at /vulnerabilities/sqli/" or "GET /path"
    pm = _PATH_IN_TEXT_RE.search(s)
    if pm:
        return _normalize_booking_path(pm.group(1).rstrip(").,;]'\" "))
    return ""


def _parse_port_value(port: Any) -> int | None:
    if port is None:
        return None
    text = str(port).strip()
    if not text:
        return None
    try:
        n = int(text)
    except (TypeError, ValueError):
        return None
    if n < 1 or n > 65535:
        return None
    return n


def _clean_host(host: Any) -> str:
    h = str(host or "").strip().lower()
    if not h:
        return ""
    h = h.strip("[]").rstrip(".")
    # Drop accidental path/userinfo
    if "/" in h:
        h = h.split("/", 1)[0]
    if "@" in h:
        h = h.rsplit("@", 1)[-1]
    # host:port → host (port handled separately)
    if h.count(":") == 1 and not h.startswith("["):
        # ipv4/host:port
        left, right = h.split(":", 1)
        if right.isdigit():
            h = left
    return h


def compose_http_location(
    host: str,
    port: int,
    path: str,
    *,
    scheme: str | None = None,
) -> str:
    """Build scheme://host[:port]/path for parse_location (strong identity composition)."""
    host_s = _clean_host(host)
    if not host_s:
        return ""
    scheme_s = (scheme or "").strip().lower()
    if scheme_s not in {"http", "https"}:
        scheme_s = "https" if int(port) in (443, 8443) else "http"
    host_disp = f"[{host_s}]" if ":" in host_s else host_s
    path_s = _normalize_booking_path(path) or "/"
    if (scheme_s == "http" and port == 80) or (scheme_s == "https" and port == 443):
        return f"{scheme_s}://{host_disp}{path_s}"
    return f"{scheme_s}://{host_disp}:{int(port)}{path_s}"


def _proof_text_blobs(
    proof: str | None = None,
    proof_excerpts: list | None = None,
) -> list[str]:
    blobs: list[str] = []
    if proof is not None and str(proof).strip():
        blobs.append(str(proof))
    if isinstance(proof_excerpts, list):
        for item in proof_excerpts:
            if isinstance(item, dict):
                ex = item.get("excerpt")
                if ex is not None and str(ex).strip():
                    blobs.append(str(ex))
            elif item is not None and str(item).strip():
                blobs.append(str(item))
    return blobs


def resolve_booking_location(
    location: str | None = None,
    *,
    host: str | None = None,
    port: str | int | None = None,
    location_key: str | None = None,
    proof: str | None = None,
    proof_excerpts: list | None = None,
    scheme: str | None = None,
) -> dict[str, Any]:
    """Spec #368 D7 / #382: resolve strong surface identity for finding book.

    Order:
      1. Absolute URL (whole location or first absolute URL token in location)
      2. host/target + port + location_key (location_key arg or path from location blob)
      3. Absolute URL extracted from proof / proof_excerpts

    Returns parse_location-compatible ``{ok: True, origin_key, path_key, ...}``
    or ``{ok: False, error}``. Soft-fail only — never used to fail a finding.
    """
    raw = str(location or "").strip()

    # 1a. Whole location is scheme://…
    if raw and _SCHEME_RE.match(raw):
        parsed = parse_location(raw)
        if parsed.get("ok"):
            return parsed

    # 1b. Absolute URL token embedded in location free-text
    for url in _extract_abs_url_tokens(raw):
        parsed = parse_location(url)
        if parsed.get("ok"):
            return parsed

    # 2. host + port + location_key (strong composition)
    host_s = _clean_host(host)
    port_n = _parse_port_value(port)
    path = _normalize_booking_path(location_key) if location_key else ""
    if not path:
        path = path_from_location_blob(raw)
    if host_s and port_n is not None and path:
        composed = compose_http_location(host_s, port_n, path, scheme=scheme)
        if composed:
            parsed = parse_location(composed)
            if parsed.get("ok"):
                return parsed

    # 3. Proof absolute URLs
    for blob in _proof_text_blobs(proof, proof_excerpts):
        for url in _extract_abs_url_tokens(blob):
            parsed = parse_location(url)
            if parsed.get("ok"):
                return parsed

    if not raw and not host_s:
        return {"ok": False, "error": "empty location"}
    return {
        "ok": False,
        "error": (
            "unresolvable location "
            "(need absolute URL, or host+port+location_key, or proof URL)"
        ),
    }


def is_surface_status(v: Any) -> bool:
    """True for any accepted input status (legacy or write form)."""
    if not isinstance(v, str):
        return False
    return v.strip().lower() in ACCEPTED_SURFACE_STATUSES


def is_write_surface_status(v: Any) -> bool:
    """True only for post-normalize write statuses."""
    if not isinstance(v, str):
        return False
    return v.strip().lower() in SURFACE_STATUSES


def normalize_surface_status(v: Any) -> str | None:
    """Expand-contract: accept legacy/v2 on read; return write status or None."""
    if not isinstance(v, str):
        return None
    return LEGACY_STATUS_MAP.get(v.strip().lower())


def status_rank(status: str) -> int:
    """Rank after normalize; unknown → -1."""
    n = normalize_surface_status(status)
    if n is None:
        return -1
    return STATUS_RANK.get(n, -1)


def _is_http_scheme(scheme: str) -> bool:
    return scheme in {"http", "https"}


def _kind_from_scheme(scheme: str) -> str:
    return "url" if _is_http_scheme(scheme) else scheme


def http_path_key(loc: str) -> str:
    """HTTP(S) path identity: lowercase path, no query/fragment, trailing-slash rules.

    Mirrors node4 runtime/subagent-booking pathKey for HTTP URLs.
    """
    s = str(loc or "").strip()
    if not s:
        return ""
    try:
        s = unquote(s.replace("+", "%20"))
    except Exception:
        s = s.replace("+", " ")
    if re.match(r"^https?://", s, re.IGNORECASE):
        try:
            u = urlparse(s)
            path = u.path or "/"
            path = path.rstrip("/") or "/"
            return path.lower()
        except Exception:
            pass
    s = s.split("?", 1)[0].split("#", 1)[0]
    try:
        s = unquote(s.replace("+", "%20"))
    except Exception:
        s = s.replace("+", " ")
    m = _PATH_SEG_RE.search(s)
    path = (m.group(1) if m else s).rstrip("/") or s
    return path.lower()


def parse_location(raw: str) -> dict[str, Any]:
    """Parse a location into origin_key + path_key identity parts.

    Returns {ok: True, origin_key, path_key, location, scheme, host, port, kind}
    or {ok: False, error}.
    """
    location = str(raw or "").strip()
    if not location:
        return {"ok": False, "error": "empty location"}
    if not _SCHEME_RE.match(location):
        return {"ok": False, "error": "location must include scheme://"}

    try:
        url = urlparse(location)
    except Exception:
        return {"ok": False, "error": "invalid location URL"}

    scheme = (url.scheme or "").lower()
    if not scheme:
        return {"ok": False, "error": "missing scheme"}

    # hostname: urlparse drops brackets for IPv6; re-bracket when needed.
    hostname = (url.hostname or "").lower()
    if not hostname:
        return {"ok": False, "error": "missing host"}
    if hostname.startswith("[") and hostname.endswith("]"):
        host = hostname
    elif ":" in hostname:
        host = f"[{hostname}]"
    else:
        host = hostname

    if url.port is not None:
        port = int(url.port)
        if port < 1 or port > 65535:
            return {"ok": False, "error": "invalid port"}
    elif scheme in DEFAULT_PORTS:
        port = DEFAULT_PORTS[scheme]
    else:
        return {"ok": False, "error": f"missing port for scheme {scheme}"}

    origin_key = f"{scheme}://{host}:{port}"
    path_key = http_path_key(location) if _is_http_scheme(scheme) else ""

    return {
        "ok": True,
        "origin_key": origin_key,
        "path_key": path_key,
        "location": location,
        "scheme": scheme,
        "host": host,
        "port": port,
        "kind": _kind_from_scheme(scheme),
    }


def surface_row_key(origin_key: str, path_key: str) -> str:
    """Stable composite row key for origin + path identity."""
    origin = str(origin_key or "").strip()
    path = str(path_key or "").strip()
    if not path:
        return origin
    return f"{origin}{path}" if path.startswith("/") else f"{origin}/{path}"


def merge_methods(
    a: list | tuple | None = None,
    b: list | tuple | None = None,
) -> list[str]:
    """Union merge for HTTP methods (uppercased, first-seen order)."""
    seen: set[str] = set()
    out: list[str] = []
    for src in (a, b):
        if not src:
            continue
        for raw in src:
            m = str(raw or "").strip().upper()
            if not m or m in seen:
                continue
            seen.add(m)
            out.append(m)
    return out


def merge_params(
    a: list | tuple | None = None,
    b: list | tuple | None = None,
) -> list[str]:
    """Union merge for param names (trimmed, case-sensitive, first-seen order)."""
    seen: set[str] = set()
    out: list[str] = []
    for src in (a, b):
        if not src:
            continue
        for raw in src:
            p = str(raw or "").strip()
            if not p or p in seen:
                continue
            seen.add(p)
            out.append(p)
    return out


def can_transition_status(
    from_status: str,
    to_status: str,
    *,
    allow_booked: bool = False,
) -> bool:
    """Whether a status transition is allowed (inputs may be legacy; compared post-normalize)."""
    from_n = normalize_surface_status(from_status)
    to_n = normalize_surface_status(to_status)
    if from_n is None or to_n is None:
        return False
    if to_n == "booked" and not allow_booked:
        return False
    if from_n == to_n:
        return True
    from_r = STATUS_RANK[from_n]
    to_r = STATUS_RANK[to_n]
    if to_r < from_r:
        return False
    # Same rank, different peer (touched ↔ deadend ↔ skipped_roe): no lateral.
    if to_r == from_r:
        return False
    return True


def apply_status_advance(
    from_status: str,
    to_status: str,
    *,
    allow_booked: bool = False,
) -> dict[str, Any]:
    """Apply a forward status change when allowed; otherwise keep normalized from.

    Always returns a write SurfaceStatus (legacy inputs normalized).
    """
    from_n = normalize_surface_status(from_status) or "seen"
    to_n = normalize_surface_status(to_status)
    if to_n is None or not can_transition_status(from_n, to_n, allow_booked=allow_booked):
        return {"status": from_n, "changed": False}
    if from_n == to_n:
        return {"status": from_n, "changed": False}
    return {"status": to_n, "changed": True}


def resolve_upsert_status(
    existing: str | None,
    requested: str | None = None,
) -> str:
    """Status for ordinary surface upsert / settle (not booking).

    - New row defaults to seen when request omitted/invalid.
    - Requested booked is ignored (stays existing or seen).
    - Legacy requested/existing values are normalized.
    - Never downgrades an existing status.
    """
    want = "seen"
    if requested is not None:
        req_n = normalize_surface_status(requested)
        if req_n is not None and req_n != "booked":
            want = req_n
    if existing is None or existing == "":
        return want
    existing_n = normalize_surface_status(existing)
    if existing_n is None:
        return want
    return apply_status_advance(existing_n, want)["status"]


def empty_ledger(*, updated_at: str | None = None) -> dict[str, Any]:
    """Valid empty Case surface_ledger document."""
    return {
        "version": LEDGER_VERSION,
        "updated_at": updated_at or _now_iso(),
        "surfaces": [],
    }


def ensure_ledger(raw: Any) -> dict[str, Any]:
    """Coerce context value into a versioned ledger document (never None)."""
    if not isinstance(raw, dict):
        return empty_ledger()
    surfaces_raw = raw.get("surfaces")
    surfaces: list[dict] = []
    if isinstance(surfaces_raw, list):
        surfaces = [dict(s) for s in surfaces_raw if isinstance(s, dict)]
    elif isinstance(surfaces_raw, dict):
        # Tolerate map-by-id storage shape.
        surfaces = [dict(v) for v in surfaces_raw.values() if isinstance(v, dict)]
    try:
        version = int(raw.get("version") or LEDGER_VERSION)
    except (TypeError, ValueError):
        version = LEDGER_VERSION
    return {
        "version": version if version >= 1 else LEDGER_VERSION,
        "updated_at": str(raw.get("updated_at") or _now_iso()),
        "surfaces": surfaces,
    }


def _as_str_list(value: Any, *, upper: bool = False, max_items: int = 80) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in value:
        s = str(raw or "").strip()
        if upper:
            s = s.upper()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
        if len(out) >= max_items:
            break
    return out


def normalize_surface_row(
    msg: dict,
    *,
    conversation_id: str | None = None,
    allow_booked: bool = False,
) -> dict | None:
    """Normalize one surface payload into a storeable row. None if unusable.

    Accepts either origin_key+path_key, or a parseable location.
    Ordinary upsert (allow_booked=False) never produces status=booked.
    """
    if not isinstance(msg, dict):
        return None

    conv = str(conversation_id or msg.get("conversation_id") or "").strip()
    if not conv:
        return None

    origin_key = str(msg.get("origin_key") or "").strip()
    path_key_raw = msg.get("path_key")
    path_key = "" if path_key_raw is None else str(path_key_raw).strip()
    location = str(msg.get("location") or "").strip()
    kind = _str_or_none(msg.get("kind"), max_len=64)

    if origin_key:
        # Trust explicit identity when present; still fill location/kind defaults.
        if not location:
            location = surface_row_key(origin_key, path_key)
        if not kind:
            # Derive kind from origin scheme when possible.
            scheme = origin_key.split("://", 1)[0].lower() if "://" in origin_key else ""
            kind = _kind_from_scheme(scheme) if scheme else "url"
    else:
        if not location:
            return None
        parsed = parse_location(location)
        if not parsed.get("ok"):
            return None
        origin_key = str(parsed["origin_key"])
        path_key = str(parsed["path_key"])
        location = str(parsed["location"])
        if not kind:
            kind = str(parsed["kind"])

    if not origin_key:
        return None

    methods = _as_str_list(msg.get("methods"), upper=True)
    params = _as_str_list(msg.get("params"), upper=False)

    requested_status = msg.get("status")
    if isinstance(requested_status, str):
        requested_status = requested_status.strip().lower()
    else:
        requested_status = None
    if allow_booked:
        req_n = normalize_surface_status(requested_status)
        status = req_n if req_n is not None else "seen"
    else:
        status = resolve_upsert_status(
            None,
            requested_status if is_surface_status(requested_status) else None,
        )

    row_id = str(msg.get("id") or "").strip() or surface_row_key(origin_key, path_key)[:180]
    now = _now_iso()
    created_at = _str_or_none(msg.get("created_at")) or now
    updated_at = _str_or_none(msg.get("updated_at")) or now

    # Spec #413: preserve case_tested from Node dual-write (purpose=test settle).
    # False-safe: missing/invalid → False; sticky merge happens in merge_surface_row.
    case_tested = _coerce_case_tested(msg.get("case_tested"), default=False)

    return {
        "id": row_id[:180],
        "conversation_id": conv,
        "origin_key": origin_key,
        "path_key": path_key,
        "location": location[:2000],
        "kind": kind,
        "methods": methods,
        "params": params,
        "auth": _str_or_none(msg.get("auth"), max_len=200),
        "status": status,
        "note": _str_or_none(msg.get("note"), max_len=2000),
        "source": _str_or_none(msg.get("source"), max_len=64) or "agent",
        "source_agent_id": _str_or_none(
            msg.get("source_agent_id") or msg.get("source_subagent_id"),
            max_len=120,
        ),
        "updated_at": updated_at,
        "created_at": created_at,
        "case_tested": case_tested,
    }


def _coerce_is_new(value: Any, *, default: bool = False) -> bool:
    """False-safe is_new for Case ledger rows (Spec #410 inventory novelty)."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    s = str(value).strip().lower()
    if s in {"1", "true", "yes", "y", "on"}:
        return True
    if s in {"0", "false", "no", "n", "off", ""}:
        return False
    return default


def _coerce_case_tested(value: Any, *, default: bool = False) -> bool:
    """False-safe case_tested for Case ledger rows (Spec #413 purpose=test traffic)."""
    return _coerce_is_new(value, default=default)


def merge_surface_row(
    existing: dict | None,
    incoming: dict,
    *,
    allow_booked: bool = False,
) -> dict:
    """Upsert merge by identity: methods/params union; never downgrade status.

    Spec #410: ``is_new`` is engagement novelty from durable inventory admit.
    - Create: take incoming is_new (false-safe default False).
    - Update: sticky — never clear is_new from later dual-writes / re-admits.
    Inventory age does not advance status (no auto-TESTED).

    Spec #413: ``case_tested`` sticky true when purpose=test traffic hit this identity.
    - Create: take incoming case_tested (false-safe).
    - Update: sticky — never clear once true.
    Finding book alone does not set case_tested (orthogonal to TESTED chip).
    """
    if not existing:
        row = dict(incoming)
        # Guard: ordinary path cannot create booked; always store write vocabulary.
        st = normalize_surface_status(row.get("status")) or "seen"
        if not allow_booked and st == "booked":
            st = "seen"
        row["status"] = st
        # First Case row for this identity this engagement.
        row["is_new"] = _coerce_is_new(row.get("is_new"), default=False)
        row["case_tested"] = _coerce_case_tested(row.get("case_tested"), default=False)
        return row

    out = dict(existing)
    # Identity locked
    out["origin_key"] = existing.get("origin_key") or incoming.get("origin_key")
    out["path_key"] = (
        existing.get("path_key")
        if existing.get("path_key") is not None
        else incoming.get("path_key")
    )
    out["conversation_id"] = existing.get("conversation_id") or incoming.get("conversation_id")
    out["id"] = existing.get("id") or incoming.get("id")
    out["created_at"] = existing.get("created_at") or incoming.get("created_at")

    # Prefer non-empty display / kind / source metadata from incoming.
    for key in ("location", "kind", "auth", "note", "source", "source_agent_id"):
        if incoming.get(key) is not None and incoming.get(key) != "":
            out[key] = incoming[key]

    out["methods"] = merge_methods(existing.get("methods"), incoming.get("methods"))
    out["params"] = merge_params(existing.get("params"), incoming.get("params"))

    old_status = normalize_surface_status(existing.get("status")) or "seen"
    req = incoming.get("status")
    req_s = str(req).strip().lower() if req is not None else None
    if allow_booked and normalize_surface_status(req_s) is not None:
        adv = apply_status_advance(old_status, req_s, allow_booked=True)
        out["status"] = adv["status"]
    else:
        out["status"] = resolve_upsert_status(
            old_status,
            req_s if is_surface_status(req_s) else None,
        )

    out["updated_at"] = incoming.get("updated_at") or existing.get("updated_at") or _now_iso()

    # Spec #410: engagement novelty sticky-true.
    # - Once true for this Case, later inventory re-admits (false) must not clear it.
    # - Allow false→true if inventory stamp arrives after row create (booked path).
    prev_new = (
        _coerce_is_new(existing.get("is_new"), default=False)
        if "is_new" in existing
        else False
    )
    inc_new = _coerce_is_new(incoming.get("is_new"), default=False)
    out["is_new"] = bool(prev_new or inc_new)

    # Spec #413: case_tested sticky-true (purpose=test traffic).
    prev_ct = (
        _coerce_case_tested(existing.get("case_tested"), default=False)
        if "case_tested" in existing
        else False
    )
    inc_ct = _coerce_case_tested(incoming.get("case_tested"), default=False)
    out["case_tested"] = bool(prev_ct or inc_ct)
    return out


def _ledger_index(surfaces: list[dict]) -> dict[str, dict]:
    index: dict[str, dict] = {}
    for row in surfaces:
        if not isinstance(row, dict):
            continue
        ok = str(row.get("origin_key") or "").strip()
        if not ok:
            continue
        pk = "" if row.get("path_key") is None else str(row.get("path_key")).strip()
        index[surface_row_key(ok, pk)] = dict(row)
    return index


def upsert_into_ledger(
    ledger: dict | list | None,
    surface: dict,
    *,
    row_cap: int = DEFAULT_ROW_CAP,
    allow_booked: bool = False,
) -> dict[str, Any]:
    """Return new ledger document after identity upsert. Rejects excess with no insert.

    When at hard-cap and the identity is new, the ledger is returned unchanged
    (existing rows for the same identity still merge).
    """
    base = ensure_ledger(ledger)
    index = _ledger_index(base["surfaces"])
    ok = str(surface.get("origin_key") or "").strip()
    pk = "" if surface.get("path_key") is None else str(surface.get("path_key")).strip()
    if not ok:
        return base
    key = surface_row_key(ok, pk)
    existing = index.get(key)
    if existing is None and len(index) >= row_cap:
        # Hard-cap: do not create new row. Finding path uses apply_booked_side_effect
        # which soft-skips create (D7) instead of calling this for brand-new under cap.
        return base

    merged = merge_surface_row(existing, surface, allow_booked=allow_booked)
    index[key] = merged

    surfaces = list(index.values())
    surfaces.sort(
        key=lambda r: (
            str(r.get("origin_key") or ""),
            str(r.get("path_key") or ""),
            str(r.get("id") or ""),
        )
    )
    return {
        "version": LEDGER_VERSION,
        "updated_at": _now_iso(),
        "surfaces": surfaces,
    }


def upsert_many_into_ledger(
    ledger: dict | list | None,
    surfaces: list[dict],
    *,
    row_cap: int = DEFAULT_ROW_CAP,
    allow_booked: bool = False,
) -> tuple[dict[str, Any], list[dict]]:
    """Upsert many surfaces; returns (ledger, list of merged rows that landed).

    A row lands when its identity is present after the batch (hard-cap rejects
    leave brand-new identities out of the ledger and out of landed).
    """
    current = ensure_ledger(ledger)
    for row in surfaces:
        if not isinstance(row, dict):
            continue
        current = upsert_into_ledger(
            current,
            row,
            row_cap=row_cap,
            allow_booked=allow_booked,
        )

    final_index = _ledger_index(current["surfaces"])
    landed: list[dict] = []
    seen_keys: set[str] = set()
    for row in surfaces:
        if not isinstance(row, dict):
            continue
        key = surface_row_key(
            str(row.get("origin_key") or ""),
            "" if row.get("path_key") is None else str(row.get("path_key")).strip(),
        )
        if not key or key in seen_keys:
            continue
        if key in final_index:
            landed.append(final_index[key])
            seen_keys.add(key)
    return current, landed


def merge_surface_into_context(
    context: dict | None,
    surface: dict,
    *,
    row_cap: int = DEFAULT_ROW_CAP,
    allow_booked: bool = False,
) -> dict:
    """Pure: return new conversation.context with upserted surface_ledger."""
    ctx = dict(context) if isinstance(context, dict) else {}
    ledger = ctx.get("surface_ledger")
    ctx["surface_ledger"] = upsert_into_ledger(
        ledger,
        surface,
        row_cap=row_cap,
        allow_booked=allow_booked,
    )
    return ctx


def merge_surfaces_into_context(
    context: dict | None,
    surfaces: list[dict],
    *,
    row_cap: int = DEFAULT_ROW_CAP,
    allow_booked: bool = False,
) -> tuple[dict, list[dict]]:
    """Pure: merge many surfaces into context; returns (context, landed_rows)."""
    ctx = dict(context) if isinstance(context, dict) else {}
    ledger, landed = upsert_many_into_ledger(
        ctx.get("surface_ledger"),
        surfaces,
        row_cap=row_cap,
        allow_booked=allow_booked,
    )
    ctx["surface_ledger"] = ledger
    return ctx, landed


def surface_ledger_for_snapshot(
    context: dict | None,
    *,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    """Project Case surface_ledger for snapshot (empty document when missing)."""
    if not isinstance(context, dict):
        return empty_ledger()
    ledger = ensure_ledger(context.get("surface_ledger"))
    surfaces = list(ledger["surfaces"])
    if conversation_id:
        cid = str(conversation_id)
        surfaces = [
            s
            for s in surfaces
            if not s.get("conversation_id") or str(s.get("conversation_id")) == cid
        ]
    surfaces.sort(
        key=lambda r: (
            str(r.get("origin_key") or ""),
            str(r.get("path_key") or ""),
            str(r.get("id") or ""),
        )
    )
    return {
        "version": ledger.get("version") or LEDGER_VERSION,
        "updated_at": ledger.get("updated_at") or _now_iso(),
        "surfaces": surfaces,
    }


def extract_surfaces_from_upsert_message(
    msg: dict,
    *,
    conversation_id: str | None = None,
    allow_booked: bool = False,
) -> list[dict]:
    """Normalize inbound surface_upsert frame into zero or more storeable rows.

    Accepts:
      - surfaces: [ {...}, ... ]
      - surface: { ... }
      - top-level origin_key/path_key/location fields as a single surface
    """
    if not isinstance(msg, dict):
        return []
    conv = str(conversation_id or msg.get("conversation_id") or "").strip()
    if not conv:
        return []

    candidates: list[dict] = []
    if isinstance(msg.get("surfaces"), list):
        candidates.extend(s for s in msg["surfaces"] if isinstance(s, dict))
    if isinstance(msg.get("surface"), dict):
        candidates.append(msg["surface"])
    # Top-level single-surface fields (Node dual-write convenience).
    if msg.get("origin_key") or msg.get("location") or msg.get("path_key") is not None:
        # Only treat as a row if it looks like surface payload (avoid empty noise).
        if msg.get("origin_key") or msg.get("location"):
            top = {
                k: msg.get(k)
                for k in (
                    "id",
                    "origin_key",
                    "path_key",
                    "location",
                    "kind",
                    "methods",
                    "params",
                    "auth",
                    "status",
                    "note",
                    "source",
                    "source_agent_id",
                    "source_subagent_id",
                    "updated_at",
                    "created_at",
                    "conversation_id",
                    "case_tested",  # Spec #413 TESTED dual-write
                )
            }
            candidates.append(top)

    out: list[dict] = []
    seen: set[str] = set()
    for raw in candidates:
        row = normalize_surface_row(
            raw,
            conversation_id=conv,
            allow_booked=allow_booked,
        )
        if not row:
            continue
        key = surface_row_key(row["origin_key"], row.get("path_key") or "")
        if key in seen:
            # Collapse duplicate identities in one frame by merge.
            prev = next(r for r in out if surface_row_key(r["origin_key"], r.get("path_key") or "") == key)
            merged = merge_surface_row(prev, row, allow_booked=allow_booked)
            idx = out.index(prev)
            out[idx] = merged
            continue
        seen.add(key)
        out.append(row)
    return out


def project_surface_upsert_event(
    *,
    conversation_id: str,
    surfaces: list[dict],
    updated_at: str | None = None,
) -> dict[str, Any]:
    """Outbound FE/Node frame after successful persist (post-persist project)."""
    return {
        "type": "surface_upsert",
        "conversation_id": str(conversation_id),
        "updated_at": updated_at or _now_iso(),
        "surfaces": [dict(s) for s in surfaces if isinstance(s, dict)],
    }


def apply_booked_side_effect(
    context: dict | None,
    location: str | None,
    *,
    conversation_id: str,
    row_cap: int = DEFAULT_ROW_CAP,
    host: str | None = None,
    port: str | int | None = None,
    location_key: str | None = None,
    proof: str | None = None,
    proof_excerpts: list | None = None,
    scheme: str | None = None,
) -> dict[str, Any]:
    """Spec #368 D7 / #376 / #382: finding book → surface booked (system write).

    Pure: does not fail callers — always returns a result dict.

    Returns:
      {
        context: next conversation.context (or copy of input),
        action: "advanced" | "created" | "cap_skip" | "already_booked" | "unparseable" | "noop",
        landed: surface row dict | None,
        warning: str | None,
      }

    Rules:
      1. Resolve origin+path (absolute URL → host+port+location_key → proof URL).
      2. Matching row → advance status to booked (allow_booked; never downgrade booked).
      3. No match + strong identity → system-create row source=finding, status=booked.
      4. Hard-cap blocks create → skip surface write; finding path must still succeed.
      5. Ordinary upsert remains cannot-set-booked (this path alone uses allow_booked=True).
      6. Unresolvable identity → soft unparseable; never fails the finding.
    """
    ctx = dict(context) if isinstance(context, dict) else {}
    conv = str(conversation_id or "").strip()
    raw_loc = str(location or "").strip()
    if not conv:
        return {
            "context": ctx,
            "action": "noop",
            "landed": None,
            "warning": "missing conversation_id",
        }
    if not raw_loc and not host and not location_key and not proof and not proof_excerpts:
        return {
            "context": ctx,
            "action": "noop",
            "landed": None,
            "warning": "empty location",
        }

    parsed = resolve_booking_location(
        raw_loc or None,
        host=host,
        port=port,
        location_key=location_key,
        proof=proof,
        proof_excerpts=proof_excerpts,
        scheme=scheme,
    )
    if not parsed.get("ok"):
        return {
            "context": ctx,
            "action": "unparseable",
            "landed": None,
            "warning": str(parsed.get("error") or "unparseable location"),
        }

    origin_key = str(parsed["origin_key"])
    path_key = str(parsed["path_key"])
    location_store = str(parsed["location"])
    kind = str(parsed["kind"])
    key = surface_row_key(origin_key, path_key)

    ledger = ensure_ledger(ctx.get("surface_ledger"))
    index = _ledger_index(ledger["surfaces"])
    existing = index.get(key)
    now = _now_iso()

    if existing is not None:
        old_status = normalize_surface_status(existing.get("status")) or "seen"
        if old_status == "booked":
            # Already booked — optional location refresh only via merge identity path.
            return {
                "context": ctx,
                "action": "already_booked",
                "landed": dict(existing),
                "warning": None,
            }
        booked_row = merge_surface_row(
            existing,
            {
                "origin_key": origin_key,
                "path_key": path_key,
                "location": location_store,
                "kind": kind,
                "status": "booked",
                "conversation_id": conv,
                "updated_at": now,
            },
            allow_booked=True,
        )
        next_ledger = upsert_into_ledger(
            ledger,
            booked_row,
            row_cap=row_cap,
            allow_booked=True,
        )
        next_ctx = dict(ctx)
        next_ctx["surface_ledger"] = next_ledger
        landed = _ledger_index(next_ledger["surfaces"]).get(key)
        return {
            "context": next_ctx,
            "action": "advanced",
            "landed": dict(landed) if landed else booked_row,
            "warning": None,
        }

    # No match → system create (source=finding). Hard-cap must not block finding.
    if len(index) >= row_cap:
        return {
            "context": ctx,
            "action": "cap_skip",
            "landed": None,
            "warning": (
                f"surface write hard-cap reached ({row_cap} rows); "
                "skipped system-create booked surface for finding"
            ),
        }

    create_row = normalize_surface_row(
        {
            "origin_key": origin_key,
            "path_key": path_key,
            "location": location_store,
            "kind": kind,
            "status": "booked",
            "source": "finding",
            "conversation_id": conv,
            "created_at": now,
            "updated_at": now,
        },
        conversation_id=conv,
        allow_booked=True,
    )
    if not create_row:
        return {
            "context": ctx,
            "action": "noop",
            "landed": None,
            "warning": "normalize failed for finding surface",
        }
    create_row["status"] = "booked"
    create_row["source"] = "finding"

    next_ledger = upsert_into_ledger(
        ledger,
        create_row,
        row_cap=row_cap,
        allow_booked=True,
    )
    next_index = _ledger_index(next_ledger["surfaces"])
    landed = next_index.get(key)
    if landed is None:
        # Cap race or merge reject — treat as soft skip (finding still ok).
        return {
            "context": ctx,
            "action": "cap_skip",
            "landed": None,
            "warning": (
                f"surface write hard-cap or merge rejected create "
                f"({row_cap} rows); skipped system-create booked surface"
            ),
        }
    next_ctx = dict(ctx)
    next_ctx["surface_ledger"] = next_ledger
    return {
        "context": next_ctx,
        "action": "created",
        "landed": dict(landed),
        "warning": None,
    }


def surfaces_do_not_cross_cases(
    ledger_a: dict,
    ledger_b: dict,
    surface_for_a: dict,
) -> tuple[dict, dict]:
    """Helper for tests: upsert into A leaves B unchanged."""
    next_a = upsert_into_ledger(deepcopy(ledger_a), surface_for_a)
    return next_a, deepcopy(ledger_b)


# ---------------------------------------------------------------------------
# Spec #368 D13 / #377 — Offline package import → Case surface_ledger merge
# ---------------------------------------------------------------------------


def _iter_package_surface_dicts(payload: Any) -> list[dict]:
    """Collect raw surface-like dicts from a package section.

    Accepts:
      - surface_ledger document: { version, surfaces: [...] }
      - list of surface / legacy attack_surface rows
      - single surface dict
      - None / empty → []
    """
    if payload is None:
        return []
    if isinstance(payload, dict):
        surfaces = payload.get("surfaces")
        if isinstance(surfaces, list):
            return [s for s in surfaces if isinstance(s, dict)]
        if isinstance(surfaces, dict):
            return [dict(v) for v in surfaces.values() if isinstance(v, dict)]
        if isinstance(payload.get("surface"), dict):
            return [payload["surface"]]
        # Single row (modern identity or legacy url/surface_id).
        if (
            payload.get("origin_key")
            or payload.get("location")
            or payload.get("url")
            or payload.get("address")
            or payload.get("endpoint")
            or payload.get("surface_id")
            or payload.get("path_key") is not None
        ):
            return [payload]
        return []
    if isinstance(payload, list):
        return [s for s in payload if isinstance(s, dict)]
    return []


def map_legacy_attack_surface_item(item: dict) -> dict | None:
    """Map one legacy attack_surface.json row into a normalize-able surface payload.

    Legacy mvp-demo / agent shapes commonly include:
      { surface_id, kind, url, method?, parameters?, status? }
    Modern ledger rows (origin_key/location) pass through with light field aliases.
    Returns None when no usable location/identity can be recovered.
    """
    if not isinstance(item, dict):
        return None

    origin_key = str(item.get("origin_key") or "").strip()
    location = str(item.get("location") or "").strip()
    url = str(
        item.get("url")
        or item.get("address")
        or item.get("endpoint")
        or item.get("target")
        or ""
    ).strip()

    # Prefer explicit modern identity; else location; else url-like fields.
    if not origin_key and not location:
        location = url
    elif not location and url and "://" in url:
        location = url

    path_key_raw = item.get("path_key")
    has_path_key = path_key_raw is not None
    path_key = "" if path_key_raw is None else str(path_key_raw).strip()

    if not origin_key and not location:
        return None
    # Location/url without scheme cannot parse into identity.
    if not origin_key and location and "://" not in location:
        return None

    methods = item.get("methods")
    if not isinstance(methods, (list, tuple)):
        methods = []
    else:
        methods = list(methods)
    singular = item.get("method")
    if singular:
        methods = list(methods) + [singular]

    params = item.get("params")
    if not isinstance(params, (list, tuple)):
        params = item.get("parameters") if isinstance(item.get("parameters"), (list, tuple)) else []

    row_id = str(item.get("id") or item.get("surface_id") or "").strip() or None
    kind = item.get("kind") or item.get("type")
    status = item.get("status")
    source = item.get("source") or "import"

    out: dict[str, Any] = {
        "kind": kind,
        "methods": methods,
        "params": list(params) if params else [],
        "auth": item.get("auth"),
        "status": status,
        "note": item.get("note") or item.get("summary"),
        "source": source,
        "source_agent_id": item.get("source_agent_id") or item.get("source_subagent_id"),
        "updated_at": item.get("updated_at"),
        "created_at": item.get("created_at"),
    }
    if row_id:
        out["id"] = row_id
    if origin_key:
        out["origin_key"] = origin_key
        if has_path_key:
            out["path_key"] = path_key
        if location:
            out["location"] = location
    else:
        out["location"] = location
    # Drop empty optional noise so normalize sees clean input.
    return {k: v for k, v in out.items() if v is not None and v != []}


def surfaces_from_import_package(
    *,
    conversation_id: str,
    surface_ledger: Any = None,
    attack_surface: Any = None,
    allow_booked: bool = True,
) -> list[dict]:
    """Normalize package surface sections into storeable Case surface rows.

    Prefer surface_ledger-shaped data; also map legacy attack_surface list items.
    Duplicate identities within the package are collapsed via merge (later wins
    attributes; status never downgrades).
    """
    conv = str(conversation_id or "").strip()
    if not conv:
        return []

    candidates: list[dict] = []
    # Order: surface_ledger section first (canonical), then legacy attack_surface.
    for payload in (surface_ledger, attack_surface):
        for raw in _iter_package_surface_dicts(payload):
            mapped = map_legacy_attack_surface_item(raw)
            if mapped:
                candidates.append(mapped)

    out: list[dict] = []
    seen: dict[str, int] = {}
    for raw in candidates:
        # Default package provenance when the row did not carry an explicit source.
        if not raw.get("source"):
            raw = {**raw, "source": "import"}
        row = normalize_surface_row(
            raw,
            conversation_id=conv,
            allow_booked=allow_booked,
        )
        if not row:
            continue
        key = surface_row_key(row["origin_key"], row.get("path_key") or "")
        if key in seen:
            idx = seen[key]
            out[idx] = merge_surface_row(out[idx], row, allow_booked=allow_booked)
            continue
        seen[key] = len(out)
        out.append(row)
    return out


def merge_import_package_into_context(
    context: dict | None,
    *,
    conversation_id: str,
    surface_ledger: Any = None,
    attack_surface: Any = None,
    row_cap: int = DEFAULT_ROW_CAP,
    allow_booked: bool = True,
) -> tuple[dict, list[dict]]:
    """Merge package surface data into conversation.context[\"surface_ledger\"].

    Pure identity merge (S7). Second call with overlapping identities updates
    in place without duplicating rows. Empty/unusable package sections are no-ops.
    """
    rows = surfaces_from_import_package(
        conversation_id=conversation_id,
        surface_ledger=surface_ledger,
        attack_surface=attack_surface,
        allow_booked=allow_booked,
    )
    return merge_surfaces_into_context(
        context,
        rows,
        row_cap=row_cap,
        allow_booked=allow_booked,
    )
