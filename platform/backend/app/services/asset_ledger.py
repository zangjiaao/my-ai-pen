"""Asset ledger helpers: one host (IP/domain) per asset, ports+services, tags.

Model:
  Asset = single IP or domain (host keys only). Users create assets; agents do not.
  Asset.tags = multi labels for grouping hosts
  properties.services = [{port, name, url, ...}]  # one service per port
  properties.urls = [url strings under this host]
  properties.api_endpoints = [{method?, path?, url?, ...}] or URL strings
  Vulnerability links via asset_id + port (agent associates by host+port)

Agent policy: enrich ports/services/urls/api_endpoints on existing hosts only.
Never invent a new host row from agent discovery.

Pure functions (no DB) so unit tests can drive the real shipped logic.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

SEVERITY_ORDER = ("critical", "high", "medium", "low", "info")

TYPE_LABELS = {
    "host": "主机",
    "ip": "IP",
    "domain": "域名",
    "web": "Web",
    "web_app": "Web 应用",
    "cloud_service": "云服务",
    "code_repo": "代码仓库",
}

SOURCE_LABELS = {
    "manual": "人工录入",
    # Historical rows only — agents no longer create ledger hosts.
    "agent_discovered": "Agent 发现（历史）",
    "agent": "Agent 发现（历史）",
    "import": "导入",
    "standalone_import": "导入",
}

# Statuses treated as still open for risk / remediation export.
# Includes legacy discovery statuses and new management lifecycle.
OPEN_VULN_STATUSES = frozenset({
    "pending",
    "open",
    "confirmed",
    "candidate",
    "in_progress",
    "retest",
    "verified",
    "accepted",
    "to_fix",   # 待修复
    "fixing",    # 修复中
    "reported",
})


# Bare path/file segments agents often mis-report as "assets" (not hosts).
_REJECT_ADDRESS_TOKENS = frozenset({
    "unknown", "n/a", "na", "none", "null", "-", "undefined", "localhost.localdomain",
})
_FILE_LIKE_EXT = re.compile(
    r"\.(?:php|phtml|asp|aspx|jsp|jspx|cgi|pl|py|rb|js|mjs|ts|css|html?|htm|shtml|"
    r"json|xml|txt|map|woff2?|ttf|eot|svg|png|jpe?g|gif|ico|pdf|zip|tar|gz|rar|"
    r"sql|bak|old|swf|do|action)(?:\?.*)?$",
    re.IGNORECASE,
)
_IPV4 = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$")
_HOSTISH = re.compile(
    r"^(?:localhost|host\.docker\.internal|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})$",
    re.IGNORECASE,
)


def normalize_address(value: object) -> str:
    """Normalize to a single host key (IP or domain, lowercase). Port is not part of address."""
    host, _port = split_host_port(value)
    return host


def split_host_port(value: object) -> tuple[str, str | None]:
    """
    Extract (host, port) from IP/domain/URL/host:port strings.

    Port may come from explicit :port or URL port; default http/https ports are kept
    only when written in the string (urlparse returns them when present).

    Never raises — finding PoCs / free-text blobs may look like invalid IPv6 URLs.
    """
    raw = str(value or "").strip().strip("'\"")
    if not raw:
        return "", None

    url_match = re.search(r"https?://[^\s,;)\]}>'\"]+", raw, flags=re.IGNORECASE)
    if url_match:
        raw = url_match.group(0).rstrip("/.")
    else:
        host_match = re.search(
            r"(?:\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}|\blocalhost\b|\bhost\.docker\.internal\b|\b(?:\d{1,3}\.){3}\d{1,3}\b)(?::\d{1,5})?",
            raw,
            flags=re.IGNORECASE,
        )
        if host_match:
            raw = host_match.group(0).rstrip("/.")
        else:
            # No recognizable host token — avoid urlparse on arbitrary prose
            # (e.g. "[Proof] …" can raise Invalid IPv6 URL).
            return "", None

    try:
        parsed = urlparse(raw if "://" in raw else f"//{raw}")
    except ValueError:
        # Manual fallback for host:port without scheme.
        m = re.match(
            r"^(?P<host>(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}|localhost|host\.docker\.internal|(?:\d{1,3}\.){3}\d{1,3})(?::(?P<port>\d{1,5}))?(?:/.*)?$",
            raw,
            flags=re.IGNORECASE,
        )
        if not m:
            return "", None
        host = m.group("host").lower()
        if _FILE_LIKE_EXT.search(host) or host in _REJECT_ADDRESS_TOKENS:
            return "", None
        return host, normalize_port(m.group("port"))

    if parsed.hostname:
        host = parsed.hostname.lower()
        if _FILE_LIKE_EXT.search(host) or host in _REJECT_ADDRESS_TOKENS:
            return "", None
        try:
            port_value = parsed.port
        except ValueError:
            port_value = None
        port = normalize_port(port_value) if port_value is not None else None
        return host, port

    return "", None


def normalize_port(value: object) -> str | None:
    """Normalize a port to a digit string, or None if invalid."""
    if value is None or value == "":
        return None
    if isinstance(value, dict):
        value = value.get("port") or value.get("number")
    text = str(value).strip()
    if not text:
        return None
    # Allow "80/tcp" or "443/https"
    text = text.split("/", 1)[0].strip()
    if not text.isdigit():
        return None
    num = int(text)
    if num < 1 or num > 65535:
        return None
    return str(num)


def infer_asset_type(address: str) -> str:
    """IP and domain are equivalent asset hosts; type is display-only."""
    host = (address or "").split(":", 1)[0]
    if _IPV4.match(host):
        return "ip"
    return "domain"


def normalize_tags(value: object) -> list[str]:
    """Multi tags for grouping hosts; trim, de-dupe, keep order."""
    if value is None:
        return []
    items: list[str]
    if isinstance(value, str):
        items = re.split(r"[,;|\n]+", value)
    elif isinstance(value, list):
        items = []
        for item in value:
            if item is None:
                continue
            items.extend(re.split(r"[,;|\n]+", str(item)))
    else:
        items = [str(value)]
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        tag = str(item).strip()
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(tag)
    return out


def merge_tags(existing: object, incoming: object) -> list[str]:
    return normalize_tags(list(normalize_tags(existing)) + list(normalize_tags(incoming)))


IDENTITY_SCOPES = frozenset({"internet", "intranet", "dmz", "unknown"})
SCOPE_LABELS = {
    "internet": "公网",
    "intranet": "内网",
    "dmz": "DMZ",
    "unknown": "未标注",
}
KIND_LABELS = {
    "ip": "IP",
    "domain": "域名",
    "host": "主机",
}


def classify_identity_kind(normalized: str) -> str:
    host = (normalized or "").split(":", 1)[0]
    if _IPV4.match(host):
        return "ip"
    if host in {"localhost", "host.docker.internal"}:
        return "host"
    return "domain"


def make_identity(
    value: object,
    *,
    scope: str | None = None,
    label: str | None = None,
    primary: bool = False,
) -> dict[str, Any] | None:
    """Build one network identity dict, or None if value is not ledger-valid."""
    if not is_valid_ledger_address(value):
        return None
    norm = normalize_address(value)
    if not norm:
        return None
    sc = str(scope or "unknown").strip().lower()
    if sc not in IDENTITY_SCOPES:
        sc = "unknown"
    out: dict[str, Any] = {
        "kind": classify_identity_kind(norm),
        "value": norm,
        "scope": sc,
    }
    if label and str(label).strip():
        out["label"] = str(label).strip()
    if primary:
        out["primary"] = True
    return out


def extract_identities(properties: object, primary_address: object = None) -> list[dict[str, Any]]:
    """
    Return identities list for an asset.

    Always includes primary_address (Asset.address) as an identity when valid.
    Reads properties.identities when present.
    """
    props = properties if isinstance(properties, dict) else {}
    raw = props.get("identities")
    items: list[dict[str, Any]] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                # allow bare string entries
                ident = make_identity(item)
                if ident:
                    items.append(ident)
                continue
            ident = make_identity(
                item.get("value") or item.get("address") or item.get("host"),
                scope=item.get("scope"),
                label=item.get("label") or item.get("note"),
                primary=bool(item.get("primary")),
            )
            if ident:
                items.append(ident)

    primary = normalize_address(primary_address) if primary_address else ""
    if primary and is_valid_ledger_address(primary):
        if not any(i.get("value") == primary for i in items):
            items.insert(0, make_identity(primary, primary=True) or {"kind": classify_identity_kind(primary), "value": primary, "scope": "unknown", "primary": True})
        else:
            for i in items:
                if i.get("value") == primary:
                    i["primary"] = True
                elif "primary" in i and i.get("value") != primary:
                    i.pop("primary", None)

    # de-dupe by value, keep first (prefer earlier primary)
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for i in items:
        v = str(i.get("value") or "")
        if not v or v in seen:
            continue
        seen.add(v)
        out.append(i)
    return out


def identity_values(primary_address: object, properties: object) -> set[str]:
    """All normalized identity values for merge matching (identities + aliases + primary)."""
    keys = {str(i.get("value")) for i in extract_identities(properties, primary_address) if i.get("value")}
    keys |= set(extract_aliases(properties, primary_address))
    primary = normalize_address(primary_address) if primary_address else ""
    if primary:
        keys.add(primary)
    return {k for k in keys if k}


def extract_aliases(properties: object, primary_address: object = None) -> list[str]:
    """Extra addresses (IP/domain) beyond primary — low-friction multi-homing."""
    props = properties if isinstance(properties, dict) else {}
    primary = normalize_address(primary_address) if primary_address else ""
    raw = props.get("aliases")
    out: list[str] = []
    seen: set[str] = set()
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                val = item.get("value") or item.get("address") or item.get("host")
            else:
                val = item
            norm = normalize_address(val) if is_valid_ledger_address(val) else ""
            if not norm or norm == primary or norm in seen:
                continue
            seen.add(norm)
            out.append(norm)
    # Compat: identities that are not primary also act as aliases
    for ident in extract_identities(props, primary_address):
        v = str(ident.get("value") or "")
        if v and v != primary and v not in seen:
            seen.add(v)
            out.append(v)
    return out


def merge_aliases(
    existing: object,
    incoming: object,
    *,
    primary_address: object = None,
) -> list[str]:
    """Union alias strings; drops invalid and primary address."""
    primary = normalize_address(primary_address) if primary_address else ""
    base = extract_aliases(
        {"aliases": existing} if isinstance(existing, list) else (existing if isinstance(existing, dict) else {}),
        primary_address,
    )
    add: list[str] = []
    if isinstance(incoming, list):
        for item in incoming:
            if isinstance(item, dict):
                val = item.get("value") or item.get("address")
            else:
                val = item
            if is_valid_ledger_address(val):
                n = normalize_address(val)
                if n:
                    add.append(n)
    elif incoming is not None and is_valid_ledger_address(incoming):
        n = normalize_address(incoming)
        if n:
            add.append(n)
    seen: set[str] = set()
    out: list[str] = []
    for v in base + add:
        if not v or v == primary or v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out


def ensure_properties_aliases(properties: object, primary_address: object) -> dict[str, Any]:
    """Normalize aliases[] and keep identities in sync for older readers."""
    props = dict(properties) if isinstance(properties, dict) else {}
    primary = normalize_address(primary_address) if primary_address else ""
    aliases = extract_aliases(props, primary)
    props["aliases"] = aliases
    # Keep identities mirror for any leftover UI/API consumers
    idents = [{"value": primary, "primary": True, "scope": "unknown"}] if primary else []
    for a in aliases:
        idents.append({"value": a, "scope": "unknown"})
    props["identities"] = extract_identities({"identities": idents}, primary)
    return props


def parse_import_lines(text: object) -> list[dict[str, str]]:
    """
    Parse paste/CSV into asset rows: address[,name[,system]].

    Skips blank lines and header row if first cell looks like 'address'.
    """
    raw = str(text or "")
    rows: list[dict[str, str]] = []
    for line in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # CSV-ish split
        parts = [p.strip().strip('"').strip("'") for p in re.split(r"[,;\t]", line)]
        parts = [p for p in parts if p]
        if not parts:
            continue
        if parts[0].lower() in {"address", "ip", "host", "url", "地址"}:
            continue
        address = parts[0]
        if not is_valid_ledger_address(address):
            continue
        name = parts[1] if len(parts) > 1 else ""
        system = parts[2] if len(parts) > 2 else ""
        rows.append({
            "address": normalize_address(address),
            "name": name or normalize_address(address),
            "system": system,
        })
    return rows


def build_scope_allow(assets: list[dict[str, Any]]) -> list[str]:
    """Build task scope.allow from asset address + aliases."""
    allow: list[str] = []
    seen: set[str] = set()
    for a in assets:
        primary = normalize_address(a.get("address"))
        if primary and primary not in seen:
            seen.add(primary)
            allow.append(primary)
        for alias in extract_aliases(a.get("properties") or {}, primary):
            if alias not in seen:
                seen.add(alias)
                allow.append(alias)
        for ident in a.get("aliases") or []:
            n = normalize_address(ident) if is_valid_ledger_address(ident) else ""
            if n and n not in seen:
                seen.add(n)
                allow.append(n)
    return allow


def merge_identities(
    existing: object,
    incoming: object,
    *,
    primary_address: object = None,
) -> list[dict[str, Any]]:
    """Union identities by value; incoming scope/label overwrite when provided."""
    if isinstance(existing, list):
        base_props: dict[str, Any] = {"identities": existing}
    elif isinstance(existing, dict):
        base_props = existing if "identities" in existing else {"identities": existing.get("identities") or []}
    else:
        base_props = {"identities": []}
    base = extract_identities(base_props, primary_address)

    add: list[dict[str, Any]] = []
    if isinstance(incoming, list):
        for item in incoming:
            if isinstance(item, dict):
                ident = make_identity(
                    item.get("value") or item.get("address"),
                    scope=item.get("scope"),
                    label=item.get("label"),
                    primary=bool(item.get("primary")),
                )
            else:
                ident = make_identity(item)
            if ident:
                add.append(ident)
    elif incoming is not None:
        ident = make_identity(incoming)
        if ident:
            add.append(ident)

    by_val: dict[str, dict[str, Any]] = {str(i["value"]): dict(i) for i in base if i.get("value")}
    for ident in add:
        v = str(ident["value"])
        if v in by_val:
            prev = by_val[v]
            if ident.get("scope") and ident["scope"] != "unknown":
                prev["scope"] = ident["scope"]
            if ident.get("label"):
                prev["label"] = ident["label"]
            if ident.get("primary"):
                prev["primary"] = True
            by_val[v] = prev
        else:
            by_val[v] = dict(ident)

    primary = normalize_address(primary_address) if primary_address else ""
    result = list(by_val.values())
    for i in result:
        if primary and i.get("value") == primary:
            i["primary"] = True
        elif primary:
            i.pop("primary", None)
    if primary and primary not in by_val and is_valid_ledger_address(primary):
        p = make_identity(primary, primary=True)
        if p:
            result.insert(0, p)
    return extract_identities({"identities": result}, primary_address or (result[0]["value"] if result else None))


def ensure_properties_identities(properties: object, primary_address: object) -> dict[str, Any]:
    """Return properties dict with identities[] normalized and including primary."""
    props = dict(properties) if isinstance(properties, dict) else {}
    props["identities"] = extract_identities(props, primary_address)
    return props


def identities_summary(identities: list[dict[str, Any]] | None, *, max_items: int = 4) -> str:
    items = identities or []
    if not items:
        return ""
    parts: list[str] = []
    for i in items[:max_items]:
        val = str(i.get("value") or "")
        sc = str(i.get("scope") or "unknown")
        sc_l = SCOPE_LABELS.get(sc, sc)
        parts.append(f"{val}({sc_l})" if sc != "unknown" else val)
    extra = len(items) - max_items
    if extra > 0:
        parts.append(f"+{extra}")
    return " · ".join(parts)


def is_valid_ledger_address(value: object) -> bool:
    """
    True only for host/IP(/URL) suitable for the enterprise asset ledger.

    Rejects path-only pages (e.g. reflected.php, /admin/login) that agents
    sometimes emit as "assets".
    """
    raw = str(value or "").strip().strip("'\"")
    if not raw:
        return False
    if raw.lower() in _REJECT_ADDRESS_TOKENS:
        return False

    # Pure path or bare file name without host context.
    if raw.startswith("/") or raw.startswith("./") or raw.startswith("../"):
        return False
    bare = raw.split("?", 1)[0].rstrip("/")
    if "/" not in bare and "\\" not in bare and _FILE_LIKE_EXT.search(bare):
        return False
    # "dir/file.php" without scheme/host
    if "://" not in raw and not re.match(r"^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$", raw):
        if "/" in bare and _FILE_LIKE_EXT.search(bare.rsplit("/", 1)[-1]):
            # Allow only if a real host was extractable via normalize.
            pass

    norm = normalize_address(raw)
    if not norm or norm.lower() in _REJECT_ADDRESS_TOKENS:
        return False

    host = norm.split(":", 1)[0]
    if host in _REJECT_ADDRESS_TOKENS:
        return False
    if _FILE_LIKE_EXT.search(host):
        return False
    if _IPV4.match(host):
        return all(0 <= int(p) <= 255 for p in host.split("."))
    if host in {"localhost", "host.docker.internal"}:
        return True
    if _HOSTISH.match(host):
        return True
    return False


def type_label(asset_type: str | None) -> str:
    key = str(asset_type or "").strip().lower()
    return TYPE_LABELS.get(key, asset_type or "—")


def source_label(source: str | None) -> str:
    key = str(source or "").strip().lower()
    return SOURCE_LABELS.get(key, source or "—")


def extract_ports(properties: object) -> list[str]:
    """Ports hanging under this host (from services and open_ports)."""
    props = properties if isinstance(properties, dict) else {}
    ports = _normalize_port_list(props.get("open_ports") or props.get("ports") or [])
    for svc in extract_services(props):
        p = normalize_port(svc.get("port"))
        if p and p not in ports:
            ports.append(p)
    return _normalize_port_list(ports)


def extract_ports_for_host(host: object, *blobs: object) -> list[str]:
    """
    Pull port numbers for a given host from free text / URLs.

    Handles forms like:
      http://115.190.179.231:52799/path
      115.190.179.231:52799
    """
    host_n = normalize_address(host)
    if not host_n:
        return []
    found: list[str] = []
    host_re = re.escape(host_n)
    colon_pat = re.compile(rf"(?:https?://)?{host_re}:(\d{{1,5}})\b", re.IGNORECASE)
    url_pat = re.compile(r"https?://[^\s\"'<>)\]]+", re.IGNORECASE)
    for blob in blobs:
        text = str(blob or "")
        if not text:
            continue
        for m in colon_pat.finditer(text):
            p = normalize_port(m.group(1))
            if p:
                found.append(p)
        for um in url_pat.finditer(text):
            h, p = split_host_port(um.group(0))
            if h == host_n and p:
                found.append(p)
        # Whole blob may itself be a URL / host:port
        h, p = split_host_port(text.strip())
        if h == host_n and p:
            found.append(p)
    return _normalize_port_list(found)


def service_hints_for_host(host: object, *blobs: object) -> list[dict[str, Any]]:
    """Build {port, name} from URLs (http/https) mentioning this host."""
    host_n = normalize_address(host)
    if not host_n:
        return []
    by_port: dict[str, str] = {}
    url_pat = re.compile(r"https?://[^\s\"'<>)\]]+", re.IGNORECASE)
    for blob in blobs:
        text = str(blob or "")
        for um in url_pat.finditer(text):
            raw = um.group(0)
            try:
                h, p = split_host_port(raw)
            except Exception:
                continue
            if h != host_n or not p:
                continue
            scheme = "https" if raw.lower().startswith("https://") else "http"
            prev = by_port.get(p)
            if prev != "https":
                by_port[p] = scheme
        # Only try whole-blob parse when it looks like a single address/URL.
        stripped = text.strip()
        if stripped and len(stripped) < 260 and ("://" in stripped or re.search(r":\d{2,5}(?:/|$)", stripped)):
            try:
                h, p = split_host_port(stripped)
            except Exception:
                h, p = "", None
            if h == host_n and p:
                scheme = "https" if stripped.lower().startswith("https://") else "http"
                if by_port.get(p) != "https":
                    by_port[p] = scheme
    # bare host:port without scheme → empty name (still a port card)
    for p in extract_ports_for_host(host_n, *blobs):
        by_port.setdefault(p, "")
    return [{"port": p, "name": name} for p, name in sorted(by_port.items(), key=lambda x: int(x[0]) if x[0].isdigit() else 0)]


def conversation_target_blobs(context: object) -> list[str]:
    """Collect target / allow / instruction strings from conversation.context."""
    if not isinstance(context, dict):
        return []
    blobs: list[str] = []
    task = context.get("task") if isinstance(context.get("task"), dict) else {}
    target = task.get("target") if isinstance(task.get("target"), dict) else {}
    if target.get("value"):
        blobs.append(str(target.get("value")))
    if task.get("instruction"):
        blobs.append(str(task.get("instruction")))
    scope = task.get("scope") if isinstance(task.get("scope"), dict) else {}
    for item in scope.get("allow") or []:
        blobs.append(str(item))
    checkpoint = context.get("checkpoint") if isinstance(context.get("checkpoint"), dict) else {}
    for key in ("target_url", "target"):
        val = checkpoint.get(key)
        if isinstance(val, dict):
            blobs.append(str(val.get("value") or ""))
        elif val:
            blobs.append(str(val))
    return [b for b in blobs if b]


def enrich_properties_ports(
    properties: object,
    *,
    host: object,
    related: list[dict[str, Any]] | None = None,
    extra_blobs: list[str] | None = None,
) -> dict[str, Any]:
    """
    Merge ports/services from existing properties + related findings + free-text blobs
    (e.g. conversation task target URL). Does not drop existing data.
    """
    props = dict(properties) if isinstance(properties, dict) else {}
    blobs: list[str] = list(extra_blobs or [])
    ports_in: list[str] = []
    services_in: list[dict[str, Any]] = []

    for item in related or []:
        if not isinstance(item, dict):
            continue
        p = normalize_port(item.get("port"))
        if p:
            ports_in.append(p)
            services_in.append({"port": p, "name": str(item.get("service") or item.get("name") or "")})
        for key in ("location", "poc", "description", "endpoint", "url", "affected_asset"):
            if item.get(key):
                blobs.append(str(item.get(key)))

    hints = service_hints_for_host(host, *blobs)
    for h in hints:
        ports_in.append(str(h.get("port") or ""))
        services_in.append(h)
    ports_in.extend(extract_ports_for_host(host, *blobs))

    return merge_discover_properties(
        props,
        open_ports=ports_in or None,
        services=services_in or None,
    )


def extract_services(properties: object) -> list[dict[str, Any]]:
    """One service record per port under this host."""
    props = properties if isinstance(properties, dict) else {}
    raw = props.get("services") or props.get("fingerprints") or []
    services = _normalize_service_list(raw)
    # Ensure bare open_ports appear as services with empty name.
    known = {normalize_port(s.get("port")) for s in services}
    for p in _normalize_port_list(props.get("open_ports") or props.get("ports") or []):
        if p not in known:
            services.append({"port": p, "name": ""})
            known.add(p)
    return services


def ports_summary(properties: object, *, max_items: int = 8) -> str:
    services = extract_services(properties)
    if not services:
        return ""
    parts: list[str] = []
    for svc in services:
        port = normalize_port(svc.get("port")) or "?"
        name = str(svc.get("name") or svc.get("service") or svc.get("product") or "").strip()
        parts.append(f"{port}/{name}" if name else port)
        if len(parts) >= max_items:
            break
    extra = len(services) - max_items
    if extra > 0:
        parts.append(f"+{extra}")
    return ", ".join(parts)


def tech_summary(properties: object, *, max_items: int = 4) -> str:
    services = extract_services(properties)
    labels: list[str] = []
    seen: set[str] = set()
    for svc in services:
        name = str(svc.get("name") or svc.get("service") or svc.get("product") or "").strip()
        version = str(svc.get("version") or "").strip()
        if not name:
            continue
        label = f"{name} {version}".strip() if version else name
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        labels.append(label)
        if len(labels) >= max_items:
            break
    return ", ".join(labels)


def risk_summary_from_vulns(vulns: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Build risk counts from related vulnerability dicts (severity/status keys)."""
    counts = {s: 0 for s in SEVERITY_ORDER}
    open_total = 0
    for item in vulns or []:
        if not isinstance(item, dict):
            continue
        status = str(item.get("status") or "").strip().lower()
        if status and status not in OPEN_VULN_STATUSES and status in {
            "fixed", "closed", "false_positive", "rejected", "duplicate", "risk_accepted"
        }:
            continue
        if status in {"fixed", "closed", "false_positive", "rejected", "duplicate", "risk_accepted"}:
            continue
        sev = str(item.get("severity") or "info").strip().lower()
        if sev not in counts:
            sev = "info"
        # Treat missing status as open.
        if not status or status in OPEN_VULN_STATUSES:
            counts[sev] += 1
            open_total += 1
    highest = "none"
    for sev in SEVERITY_ORDER:
        if counts[sev] > 0:
            highest = sev
            break
    return {
        "open_total": open_total,
        "by_severity": counts,
        "highest": highest,
        "label": _risk_label(highest, open_total, counts),
    }


