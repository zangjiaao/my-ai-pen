"""Run-level workflow gates for coverage-first web assessment."""

from __future__ import annotations

import json
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from strix.tools.run_memory.tools import attack_surface_from_file, coverage_from_file


WORKFLOW_STATE_FILENAME = "workflow_state.json"

_RECON_KEYWORDS = {
    "attack surface",
    "crawl",
    "crawler",
    "discovery",
    "discover",
    "enumerate",
    "inventory",
    "map",
    "mapping",
    "recon",
    "reconnaissance",
    "request history",
    "route",
    "sitemap",
}
_MEANINGFUL_COVERAGE_STATUSES = {"tried", "passed", "failed"}
_HTTP_METHOD_RE = re.compile(r"^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(.+)$", re.IGNORECASE)
_STATIC_EXTENSIONS = {
    ".avif",
    ".bmp",
    ".css",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".map",
    ".otf",
    ".png",
    ".svg",
    ".ttf",
    ".webp",
    ".woff",
    ".woff2",
}
_DYNAMIC_PATH_HINTS = (
    "/api/",
    "/rest/",
    "/graphql",
    "/auth",
    "/login",
    "/logout",
    "/admin",
    "/user",
    "/users",
    "/basket",
    "/cart",
    "/order",
    "/checkout",
    "/payment",
    "/wallet",
    "/coupon",
    "/feedback",
    "/captcha",
    "/upload",
    "/profile",
    "/reset",
    "/forgot",
    "/security",
    "/review",
)
_UNBOUNDED_TASK_PHRASES = (
    "any other",
    "all endpoint",
    "all api",
    "all route",
    "entire app",
    "entire application",
    "whole app",
    "whole application",
    "other user input",
    "other input",
)
_RECORDED_WORK_FOLLOWUP_KEYWORDS = (
    "confirm",
    "confirmed",
    "evidence",
    "report",
    "reproduce",
    "validate",
    "validation",
    "verify",
)


def state_dir_from_raw(raw: Any) -> Path | None:
    if isinstance(raw, Path):
        return raw
    if isinstance(raw, str) and raw.strip():
        return Path(raw)
    return None


def workflow_state_path(state_dir: Path) -> Path:
    return state_dir / WORKFLOW_STATE_FILENAME


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _default_state(*, caido_available: bool = False) -> dict[str, Any]:
    return {
        "caido_available": bool(caido_available),
        "authorized_targets": [],
        "authorized_hosts": [],
        "sitemap_attempted": False,
        "sitemap_success": False,
        "sitemap_entry_count": 0,
        "sitemap_error": "",
        "sitemap_call_count": 0,
        "sitemap_branches": {},
        "sitemap_entry_index": {},
        "sitemap_expandable_entries": [],
        "sitemap_expanded_parent_ids": [],
        "external_discoveries": [],
        "external_discovery_count": 0,
        "out_of_scope_external_discoveries": {},
        "out_of_scope_external_discovery_count": 0,
        "created_at": _now(),
        "updated_at": _now(),
    }


def load_workflow_state(state_dir: Path | None) -> dict[str, Any]:
    if state_dir is None:
        return _default_state(caido_available=False)
    path = workflow_state_path(state_dir)
    if not path.exists():
        return _default_state(caido_available=False)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _default_state(caido_available=False)
    if not isinstance(raw, dict):
        return _default_state(caido_available=False)
    state = _default_state(caido_available=bool(raw.get("caido_available")))
    state.update(raw)
    return state


