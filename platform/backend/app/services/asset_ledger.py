"""Asset ledger helpers: normalize, merge exposure, risk summary, export, 7-day changes.

Pure functions (no DB) so unit tests can drive the real shipped logic.
Discovery and list APIs call these; ports/services live in Asset.properties JSONB.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

SEVERITY_ORDER = ("critical", "high", "medium", "low", "info")

TYPE_LABELS = {
    "host": "主机",
    "web": "Web",
    "web_app": "Web 应用",
    "cloud_service": "云服务",
    "code_repo": "代码仓库",
}

SOURCE_LABELS = {
    "manual": "人工录入",
    "agent_discovered": "Agent 发现",
    "agent": "Agent 发现",
    "import": "导入",
}

# Statuses treated as still open for risk / remediation export.
OPEN_VULN_STATUSES = frozenset({
    "pending",
    "open",
    "confirmed",
    "candidate",
    "in_progress",
    "retest",
    "verified",
    "accepted",
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
    """Normalize host/URL/IP to a stable merge key (lowercase host[:port], no path)."""
    raw = str(value or "").strip().strip("'\"")
    if not raw:
        return ""

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

    parsed = urlparse(raw if "://" in raw else f"//{raw}")
    if parsed.hostname:
        # Host+port only (no scheme/path) so manual and agent forms merge.
        host = parsed.hostname.lower()
        # Agents sometimes emit "reflected.php" which regex mistreats as host.tld.
        if _FILE_LIKE_EXT.search(host) or host in _REJECT_ADDRESS_TOKENS:
            return ""
        try:
            port_value = parsed.port
        except ValueError:
            port_value = None
        port = f":{port_value}" if port_value else ""
        return f"{host}{port}"

    # Do not fall back to raw path/filename — empty signals "not a ledger asset".
    return ""


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
    props = properties if isinstance(properties, dict) else {}
    raw = props.get("open_ports") or props.get("ports") or []
    return _normalize_port_list(raw)


def extract_services(properties: object) -> list[dict[str, Any]]:
    props = properties if isinstance(properties, dict) else {}
    raw = props.get("services") or props.get("fingerprints") or []
    return _normalize_service_list(raw)


def ports_summary(properties: object, *, max_items: int = 8) -> str:
    ports = extract_ports(properties)
    if not ports:
        return ""
    if len(ports) <= max_items:
        return ", ".join(ports)
    return ", ".join(ports[:max_items]) + f" +{len(ports) - max_items}"


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
    by_key: dict[str, dict[str, Any]] = {}
    for item in _normalize_service_list(existing) + _normalize_service_list(incoming):
        port = str(item.get("port") or "")
        name = str(item.get("name") or item.get("service") or item.get("product") or "").lower()
        key = f"{port}|{name}" or str(item)
        prev = by_key.get(key)
        if not prev:
            by_key[key] = dict(item)
            continue
        # Prefer non-empty version/product from newer.
        for field in ("version", "product", "name", "service", "protocol", "state"):
            if item.get(field) and not prev.get(field):
                prev[field] = item[field]
            elif item.get(field):
                prev[field] = item[field]
        by_key[key] = prev
    return list(by_key.values())


def merge_discover_properties(
    existing_properties: object,
    *,
    open_ports: object = None,
    services: object = None,
    extra: dict | None = None,
) -> dict[str, Any]:
    """Merge discover payload into existing properties; ports/services unioned."""
    base = dict(existing_properties) if isinstance(existing_properties, dict) else {}
    if open_ports is not None:
        base["open_ports"] = merge_port_lists(base.get("open_ports"), open_ports)
    else:
        base["open_ports"] = extract_ports(base)
    if services is not None:
        base["services"] = merge_service_lists(base.get("services"), services)
    else:
        base["services"] = extract_services(base)
    if extra:
        for key, value in extra.items():
            if key in {"open_ports", "services", "ports", "fingerprints"}:
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
    source: str = "agent_discovered",
) -> dict[str, Any]:
    """
    Pure merge of one discover event into an asset field dict.

    existing keys: address, name, type, source, properties
    Returns full field dict ready for ORM apply or assert in tests.
    """
    norm = normalize_address(address)
    name_in = _nonempty_str(name)
    type_in = _nonempty_str(asset_type)
    if existing:
        props = merge_discover_properties(
            existing.get("properties"),
            open_ports=open_ports,
            services=services,
        )
        # Preserve ledger identity when discover payload omits name/type.
        out = {
            "address": normalize_address(existing.get("address") or norm),
            "name": name_in or _nonempty_str(existing.get("name")) or norm,
            "type": type_in or _nonempty_str(existing.get("type")) or "host",
            "source": _nonempty_str(source) or _nonempty_str(existing.get("source")) or "agent_discovered",
            "properties": props,
        }
        return out
    return {
        "address": norm,
        "name": name_in or norm,
        "type": type_in or "host",
        "source": _nonempty_str(source) or "agent_discovered",
        "properties": merge_discover_properties(
            {},
            open_ports=open_ports or [],
            services=services or [],
        ),
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
    lines = [
        f"# 资产整改清单：{name}",
        "",
        "## 资产信息",
        f"- 名称：{name}",
        f"- 地址：`{address}`",
        f"- 类型：{type_label(str(asset.get('type') or ''))}",
        f"- 来源：{source_label(str(asset.get('source') or ''))}",
        f"- 开放端口：{', '.join(ports) if ports else '—'}",
        f"- 指纹/技术：{tech}",
        f"- 生成时间：`{generated_at.isoformat()}`",
        "",
        "## 关联漏洞（开放项优先）",
    ]
    open_vulns = [v for v in vulns if _is_open_vuln(v)]
    closed_vulns = [v for v in vulns if not _is_open_vuln(v)]
    ordered = open_vulns + closed_vulns
    if not ordered:
        lines.extend(["暂无关联漏洞。", ""])
    else:
        for v in ordered:
            lines.extend([
                f"### {v.get('title') or '未命名漏洞'}",
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
        if isinstance(item, dict):
            port = item.get("port") or item.get("number")
        else:
            port = item
        if port is None or port == "":
            continue
        text = str(port).strip()
        if not text:
            continue
        items.append(text)
    # unique, numeric sort when possible
    uniq = list(dict.fromkeys(items))

    def sort_key(p: str) -> tuple:
        try:
            return (0, int(p.split("/")[0]))
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
            out.append({"name": str(item)})
            continue
        cleaned = {k: v for k, v in item.items() if v is not None and v != ""}
        if cleaned:
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