def _risk_label(highest: str, open_total: int, counts: dict[str, int]) -> str:
    if open_total <= 0:
        return "无开放漏洞"
    parts = [f"{s}:{counts[s]}" for s in SEVERITY_ORDER if counts[s]]
    return f"{open_total} 开放 · " + " ".join(parts)


def merge_port_lists(existing: object, incoming: object) -> list[str]:
    return _normalize_port_list(list(_normalize_port_list(existing)) + list(_normalize_port_list(incoming)))


def merge_service_lists(existing: object, incoming: object) -> list[dict[str, Any]]:
    """One service per port; later non-empty fields overwrite."""
    by_port: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for item in _normalize_service_list(existing) + _normalize_service_list(incoming):
        port = normalize_port(item.get("port"))
        if not port:
            # Service without port cannot hang under host model; skip.
            continue
        prev = by_port.get(port)
        if not prev:
            cleaned = dict(item)
            cleaned["port"] = port
            # Canonical service name field.
            name = str(
                cleaned.get("name") or cleaned.get("service") or cleaned.get("product") or ""
            ).strip()
            if name:
                cleaned["name"] = name
            if cleaned.get("_note_set") or "note" in cleaned or "remark" in cleaned:
                note = _service_note(cleaned)
                if note:
                    cleaned["note"] = note
                else:
                    cleaned.pop("note", None)
                    cleaned.pop("remark", None)
            cleaned.pop("_note_set", None)
            by_port[port] = cleaned
            order.append(port)
            continue
        for field in ("version", "product", "name", "service", "protocol", "state", "banner", "url", "uri", "endpoint"):
            if item.get(field):
                prev[field] = item[field]
        # Canonical url from uri/endpoint aliases when url empty.
        if not prev.get("url"):
            for alt in ("uri", "endpoint"):
                if prev.get(alt):
                    prev["url"] = prev[alt]
                    break
        # User/agent notes: only overwrite when incoming explicitly sets note/remark.
        if item.get("_note_set") or "note" in item or "remark" in item:
            note = _service_note(item)
            if note:
                prev["note"] = note
            else:
                prev.pop("note", None)
                prev.pop("remark", None)
        prev.pop("_note_set", None)
        name = str(prev.get("name") or prev.get("service") or prev.get("product") or "").strip()
        if name:
            prev["name"] = name
        prev["port"] = port
        by_port[port] = prev
    return [{k: v for k, v in by_port[p].items() if k != "_note_set"} for p in order]