def save_workflow_state(state_dir: Path, state: dict[str, Any]) -> None:
    payload = dict(state)
    payload["updated_at"] = _now()
    path = workflow_state_path(state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp.write(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)


def initialize_workflow_state(
    state_dir: Path,
    *,
    caido_available: bool,
    authorized_targets: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    state = load_workflow_state(state_dir)
    state["caido_available"] = bool(caido_available)
    if authorized_targets is not None:
        state["authorized_targets"] = [
            dict(item)
            for item in authorized_targets
            if isinstance(item, dict)
        ]
        state["authorized_hosts"] = authorized_hosts_from_targets(authorized_targets)
    state.setdefault("created_at", _now())
    save_workflow_state(state_dir, state)
    return state


def mark_sitemap_attempt(
    state_dir: Path | None,
    *,
    success: bool,
    entry_count: int = 0,
    error: str = "",
    entries: list[dict[str, Any]] | None = None,
    parent_id: str | None = None,
    depth: str | None = None,
    page: int | None = None,
    total_pages: int | None = None,
    total_count: int | None = None,
    has_more: bool | None = None,
) -> dict[str, Any]:
    if state_dir is None:
        return _default_state(caido_available=False)
    state = load_workflow_state(state_dir)
    state["sitemap_attempted"] = True
    state["sitemap_success"] = bool(success)
    state["sitemap_entry_count"] = max(
        int(state.get("sitemap_entry_count") or 0),
        max(0, int(total_count or entry_count or 0)),
    )
    state["sitemap_error"] = str(error or "").strip()
    state["last_sitemap_attempt_at"] = _now()
    if success:
        state["sitemap_call_count"] = int(state.get("sitemap_call_count") or 0) + 1
        _record_sitemap_page(
            state,
            parent_id=parent_id,
            depth=depth,
            page=page,
            total_pages=total_pages,
            total_count=total_count,
            has_more=has_more,
        )
        parent_origin = _record_sitemap_expansion_state(
            state,
            entries or [],
            parent_id=parent_id,
            depth=depth,
        )
        _record_external_discoveries_in_state(
            state,
            source="caido_sitemap",
            discoveries=_discoveries_from_sitemap_entries(entries or [], origin=parent_origin),
        )
    save_workflow_state(state_dir, state)
    return state


def sitemap_gate(state_dir: Path | None) -> dict[str, Any]:
    state = load_workflow_state(state_dir)
    if bool(state.get("caido_available")) and not bool(state.get("sitemap_attempted")):
        return {
            "ok": False,
            "reason": "Caido is available but list_sitemap has not been attempted",
            "workflow_state": state,
            "recommended_next_steps": [
                "Call list_sitemap to inspect the proxied site tree",
                "If sitemap is empty or unavailable, let list_sitemap fail/return empty so the attempt is recorded",
                "Record discovered endpoints with record_attack_surface before testing",
            ],
        }
    pagination_gaps = sitemap_pagination_gaps_from_state(state)
    if pagination_gaps:
        return {
            "ok": False,
            "reason": "Caido sitemap has additional pages that have not been enumerated",
            "workflow_state": state,
            "sitemap_pagination_gaps": pagination_gaps[:20],
            "recommended_next_steps": [
                "Call list_sitemap for every missing page in the affected branch",
                "Then record newly discovered endpoints with record_attack_surface",
            ],
        }
    expansion_gaps = sitemap_expansion_gaps_from_state(state)
    if expansion_gaps:
        return {
            "ok": False,
            "reason": "Caido sitemap entries with descendants have not been expanded",
            "workflow_state": state,
            "sitemap_expansion_gaps": expansion_gaps[:20],
            "recommended_next_steps": [
                "Call list_sitemap(parent_id=<entry id>, depth=\"ALL\") for each unexpanded sitemap branch",
                "Then convert discovered requests into record_attack_surface entries",
            ],
        }
    return {"ok": True, "workflow_state": state}


def record_external_discoveries(
    state_dir: Path | None,
    *,
    source: str,
    discoveries: list[dict[str, Any]],
) -> dict[str, Any]:
    if state_dir is None:
        return _default_state(caido_available=False)
    state = load_workflow_state(state_dir)
    _record_external_discoveries_in_state(state, source=source, discoveries=discoveries)
    save_workflow_state(state_dir, state)
    return state


def discoveries_from_request_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    discoveries: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        request = entry.get("request")
        if not isinstance(request, dict):
            continue
        method = str(request.get("method") or "").strip().upper()
        path = str(request.get("path") or "").strip()
        if not path:
            continue
        query = str(request.get("query") or "").strip()
        path_with_query = path + (f"?{query}" if query else "")
        host = str(request.get("host") or "").strip().lower()
        url = ""
        if host:
            scheme = "https" if request.get("is_tls") else "http"
            port = request.get("port")
            netloc = host
            if port and str(port) not in {"80", "443"}:
                netloc = f"{netloc}:{port}"
            url = urlunsplit((scheme, netloc, path, query, ""))
        discoveries.append({
            "method": method or None,
            "path": path_with_query,
            "url": url or None,
            "source_request_id": request.get("id"),
            "status_code": (entry.get("response") or {}).get("status_code")
            if isinstance(entry.get("response"), dict)
            else None,
        })
    return discoveries


def discovered_inventory_gaps_for_state(state_dir: Path | None) -> list[dict[str, Any]]:
    if state_dir is None:
        return []
    state = load_workflow_state(state_dir)
    attack_surface = attack_surface_from_file(state_dir / "attack_surface.json")
    return discovered_inventory_gaps(state, attack_surface)


def discovered_inventory_gaps(
    workflow_state: dict[str, Any],
    attack_surface: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    discoveries = [
        item
        for item in workflow_state.get("external_discoveries") or []
        if isinstance(item, dict)
        and target_in_authorized_scope(workflow_state, item.get("url") or item.get("host") or item.get("path"))
        and _discovery_requires_surface(item)
    ]
    if not discoveries:
        return []

    surface_keys: set[tuple[str | None, str]] = set()
    surface_by_target: dict[str, set[str | None]] = {}
    for item in attack_surface:
        method = str(item.get("method") or "").strip().upper() or None
        targets = _endpoint_variants(item.get("url") or item.get("address"))
        for target in targets:
            surface_keys.add((method, target))
            surface_by_target.setdefault(target, set()).add(method)

    gaps: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in discoveries:
        method = str(item.get("method") or "").strip().upper() or None
        targets = _endpoint_variants(item.get("url") or item.get("path"))
        if not targets:
            continue
        if method:
            matched = any((method, target) in surface_keys or (None, target) in surface_keys for target in targets)
        else:
            matched = any(target in surface_by_target for target in targets)
        if matched:
            continue
        key = "|".join([method or "", sorted(targets)[0]])
        if key in seen:
            continue
        seen.add(key)
        gaps.append({
            "method": method,
            "url": item.get("url"),
            "path": item.get("path"),
            "source": item.get("source"),
            "status_code": item.get("status_code"),
        })
    return gaps


def sitemap_pagination_gaps_for_state(state_dir: Path | None) -> list[dict[str, Any]]:
    return sitemap_pagination_gaps_from_state(load_workflow_state(state_dir))


def sitemap_pagination_gaps_from_state(state: dict[str, Any]) -> list[dict[str, Any]]:
    gaps: list[dict[str, Any]] = []
    branches = state.get("sitemap_branches")
    if not isinstance(branches, dict):
        return gaps
    for branch_key, branch in branches.items():
        if not isinstance(branch, dict):
            continue
        parent_id = branch.get("parent_id")
        if parent_id and not target_in_authorized_scope(state, _sitemap_entry_origin(state, str(parent_id))):
            continue
        total_pages = int(branch.get("total_pages") or 0)
        if total_pages <= 1:
            continue
        pages_seen = {
            int(page)
            for page in branch.get("pages_seen") or []
            if str(page).isdigit()
        }
        missing = [page for page in range(1, total_pages + 1) if page not in pages_seen]
        if missing:
            gaps.append({
                "branch": branch_key,
                "parent_id": parent_id,
                "depth": branch.get("depth"),
                "missing_pages": missing,
                "total_pages": total_pages,
                "total_count": branch.get("total_count"),
            })
    return gaps


def sitemap_expansion_gaps_for_state(state_dir: Path | None) -> list[dict[str, Any]]:
    return sitemap_expansion_gaps_from_state(load_workflow_state(state_dir))


def sitemap_expansion_gaps_from_state(state: dict[str, Any]) -> list[dict[str, Any]]:
    expandable = state.get("sitemap_expandable_entries")
    if not isinstance(expandable, list):
        return []
    expanded = {
        str(item)
        for item in state.get("sitemap_expanded_parent_ids") or []
        if str(item).strip()
    }
    gaps: list[dict[str, Any]] = []
    for item in expandable:
        if not isinstance(item, dict):
            continue
        if not target_in_authorized_scope(state, item.get("origin") or item.get("label")):
            continue
        entry_id = str(item.get("id") or "").strip()
        if entry_id and entry_id not in expanded:
            gaps.append(item)
    return gaps


def is_recon_task(*, name: str = "", task: str = "", skills: list[str] | None = None) -> bool:
    text = " ".join([name, task, " ".join(skills or [])]).lower()
    return any(keyword in text for keyword in _RECON_KEYWORDS)


def _clean_url_target(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    parsed = urlsplit(text)
    if parsed.scheme and parsed.netloc:
        path = parsed.path or "/"
        if path != "/":
            path = path.rstrip("/")
        return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), path, parsed.query, "")).lower()
    if text.startswith("/"):
        return text.rstrip("/").lower() or "/"
    return text.rstrip("/").lower()


def authorized_hosts_from_targets(targets: list[dict[str, Any]] | None) -> list[str]:
    hosts: set[str] = set()
    for target in targets or []:
        if not isinstance(target, dict):
            continue
        value = str(target.get("value") or target.get("target_url") or target.get("target_ip") or "").strip()
        if not value:
            continue
        host = _host_from_target(value)
        if host:
            hosts.add(host)
    return sorted(hosts)


def target_in_authorized_scope(state: dict[str, Any] | None, value: Any) -> bool:
    hosts = {
        str(host).strip().lower()
        for host in (state or {}).get("authorized_hosts") or []
        if str(host).strip()
    }
    if not hosts:
        return True
    host = _host_from_target(value)
    if not host:
        return True
    return host in hosts


def _host_from_target(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    parsed = urlsplit(text)
    netloc = parsed.netloc
    if not netloc and "://" not in text and "/" not in text:
        netloc = text
    if not netloc:
        return ""
    return netloc.split("@", 1)[-1].lower()


def _target_host(value: Any) -> str:
    return _host_from_target(value)


def _record_sitemap_page(
    state: dict[str, Any],
    *,
    parent_id: str | None,
    depth: str | None,
    page: int | None,
    total_pages: int | None,
    total_count: int | None,
    has_more: bool | None,
) -> None:
    branch_key = f"{parent_id or '<root>'}|{(depth or 'DIRECT').upper()}"
    branches = state.setdefault("sitemap_branches", {})
    if not isinstance(branches, dict):
        branches = {}
        state["sitemap_branches"] = branches
    branch = branches.setdefault(
        branch_key,
        {
            "parent_id": parent_id,
            "depth": (depth or "DIRECT").upper(),
            "pages_seen": [],
            "total_pages": 0,
            "total_count": 0,
            "has_more": False,
        },
    )
    clean_page = max(1, int(page or 1))
    pages_seen = {
        int(item)
        for item in branch.get("pages_seen") or []
        if str(item).isdigit()
    }
    pages_seen.add(clean_page)
    branch["pages_seen"] = sorted(pages_seen)
    branch["total_pages"] = max(int(branch.get("total_pages") or 0), int(total_pages or 0))
    branch["total_count"] = max(int(branch.get("total_count") or 0), int(total_count or 0))
    branch["has_more"] = bool(branch.get("has_more")) or bool(has_more)


def _record_sitemap_expansion_state(
    state: dict[str, Any],
    entries: list[dict[str, Any]],
    *,
    parent_id: str | None,
    depth: str | None,
) -> str | None:
    parent_origin = _sitemap_entry_origin(state, parent_id)
    if parent_id:
        expanded = {
            str(item)
            for item in state.get("sitemap_expanded_parent_ids") or []
            if str(item).strip()
        }
        expanded.add(str(parent_id))
        state["sitemap_expanded_parent_ids"] = sorted(expanded)

    index = state.setdefault("sitemap_entry_index", {})
    if not isinstance(index, dict):
        index = {}
        state["sitemap_entry_index"] = index
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        entry_id = str(entry.get("id") or "").strip()
        if not entry_id:
            continue
        origin = _origin_from_sitemap_entry(entry) or parent_origin
        index[entry_id] = {
            "id": entry_id,
            "kind": entry.get("kind"),
            "label": entry.get("label"),
            "parent_id": parent_id,
            "origin": origin,
        }
    state["sitemap_entry_index"] = index

    if str(depth or "DIRECT").upper() != "DIRECT":
        return parent_origin
    existing = {
        str(item.get("id") or ""): item
        for item in state.get("sitemap_expandable_entries") or []
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }
    for entry in entries:
        if not isinstance(entry, dict) or not entry.get("has_descendants"):
            continue
        entry_id = str(entry.get("id") or "").strip()
        if not entry_id:
            continue
        origin = _origin_from_sitemap_entry(entry) or parent_origin
        if not target_in_authorized_scope(state, origin or entry.get("label")):
            continue
        existing[entry_id] = {
            "id": entry_id,
            "kind": entry.get("kind"),
            "label": entry.get("label"),
            "parent_id": parent_id,
            "source": "caido_sitemap",
            "origin": origin,
        }
    state["sitemap_expandable_entries"] = list(existing.values())
    return parent_origin


def _discoveries_from_sitemap_entries(
    entries: list[dict[str, Any]],
    *,
    origin: str | None = None,
) -> list[dict[str, Any]]:
    discoveries: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        request = entry.get("request")
        if not isinstance(request, dict):
            continue
        method = str(request.get("method") or "").strip().upper()
        path = str(request.get("path") or "").strip()
        if not path:
            continue
        entry_origin = _origin_from_sitemap_entry(entry) or origin
        url = _url_from_origin_and_path(entry_origin, path)
        discoveries.append({
            "method": method or None,
            "path": path,
            "url": url,
            "host": _target_host(url or entry_origin),
            "sitemap_entry_id": entry.get("id"),
            "sitemap_kind": entry.get("kind"),
            "status_code": request.get("status_code"),
        })
    return discoveries


def _record_external_discoveries_in_state(
    state: dict[str, Any],
    *,
    source: str,
    discoveries: list[dict[str, Any]],
) -> None:
    existing = {
        _discovery_key(item): item
        for item in state.get("external_discoveries") or []
        if isinstance(item, dict) and _discovery_key(item)
    }
    timestamp = _now()
    for raw in discoveries:
        if not isinstance(raw, dict):
            continue
        item = {
            "source": str(raw.get("source") or source or "").strip() or "external",
            "method": str(raw.get("method") or "").strip().upper() or None,
            "url": str(raw.get("url") or "").strip() or None,
            "path": str(raw.get("path") or "").strip() or None,
            "host": str(raw.get("host") or "").strip().lower() or _target_host(raw.get("url")),
            "status_code": raw.get("status_code"),
            "source_request_id": raw.get("source_request_id"),
            "sitemap_entry_id": raw.get("sitemap_entry_id"),
            "sitemap_kind": raw.get("sitemap_kind"),
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        if not item["url"] and not item["path"]:
            continue
        scope_value = item["url"] or item["host"] or item["path"]
        if not target_in_authorized_scope(state, scope_value):
            _record_out_of_scope_external_discovery(state, item)
            continue
        key = _discovery_key(item)
        if not key:
            continue
        if key in existing:
            existing[key]["updated_at"] = timestamp
            for field in ("status_code", "source_request_id", "sitemap_entry_id", "sitemap_kind"):
                if item.get(field) not in (None, ""):
                    existing[key][field] = item[field]
        else:
            existing[key] = {k: v for k, v in item.items() if v not in (None, "")}
    state["external_discoveries"] = sorted(existing.values(), key=lambda item: str(item.get("created_at") or ""))
    state["external_discovery_count"] = len(existing)


def _discovery_key(item: dict[str, Any]) -> str:
    method = str(item.get("method") or "").strip().upper()
    target = _clean_url_target(item.get("url") or item.get("path"))
    if not target:
        return ""
    return "|".join([method, target])


def _discovery_requires_surface(item: dict[str, Any]) -> bool:
    if item.get("in_scope") is False:
        return False
    target = str(item.get("url") or item.get("path") or "").strip()
    if not target:
        return False
    parsed = urlsplit(target)
    path = (parsed.path if parsed.scheme else target.split("?", 1)[0]).lower()
    if not path.startswith("/"):
        path = "/" + path
    if any(hint in path or path == hint.rstrip("/") for hint in _DYNAMIC_PATH_HINTS):
        return True
    suffix = Path(path).suffix.lower()
    if suffix in _STATIC_EXTENSIONS:
        return False
    return True


def _record_out_of_scope_external_discovery(state: dict[str, Any], item: dict[str, Any]) -> None:
    host = str(item.get("host") or _target_host(item.get("url")) or "<unknown>").strip().lower()
    if not host:
        host = "<unknown>"
    summary = state.setdefault("out_of_scope_external_discoveries", {})
    if not isinstance(summary, dict):
        summary = {}
        state["out_of_scope_external_discoveries"] = summary
    summary[host] = int(summary.get(host) or 0) + 1
    state["out_of_scope_external_discovery_count"] = sum(
        int(count or 0)
        for count in summary.values()
    )


def _sitemap_entry_origin(state: dict[str, Any], entry_id: str | None) -> str | None:
    if not entry_id:
        return None
    index = state.get("sitemap_entry_index")
    if not isinstance(index, dict):
        return None
    seen: set[str] = set()
    current = str(entry_id)
    while current and current not in seen:
        seen.add(current)
        item = index.get(current)
        if not isinstance(item, dict):
            return None
        origin = str(item.get("origin") or "").strip()
        if origin:
            return origin
        current = str(item.get("parent_id") or "").strip()
    return None


def _origin_from_sitemap_entry(entry: dict[str, Any]) -> str | None:
    if str(entry.get("kind") or "").upper() != "DOMAIN":
        return None
    label = str(entry.get("label") or "").strip()
    if not label:
        return None
    metadata = entry.get("metadata")
    is_tls = isinstance(metadata, dict) and metadata.get("is_tls") is True
    port = str(metadata.get("port") or "").strip() if isinstance(metadata, dict) else ""
    scheme = "https" if is_tls else "http"
    netloc = label
    if port and ":" not in netloc and port not in {"80", "443"}:
        netloc = f"{netloc}:{port}"
    return f"{scheme}://{netloc}"


def _url_from_origin_and_path(origin: str | None, path: str) -> str | None:
    clean_path = str(path or "").strip()
    if not origin or not clean_path:
        return None
    if _host_from_target(clean_path):
        return clean_path
    if not clean_path.startswith("/"):
        clean_path = "/" + clean_path
    parsed = urlsplit(origin)
    if not parsed.scheme or not parsed.netloc:
        return None
    return urlunsplit((parsed.scheme, parsed.netloc, clean_path, "", ""))


def _endpoint_variants(value: Any) -> set[str]:
    text = str(value or "").strip()
    if not text:
        return set()
    match = _HTTP_METHOD_RE.match(text)
    if match:
        text = match.group(2).strip()
    variants = {_clean_url_target(text)}
    parsed = urlsplit(text)
    if parsed.scheme and parsed.netloc:
        path = parsed.path or "/"
        if path != "/":
            path = path.rstrip("/")
        variants.add(urlunsplit(("", "", path, parsed.query, "")).lower())
        variants.add(urlunsplit(("", "", path, "", "")).lower())
    return {variant for variant in variants if variant}


def _coverage_resolves(item: dict[str, Any]) -> bool:
    status = str(item.get("status") or "").lower()
    if status in _MEANINGFUL_COVERAGE_STATUSES:
        return True
    if status in {"blocked", "skipped"}:
        return bool(str(item.get("result") or item.get("notes") or "").strip())
    return False


def coverage_gaps_for_state(state_dir: Path | None) -> list[dict[str, Any]]:
    if state_dir is None:
        return []
    attack_surface = attack_surface_from_file(state_dir / "attack_surface.json")
    coverage = coverage_from_file(state_dir / "coverage.json")
    try:
        from strix.platform.node_runner import uncovered_attack_surfaces
    except ImportError:
        return []
    return uncovered_attack_surfaces(attack_surface, coverage, load_workflow_state(state_dir))


def _has_attack_surface_for_endpoint(state_dir: Path | None, endpoint: str | None, method: str | None) -> bool:
    if state_dir is None or not endpoint:
        return False
    wanted_targets = _endpoint_variants(endpoint)
    wanted_method = str(method or "").strip().upper()
    for item in attack_surface_from_file(state_dir / "attack_surface.json"):
        item_targets: set[str] = set()
        for candidate in (item.get("url"), item.get("address"), item.get("path"), item.get("endpoint")):
            item_targets.update(_endpoint_variants(candidate))
        if not wanted_targets.intersection(item_targets):
            continue
        item_method = str(item.get("method") or "").strip().upper()
        if not wanted_method or not item_method or item_method == wanted_method:
            return True
    return False


def _has_coverage_for_endpoint(state_dir: Path | None, endpoint: str | None, method: str | None) -> bool:
    if state_dir is None or not endpoint:
        return False
    wanted_targets = _endpoint_variants(endpoint)
    wanted_method = str(method or "").strip().upper()
    for item in coverage_from_file(state_dir / "coverage.json"):
        if not _coverage_resolves(item):
            continue
        item_method = ""
        raw_endpoint = str(item.get("endpoint") or "")
        match = _HTTP_METHOD_RE.match(raw_endpoint)
        if match:
            item_method = match.group(1).upper()
        item_targets = _endpoint_variants(raw_endpoint)
        if not wanted_targets.intersection(item_targets):
            continue
        if not wanted_method or not item_method or item_method == wanted_method:
            return True
    return False


def _task_mentions_recorded_surface(state_dir: Path | None, task: str | None) -> bool:
    if state_dir is None or not task:
        return False
    text = str(task or "").lower()
    for item in attack_surface_from_file(state_dir / "attack_surface.json"):
        raw_candidates = [
            item.get("url"),
            item.get("address"),
            item.get("path"),
            item.get("endpoint"),
        ]
        variants: set[str] = set()
        for candidate in raw_candidates:
            variants.update(_endpoint_variants(candidate))
        for variant in variants:
            if variant and variant in text:
                return True
            parsed = urlsplit(variant)
            if parsed.path and parsed.path != "/" and parsed.path.lower() in text:
                return True
    return False


def _task_mentions_confirmed_coverage(state_dir: Path | None, task: str | None) -> bool:
    if state_dir is None or not task:
        return False
    text = str(task or "").lower()
    for item in coverage_from_file(state_dir / "coverage.json"):
        if str(item.get("status") or "").strip().lower() != "passed":
            continue
        raw_candidates = [
            item.get("endpoint"),
            item.get("parameter"),
            item.get("vuln_type"),
            item.get("result"),
        ]
        for candidate in raw_candidates:
            candidate_text = str(candidate or "").strip().lower()
            if candidate_text and candidate_text in text:
                return True
        for variant in _endpoint_variants(item.get("endpoint")):
            if variant and variant in text:
                return True
            parsed = urlsplit(variant)
            if parsed.path and parsed.path != "/" and parsed.path.lower() in text:
                return True
    return False


def _task_has_unbounded_scope(task: str | None) -> bool:
    text = str(task or "").lower()
    return any(phrase in text for phrase in _UNBOUNDED_TASK_PHRASES)


def task_can_follow_recorded_work(state_dir: Path | None, task: str | None) -> bool:
    if state_dir is None or not task:
        return False
    text = str(task or "").lower()
    if _task_has_unbounded_scope(task):
        return False
    if not any(keyword in text for keyword in _RECORDED_WORK_FOLLOWUP_KEYWORDS):
        return False
    return _task_mentions_confirmed_coverage(state_dir, task)


def testing_preflight(
    state_dir: Path | None,
    *,
    require_attack_surface: bool = True,
    planned_task: str | None = None,
) -> dict[str, Any]:
    if state_dir is None:
        return {"ok": True, "workflow_state": load_workflow_state(None)}
    gate = sitemap_gate(state_dir)
    if not gate.get("ok"):
        return gate
    if require_attack_surface:
        count = len(attack_surface_from_file(state_dir / "attack_surface.json")) if state_dir else 0
        if count <= 0:
            return {
                "ok": False,
                "reason": "No attack surface records exist yet",
                "workflow_state": gate.get("workflow_state"),
                "recommended_next_steps": [
                    "Use list_sitemap/list_requests/crawling to discover endpoints",
                    "Call record_attack_surface for each endpoint/form/service before testing",
                    "Create detailed endpoint-level todos from the recorded attack surface",
                ],
            }
        external_gaps = discovered_inventory_gaps_for_state(state_dir)
        if external_gaps:
            return {
                "ok": False,
                "reason": "Externally discovered endpoints have not been recorded in attack surface memory",
                "workflow_state": gate.get("workflow_state"),
                "external_discovery_gaps": external_gaps[:20],
                "recommended_next_steps": [
                    "Review the Caido sitemap/request-history endpoints listed in external_discovery_gaps",
                    "Call record_attack_surface for each in-scope dynamic endpoint before vulnerability testing",
                    "Create or update endpoint-level todos from the completed attack-surface inventory",
                ],
            }
        if planned_task and _task_has_unbounded_scope(planned_task):
            return {
                "ok": False,
                "reason": "Child testing task is too broad and can drift away from recorded attack surface",
                "workflow_state": gate.get("workflow_state"),
                "recommended_next_steps": [
                    "Split the child task into specific endpoint or business-flow tasks",
                    "Remove open-ended scope such as 'any other endpoint' or 'all inputs'",
                    "Bind each child task to recorded attack surface entries",
                ],
            }
        if planned_task and not _task_mentions_recorded_surface(state_dir, planned_task):
            return {
                "ok": False,
                "reason": "Child testing task is not bound to a recorded attack surface",
                "workflow_state": gate.get("workflow_state"),
                "recommended_next_steps": [
                    "Reference the specific endpoint, method, parameter, form, service, or business flow in the child task",
                    "Create or update attack-surface records before delegating testing",
                    "Avoid vulnerability-category-only tasks such as generic SQLi or XSS testing",
                ],
            }
    return {"ok": True, "workflow_state": gate.get("workflow_state")}


def reporting_preflight(state_dir: Path | None, *, endpoint: str | None, method: str | None) -> dict[str, Any]:
    if state_dir is None:
        return {"ok": True}
    if not endpoint:
        return testing_preflight(state_dir, require_attack_surface=True)
    attack_surface_count = len(attack_surface_from_file(state_dir / "attack_surface.json"))
    if attack_surface_count <= 0:
        return {
            "ok": False,
            "reason": "No attack surface records exist yet",
            "endpoint": endpoint,
            "method": method,
            "recommended_next_steps": [
                "Call record_attack_surface for this endpoint before reporting",
                "Then record endpoint coverage with record_coverage",
            ],
        }
    if not _has_attack_surface_for_endpoint(state_dir, endpoint, method):
        return {
            "ok": False,
            "reason": "The reported endpoint is not present in attack surface memory",
            "endpoint": endpoint,
            "method": method,
            "recommended_next_steps": [
                "Call record_attack_surface for this endpoint before reporting",
                "Then record endpoint coverage with record_coverage",
            ],
        }
    if not _has_coverage_for_endpoint(state_dir, endpoint, method):
        return {
            "ok": False,
            "reason": "The reported endpoint does not have a meaningful coverage record",
            "endpoint": endpoint,
            "method": method,
            "recommended_next_steps": [
                "Call record_coverage for this endpoint/parameter/vulnerability class",
                "Use status passed/failed/tried, or blocked/skipped with notes when testing is not possible",
            ],
        }
    return {"ok": True}