def _service_note(item: dict[str, Any]) -> str:
    return str(item.get("note") or item.get("remark") or item.get("comment") or "").strip()


def normalize_url_list(value: object) -> list[str]:
    """De-dupe URL strings (order-preserving, case-sensitive path)."""
    if value is None:
        return []
    items: list[object]
    if isinstance(value, str):
        items = re.split(r"[\n,;]+", value)
    elif isinstance(value, list):
        items = value
    else:
        items = [value]
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        if isinstance(item, dict):
            text = str(
                item.get("url") or item.get("uri") or item.get("href") or item.get("endpoint") or ""
            ).strip()
        else:
            text = str(item or "").strip()
        if not text or text in seen:
            continue
        # Accept absolute URLs, relative paths, or host/path forms; drop bare tokens.
        if "://" not in text and not text.startswith("/"):
            first = text.split("/", 1)[0]
            if "." not in first and first not in {"localhost", "host.docker.internal"}:
                continue
        seen.add(text)
        out.append(text)
    return out


def normalize_api_endpoint_list(value: object) -> list[dict[str, Any]]:
    """Normalize API endpoints to dicts with at least path or url."""
    if value is None:
        return []
    items: list[object]
    if isinstance(value, str):
        items = re.split(r"[\n,;]+", value)
    elif isinstance(value, list):
        items = value
    else:
        items = [value]
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        if isinstance(item, dict):
            method = str(item.get("method") or item.get("verb") or "").strip().upper()
            path = str(item.get("path") or item.get("route") or "").strip()
            url = str(item.get("url") or item.get("uri") or item.get("endpoint") or "").strip()
            if not path and not url:
                continue
            key = f"{method}|{path}|{url}".lower()
            if key in seen:
                continue
            seen.add(key)
            row: dict[str, Any] = {}
            if method:
                row["method"] = method
            if path:
                row["path"] = path
            if url:
                row["url"] = url
            name = str(item.get("name") or item.get("summary") or "").strip()
            if name:
                row["name"] = name
            out.append(row)
            continue
        text = str(item or "").strip()
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        if text.startswith("/") or "://" not in text:
            out.append({"path": text})
        else:
            out.append({"url": text})
    return out


def merge_url_lists(existing: object, incoming: object) -> list[str]:
    return normalize_url_list(list(normalize_url_list(existing)) + list(normalize_url_list(incoming)))


def merge_api_endpoint_lists(existing: object, incoming: object) -> list[dict[str, Any]]:
    """Union endpoints; later non-empty fields enrich same method+path/url key."""
    by_key: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for item in normalize_api_endpoint_list(existing) + normalize_api_endpoint_list(incoming):
        method = str(item.get("method") or "").strip().upper()
        path = str(item.get("path") or "").strip()
        url = str(item.get("url") or "").strip()
        key = f"{method}|{path}|{url}".lower() if (path or url) else ""
        if not key:
            continue
        # Prefer method+path identity when both present so URL can fill in later.
        identity = f"{method}|{path}".lower() if path else key
        prev = by_key.get(identity) or by_key.get(key)
        if not prev:
            cleaned = dict(item)
            by_key[identity] = cleaned
            if identity not in order:
                order.append(identity)
            continue
        for field in ("method", "path", "url", "name"):
            if item.get(field):
                prev[field] = item[field]
        by_key[identity] = prev
    return [by_key[k] for k in order if k in by_key]


def extract_urls(properties: object) -> list[str]:
    props = properties if isinstance(properties, dict) else {}
    return normalize_url_list(props.get("urls") or props.get("web_urls") or [])


def extract_api_endpoints(properties: object) -> list[dict[str, Any]]:
    props = properties if isinstance(properties, dict) else {}
    return normalize_api_endpoint_list(
        props.get("api_endpoints") or props.get("endpoints") or props.get("apis") or []
    )


def merge_discover_properties(
    existing_properties: object,
    *,
    open_ports: object = None,
    services: object = None,
    urls: object = None,
    api_endpoints: object = None,
    extra: dict | None = None,
) -> dict[str, Any]:
    """Merge discover payload; services keyed by port, open_ports derived; urls/apis unioned."""
    base = dict(existing_properties) if isinstance(existing_properties, dict) else {}
    # Drop multi-host fields — one asset = one host.
    base.pop("aliases", None)
    base.pop("identities", None)

    existing_services = extract_services(base)
    incoming_services = _normalize_service_list(services) if services is not None else []
    # Promote bare ports into service shells.
    for p in _normalize_port_list(open_ports if open_ports is not None else []):
        if not any(normalize_port(s.get("port")) == p for s in incoming_services):
            incoming_services.append({"port": p, "name": ""})

    merged_services = merge_service_lists(existing_services, incoming_services)
    base["services"] = merged_services
    base["open_ports"] = [str(s.get("port")) for s in merged_services if s.get("port")]

    if urls is not None:
        base["urls"] = merge_url_lists(base.get("urls") or base.get("web_urls"), urls)
    if api_endpoints is not None:
        base["api_endpoints"] = merge_api_endpoint_lists(
            base.get("api_endpoints") or base.get("endpoints") or base.get("apis"),
            api_endpoints,
        )

    if extra:
        for key, value in extra.items():
            if key in {
                "open_ports", "services", "ports", "fingerprints",
                "aliases", "identities", "system", "business_system",
                "urls", "web_urls", "api_endpoints", "endpoints", "apis",
            }:
                continue
            base[key] = value
    return base


def apply_discover_to_asset_fields(
    *,
    existing: dict[str, Any] | None,
    address: str,
    name: str | None = None,
    asset_type: str | None = None,
    open_ports: object = None,
    services: object = None,
    urls: object = None,
    api_endpoints: object = None,
    source: str | None = None,
    identity_scope: str | None = None,
    port: object = None,
) -> dict[str, Any]:
    """
    Pure merge of one discover event into an asset field dict.

    One asset = one host (IP or domain). Ports from the address, `port` arg,
    open_ports, or services are unioned under properties.services.
    URLs and API endpoints are unioned under properties.urls / api_endpoints.
    Different hosts never merge into the same asset.

    When existing is None, returns a field dict suitable for *user* create only.
    Agent paths must not create rows from this alone — see upsert_discovered_asset.
    """
    host, addr_port = split_host_port(address)
    if not host:
        host = normalize_address(address)
    extra_ports: list[str] = []
    for candidate in (addr_port, normalize_port(port)):
        if candidate:
            extra_ports.append(candidate)

    ports_in = merge_port_lists(open_ports, extra_ports) if (open_ports is not None or extra_ports) else open_ports
    if extra_ports and open_ports is None and services is None:
        ports_in = extra_ports

    # If services given without ports, still merge ports from address/port arg.
    services_in = services
    if extra_ports:
        svc_list = _normalize_service_list(services_in) if services_in is not None else []
        for p in extra_ports:
            if not any(normalize_port(s.get("port")) == p for s in svc_list):
                svc_list.append({"port": p, "name": ""})
        services_in = svc_list
        if ports_in is None:
            ports_in = extra_ports

    name_in = _nonempty_str(name)
    type_in = _nonempty_str(asset_type)

    if existing:
        primary = normalize_address(existing.get("address") or host) or host
        # Only merge when host matches; callers should find by exact host.
        props = merge_discover_properties(
            existing.get("properties"),
            open_ports=ports_in,
            services=services_in,
            urls=urls,
            api_endpoints=api_endpoints,
        )
        # Preserve ledger ownership source (manual/import). Agent enrich never rewrites it.
        kept_source = (
            _nonempty_str(existing.get("source"))
            or _nonempty_str(source)
            or "manual"
        )
        return {
            "address": primary,
            "name": name_in or _nonempty_str(existing.get("name")) or primary,
            "type": type_in or _nonempty_str(existing.get("type")) or infer_asset_type(primary),
            "source": kept_source,
            "properties": props,
        }

    props = merge_discover_properties(
        {},
        open_ports=ports_in or [],
        services=services_in or [],
        urls=urls,
        api_endpoints=api_endpoints,
    )
    return {
        "address": host,
        "name": name_in or host,
        "type": type_in or infer_asset_type(host),
        "source": _nonempty_str(source) or "manual",
        "properties": props,
    }


def _nonempty_str(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def render_remediation_markdown(
    asset: dict[str, Any],
    vulns: list[dict[str, Any]],
    *,
    generated_at: datetime | None = None,
) -> str:
    """Build a developer-facing remediation package for one asset."""
    generated_at = generated_at or datetime.now(timezone.utc)
    name = str(asset.get("name") or asset.get("address") or "资产")
    address = str(asset.get("address") or "—")
    props = asset.get("properties") if isinstance(asset.get("properties"), dict) else {}
    ports = extract_ports(props)
    tech = tech_summary(props) or "—"
    tags = asset.get("tags") if isinstance(asset.get("tags"), list) else []
    services = extract_services(props)
    port_lines = []
    for s in services:
        p = s.get("port") or "?"
        n = s.get("name") or s.get("service") or s.get("product") or ""
        note = str(s.get("note") or s.get("remark") or "").strip()
        base = f"{p}/{n}" if n else str(p)
        port_lines.append(f"{base} — {note}" if note else base)
    lines = [
        f"# 资产整改清单：{name}",
        "",
        "## 资产信息",
        f"- 名称：{name}",
        f"- 地址（IP/域名）：`{address}`",
        f"- 标签：{', '.join(str(t) for t in tags) if tags else '—'}",
        f"- 来源：{source_label(str(asset.get('source') or ''))}",
        f"- 端口/服务：{', '.join(port_lines) if port_lines else (', '.join(ports) if ports else '—')}",
        f"- 指纹/技术：{tech}",
        f"- 生成时间：`{generated_at.isoformat()}`",
        "",
        "## 关联漏洞（本主机全部端口，开放项优先）",
    ]
    open_vulns = [v for v in vulns if _is_open_vuln(v)]
    closed_vulns = [v for v in vulns if not _is_open_vuln(v)]
    ordered = open_vulns + closed_vulns
    if not ordered:
        lines.extend(["暂无关联漏洞。", ""])
    else:
        for v in ordered:
            port = v.get("port") or "—"
            lines.extend([
                f"### {v.get('title') or '未命名漏洞'}",
                f"- 端口：`{port}`",
                f"- 严重级别：`{v.get('severity') or 'info'}`",
                f"- 状态：`{v.get('status') or '—'}`",
                f"- 置信度：`{v.get('confidence') or '—'}`",
                "",
                str(v.get("description") or "（无描述）").strip(),
                "",
            ])
            if v.get("remediation"):
                lines.extend(["**修复建议**", "", str(v.get("remediation")).strip(), ""])
    lines.extend(["## 说明", "", "本清单按资产聚合，便于交付开发整改。详细证据与复现过程见对应会话。", ""])
    return "\n".join(lines)


def render_remediation_html(asset: dict[str, Any], vulns: list[dict[str, Any]]) -> str:
    md = render_remediation_markdown(asset, vulns)
    # Minimal HTML wrap; escape content as preformatted body for safe download.
    escaped = (
        md.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    title = str(asset.get("name") or asset.get("address") or "asset")
    return (
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
        f"<title>整改清单 - {title}</title></head>"
        f"<body><pre style=\"white-space:pre-wrap;font-family:ui-monospace,monospace\">{escaped}</pre>"
        "</body></html>"
    )


def compute_security_changes(
    assets: list[dict[str, Any]],
    vulns: list[dict[str, Any]],
    *,
    now: datetime | None = None,
    days: int = 7,
) -> dict[str, Any]:
    """
    Derive a 7-day security change summary from asset/vuln timestamps.

    Approximation (no separate history table):
    - new_assets: created_at in window
    - updated_assets: updated_at in window and not newly created
    - new_findings: discovered_at in window
    - updated_findings: updated_at in window and discovered_at before window
    """
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    window_start = now - timedelta(days=max(1, days))

    new_assets: list[dict[str, Any]] = []
    updated_assets: list[dict[str, Any]] = []
    for a in assets:
        created = _parse_dt(a.get("created_at"))
        updated = _parse_dt(a.get("updated_at"))
        row = {
            "id": a.get("id"),
            "name": a.get("name"),
            "address": a.get("address"),
            "type": a.get("type"),
            "created_at": a.get("created_at"),
            "updated_at": a.get("updated_at"),
        }
        if created and window_start <= created <= now:
            new_assets.append(row)
        elif updated and window_start <= updated <= now:
            updated_assets.append(row)

    new_findings: list[dict[str, Any]] = []
    updated_findings: list[dict[str, Any]] = []
    for v in vulns:
        discovered = _parse_dt(v.get("discovered_at"))
        updated = _parse_dt(v.get("updated_at"))
        row = {
            "id": v.get("id"),
            "title": v.get("title"),
            "severity": v.get("severity"),
            "status": v.get("status"),
            "asset_id": v.get("asset_id"),
            "discovered_at": v.get("discovered_at"),
            "updated_at": v.get("updated_at"),
        }
        if discovered and window_start <= discovered <= now:
            new_findings.append(row)
        elif updated and window_start <= updated <= now and (not discovered or discovered < window_start):
            updated_findings.append(row)

    return {
        "window_days": days,
        "window_start": window_start.isoformat(),
        "window_end": now.isoformat(),
        "counts": {
            "new_assets": len(new_assets),
            "updated_assets": len(updated_assets),
            "new_findings": len(new_findings),
            "updated_findings": len(updated_findings),
        },
        "new_assets": new_assets,
        "updated_assets": updated_assets,
        "new_findings": new_findings,
        "updated_findings": updated_findings,
    }


def render_changes_markdown(summary: dict[str, Any]) -> str:
    counts = summary.get("counts") or {}
    lines = [
        "# 近 7 天资产安全变化",
        "",
        f"- 窗口：`{summary.get('window_start')}` → `{summary.get('window_end')}`",
        f"- 新增资产：{counts.get('new_assets', 0)}",
        f"- 更新资产：{counts.get('updated_assets', 0)}",
        f"- 新增漏洞：{counts.get('new_findings', 0)}",
        f"- 状态变化漏洞：{counts.get('updated_findings', 0)}",
        "",
        "## 新增资产",
    ]
    for a in summary.get("new_assets") or []:
        lines.append(f"- `{a.get('address') or a.get('name')}` ({a.get('type') or '—'})")
    if not summary.get("new_assets"):
        lines.append("- （无）")
    lines.extend(["", "## 更新资产"])
    for a in summary.get("updated_assets") or []:
        lines.append(f"- `{a.get('address') or a.get('name')}`")
    if not summary.get("updated_assets"):
        lines.append("- （无）")
    lines.extend(["", "## 新增漏洞"])
    for v in summary.get("new_findings") or []:
        lines.append(f"- [{v.get('severity') or 'info'}] {v.get('title')} (`{v.get('status')}`)")
    if not summary.get("new_findings"):
        lines.append("- （无）")
    lines.extend(["", "## 状态变化漏洞"])
    for v in summary.get("updated_findings") or []:
        lines.append(f"- [{v.get('severity') or 'info'}] {v.get('title')} (`{v.get('status')}`)")
    if not summary.get("updated_findings"):
        lines.append("- （无）")
    lines.append("")
    return "\n".join(lines)


def _is_open_vuln(v: dict[str, Any]) -> bool:
    status = str(v.get("status") or "").strip().lower()
    if status in {"fixed", "closed", "false_positive", "rejected", "duplicate", "risk_accepted"}:
        return False
    return True


def _normalize_port_list(raw: object) -> list[str]:
    if raw is None:
        return []
    items: list[str] = []
    if not isinstance(raw, list):
        raw = [raw]
    for item in raw:
        p = normalize_port(item)
        if p:
            items.append(p)
    uniq = list(dict.fromkeys(items))

    def sort_key(p: str) -> tuple:
        try:
            return (0, int(p))
        except ValueError:
            return (1, p)

    return sorted(uniq, key=sort_key)


def _normalize_service_list(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            if item is None or item == "":
                continue
            # Bare name without port is incomplete under host+port model.
            continue
        note_explicit = "note" in item or "remark" in item or "comment" in item
        cleaned = {k: v for k, v in item.items() if v is not None and v != ""}
        port = normalize_port(cleaned.get("port") or cleaned.get("number") or item.get("port") or item.get("number"))
        if not port:
            continue
        cleaned["port"] = port
        name = str(cleaned.get("name") or cleaned.get("service") or cleaned.get("product") or "").strip()
        if name:
            cleaned["name"] = name
        # Preserve explicit note key (including empty) so merge can clear user notes.
        if note_explicit:
            cleaned["note"] = _service_note(item)
            cleaned["_note_set"] = True
        out.append(cleaned)
    return out


def _parse_dt(value: object) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt
    text = str(value).strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None
