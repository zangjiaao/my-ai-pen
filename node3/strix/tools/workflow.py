"""Run-level workflow gates for coverage-first web assessment."""

from __future__ import annotations

import json
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from strix.tools.run_memory.tools import attack_surface_from_file, coverage_from_file, evidence_from_file, hypotheses_from_file


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
_GENERIC_CLUSTER_SEGMENTS = {
    "api",
    "app",
    "graphql",
    "rest",
    "route",
    "routes",
    "v1",
    "v2",
    "v3",
}
_REPORTING_PHASE_TERMS = (
    "validation",
    "validate",
    "report",
    "reporting",
    "final",
)
_RISK_FAMILY_HINTS = (
    {
        "family": "authentication_and_session",
        "surface_terms": ("auth", "login", "logout", "password", "reset", "forgot", "session", "token", "jwt", "security-question", "mfa", "totp"),
        "vuln_terms": ("auth", "authentication", "session", "jwt", "token", "password", "credential", "account"),
    },
    {
        "family": "authorization_and_object_isolation",
        "surface_terms": ("admin", "user", "users", "profile", "account", "basket", "cart", "order", "wallet", "card", "complaint", "review", "address"),
        "vuln_terms": ("authorization", "access", "idor", "bfla", "privilege", "ownership", "isolation"),
    },
    {
        "family": "input_injection",
        "surface_terms": ("search", "query", "filter", "sort", "where", "id", "email", "name", "message", "comment", "review", "feedback", "prompt", "chat", "xml", "template"),
        "vuln_terms": ("injection", "sqli", "sql", "nosql", "command", "xxe", "ssti", "template", "prompt"),
    },
    {
        "family": "client_side_input_output",
        "surface_terms": ("search", "q", "query", "redirect", "return", "callback", "message", "comment", "review", "feedback", "description", "content", "html", "script"),
        "vuln_terms": ("xss", "dom", "client", "csp", "reflection", "stored", "header"),
    },
    {
        "family": "business_logic_and_state_changes",
        "surface_terms": ("basket", "cart", "checkout", "order", "payment", "coupon", "discount", "wallet", "card", "membership", "feedback", "captcha", "review", "delete", "update", "create"),
        "vuln_terms": ("business", "logic", "validation", "input", "coupon", "payment", "captcha", "rate", "automation", "mass", "assignment"),
    },
    {
        "family": "file_and_parser_handling",
        "surface_terms": ("upload", "file", "files", "ftp", "download", "import", "export", "pdf", "xml", "zip", "backup", "path", "filename"),
        "vuln_terms": ("upload", "file", "path", "traversal", "lfi", "rfi", "xxe", "parser", "deserialization"),
    },
    {
        "family": "redirect_and_external_url",
        "surface_terms": ("redirect", "return", "next", "url", "uri", "callback", "continue", "proxy", "external", "image", "avatar"),
        "vuln_terms": ("redirect", "ssrf", "url", "callback", "external", "open"),
    },
    {
        "family": "configuration_observability_and_components",
        "surface_terms": ("config", "configuration", "swagger", "openapi", "metrics", "health", "debug", "log", "package", "lock", "map", "js", "well-known", "robots"),
        "vuln_terms": ("configuration", "disclosure", "component", "dependency", "observability", "debug", "metrics", "version"),
    },
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


def workflow_cluster_summary(
    attack_surface: list[dict[str, Any]],
    hypotheses: list[dict[str, Any]],
    coverage: list[dict[str, Any]],
    external_discoveries: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Summarize observed workflow coverage from recorded paths.

    The clusters are derived from actual URL/path segments rather than target
    profiles or benchmark expectations. This makes coverage skew visible to the
    agent without telling it which application-specific findings should exist.
    """
    clusters: dict[str, dict[str, Any]] = {}

    def ensure(cluster: str) -> dict[str, Any]:
        return clusters.setdefault(
            cluster,
            {
                "cluster": cluster,
                "attack_surface_count": 0,
                "hypothesis_count": 0,
                "coverage_count": 0,
                "external_discovery_count": 0,
                "coverage_statuses": {},
                "vuln_types": {},
                "example_targets": [],
                "surface_hints": [],
            },
        )

    for item in external_discoveries or []:
        cluster = _workflow_cluster_for_item(item)
        entry = ensure(cluster)
        entry["external_discovery_count"] += 1
        _append_example_target(entry, item.get("url") or item.get("path"))
        for family in _risk_families_for_surface(item):
            _append_unique(entry["surface_hints"], family, limit=8)

    for item in attack_surface:
        cluster = _workflow_cluster_for_item(item)
        entry = ensure(cluster)
        entry["attack_surface_count"] += 1
        _append_example_target(entry, item.get("url") or item.get("address") or item.get("endpoint"))
        for family in _risk_families_for_surface(item):
            _append_unique(entry["surface_hints"], family, limit=8)

    for item in hypotheses:
        cluster = _workflow_cluster_for_item(item)
        entry = ensure(cluster)
        entry["hypothesis_count"] += 1
        vuln_type = str(item.get("vuln_type") or "unknown")
        entry["vuln_types"][vuln_type] = int(entry["vuln_types"].get(vuln_type, 0)) + 1
        _append_example_target(entry, item.get("endpoint") or item.get("url"))

    for item in coverage:
        cluster = _workflow_cluster_for_item(item)
        entry = ensure(cluster)
        entry["coverage_count"] += 1
        status = str(item.get("status") or "unknown")
        entry["coverage_statuses"][status] = int(entry["coverage_statuses"].get(status, 0)) + 1
        vuln_type = str(item.get("vuln_type") or "unknown")
        entry["vuln_types"][vuln_type] = int(entry["vuln_types"].get(vuln_type, 0)) + 1
        _append_example_target(entry, item.get("endpoint") or item.get("url"))

    ordered = sorted(
        clusters.values(),
        key=lambda item: (
            -int(item["attack_surface_count"]),
            -int(item["external_discovery_count"]),
            -int(item["hypothesis_count"]),
            str(item["cluster"]),
        ),
    )
    clusters_without_hypotheses = [
        item["cluster"]
        for item in ordered
        if int(item["attack_surface_count"]) > 0 and int(item["hypothesis_count"]) == 0
    ]
    clusters_without_coverage = [
        item["cluster"]
        for item in ordered
        if int(item["attack_surface_count"]) > 0 and int(item["coverage_count"]) == 0
    ]
    external_clusters_without_inventory = [
        item["cluster"]
        for item in ordered
        if int(item["external_discovery_count"]) > 0 and int(item["attack_surface_count"]) == 0
    ]
    clusters_with_narrow_testing: list[dict[str, Any]] = []
    suggested_next_testing_families: list[dict[str, Any]] = []
    family_counts: dict[str, int] = {}
    for item in ordered:
        observed_families = _risk_families_from_vuln_types(item.get("vuln_types", {}))
        suggested = [
            family
            for family in item.get("surface_hints", [])
            if family not in observed_families
        ]
        if int(item["attack_surface_count"]) > 0 and suggested:
            clusters_with_narrow_testing.append({
                "cluster": item["cluster"],
                "tested_families": sorted(observed_families),
                "suggested_untested_families": suggested[:5],
                "example_targets": item.get("example_targets", [])[:3],
            })
            for family in suggested:
                family_counts[family] = family_counts.get(family, 0) + 1
    for family, count in sorted(family_counts.items(), key=lambda pair: (-pair[1], pair[0])):
        suggested_next_testing_families.append({"family": family, "cluster_count": count})
    return {
        "cluster_count": len(ordered),
        "clusters": ordered,
        "clusters_without_hypotheses": clusters_without_hypotheses,
        "clusters_without_coverage": clusters_without_coverage,
        "external_clusters_without_inventory": external_clusters_without_inventory,
        "clusters_with_narrow_testing": clusters_with_narrow_testing[:10],
        "suggested_next_testing_families": suggested_next_testing_families[:10],
        "dominant_clusters": [
            item["cluster"]
            for item in ordered[:3]
            if (
                int(item["external_discovery_count"])
                or int(item["attack_surface_count"])
                or int(item["hypothesis_count"])
                or int(item["coverage_count"])
            )
        ],
    }


def workflow_cluster_summary_for_state(state_dir: Path | None) -> dict[str, Any]:
    if state_dir is None:
        return workflow_cluster_summary([], [], [])
    try:
        from strix.tools.run_memory.tools import hypotheses_from_file
    except ImportError:
        hypotheses = []
    else:
        hypotheses = hypotheses_from_file(state_dir / "hypotheses.json")
    return workflow_cluster_summary(
        attack_surface_from_file(state_dir / "attack_surface.json"),
        hypotheses,
        coverage_from_file(state_dir / "coverage.json"),
        discovered_inventory_gaps_for_state(state_dir),
    )


def inventory_readiness_for_state(state_dir: Path | None) -> dict[str, Any]:
    """Return whether observed attack surface is ready to become test work.

    This is intentionally derived from observed ledgers and external discovery
    state, not from target profiles or benchmark expectations. The goal is to
    make the root agent compile the inventory and hypothesis matrix before it
    starts distributing vulnerability-testing work.
    """
    if state_dir is None:
        return {
            "ok": True,
            "ready_for_testing": True,
            "reason": "",
            "gaps": [],
            "recommended_next_steps": [],
        }

    gate = sitemap_gate(state_dir)
    attack_surface = attack_surface_from_file(state_dir / "attack_surface.json")
    hypotheses = hypotheses_from_file(state_dir / "hypotheses.json")
    coverage = coverage_from_file(state_dir / "coverage.json")
    external_gaps = discovered_inventory_gaps_for_state(state_dir)
    workflow_clusters = workflow_cluster_summary(
        attack_surface,
        hypotheses,
        coverage,
        external_gaps,
    )
    try:
        from strix.platform.node_runner import surface_hypothesis_gaps
    except ImportError:
        surface_gaps: list[dict[str, Any]] = []
    else:
        surface_gaps = surface_hypothesis_gaps(
            attack_surface,
            hypotheses,
            load_workflow_state(state_dir),
        )

    gaps: list[dict[str, Any]] = []
    if not gate.get("ok"):
        gaps.append({
            "kind": "discovery_source_not_processed",
            "reason": gate.get("reason") or "Discovery source state is incomplete",
            "details": {
                key: gate.get(key)
                for key in (
                    "sitemap_pagination_gaps",
                    "sitemap_expansion_gaps",
                    "recommended_next_steps",
                )
                if gate.get(key)
            },
        })
    if not attack_surface:
        gaps.append({
            "kind": "no_attack_surface_inventory",
            "reason": "No attack surface records exist yet",
        })
    if external_gaps:
        gaps.append({
            "kind": "external_discovery_not_imported",
            "reason": "Externally discovered endpoints have not been recorded in attack surface memory",
            "items": external_gaps[:20],
            "total_count": len(external_gaps),
        })
    clusters_without_hypotheses = workflow_clusters.get("clusters_without_hypotheses") or []
    if clusters_without_hypotheses:
        gaps.append({
            "kind": "clusters_without_hypotheses",
            "reason": "Observed workflow clusters have no hypothesis/test matrix entries",
            "clusters": clusters_without_hypotheses[:20],
            "total_count": len(clusters_without_hypotheses),
        })
    if surface_gaps:
        gaps.append({
            "kind": "surfaces_without_hypotheses",
            "reason": "Recorded testable attack surfaces are not represented in the hypothesis matrix",
            "items": surface_gaps[:20],
            "total_count": len(surface_gaps),
        })

    narrow_testing = workflow_clusters.get("clusters_with_narrow_testing") or []
    ready = not gaps
    return {
        "ok": ready,
        "ready_for_testing": ready,
        "reason": "" if ready else "Attack-surface inventory and hypothesis matrix are not ready for vulnerability testing",
        "attack_surface_count": len(attack_surface),
        "hypothesis_count": len(hypotheses),
        "coverage_count": len(coverage),
        "workflow_clusters": workflow_clusters,
        "gaps": gaps,
        "matrix_warnings": [
            {
                "kind": "narrow_cluster_testing",
                "reason": "Some observed clusters have suggested risk families that are not represented in the matrix",
                "items": narrow_testing[:20],
                "total_count": len(narrow_testing),
            },
        ] if narrow_testing else [],
        "recommended_next_steps": [
            "Continue root-led discovery until external sitemap/request-history gaps are imported or deliberately excluded",
            "Group recorded surfaces into workflow clusters with list_memory(kind=\"workflow_clusters\")",
            "Create record_hypothesis entries for each testable surface and applicable risk family before spawning testing agents",
            "Delegate subagents from concrete hypothesis/surface groups after inventory_readiness is ok",
        ] if not ready else [
            "Create surface- or hypothesis-bound testing subagents from the compiled matrix",
            "Track coverage with record_coverage(hypothesis_id=...) as each test is executed",
        ],
    }


def _workflow_cluster_for_item(item: dict[str, Any]) -> str:
    target = str(
        item.get("url")
        or item.get("endpoint")
        or item.get("address")
        or item.get("path")
        or "",
    ).strip()
    match = _HTTP_METHOD_RE.match(target)
    if match:
        target = match.group(2)
    parsed = urlsplit(target if "://" in target else f"http://placeholder{target}")
    segments = [
        segment.lower()
        for segment in parsed.path.split("/")
        if segment and not segment.startswith("{") and not segment.startswith(":")
    ]
    meaningful = [
        segment
        for segment in segments
        if segment not in _GENERIC_CLUSTER_SEGMENTS and not segment.isdigit()
    ]
    if meaningful:
        return meaningful[0]
    kind = str(item.get("kind") or "").strip().lower()
    if kind:
        return kind
    return "root"


def _append_example_target(entry: dict[str, Any], target: Any) -> None:
    text = str(target or "").strip()
    if not text:
        return
    examples = entry.setdefault("example_targets", [])
    _append_unique(examples, text, limit=5)


def _append_unique(items: list[Any], value: Any, *, limit: int) -> None:
    if value not in items and len(items) < limit:
        items.append(value)


def _risk_families_for_surface(item: dict[str, Any]) -> list[str]:
    haystack = _surface_hint_text(item)
    if not haystack:
        return []
    families: list[str] = []
    for hint in _RISK_FAMILY_HINTS:
        if any(term in haystack for term in hint["surface_terms"]):
            families.append(str(hint["family"]))
    method = str(item.get("method") or "").strip().upper()
    if method in {"POST", "PUT", "PATCH", "DELETE"}:
        _append_unique(families, "business_logic_and_state_changes", limit=10)
        _append_unique(families, "authorization_and_object_isolation", limit=10)
    kind = str(item.get("kind") or item.get("original_kind") or "").strip().lower()
    if kind == "file_upload":
        _append_unique(families, "file_and_parser_handling", limit=10)
    return families[:8]


def _surface_hint_text(item: dict[str, Any]) -> str:
    parts: list[str] = []
    for field in ("kind", "original_kind", "url", "endpoint", "address", "path", "method", "auth_state", "role", "notes", "source"):
        value = item.get(field)
        if value:
            parts.append(str(value))
    parameters = item.get("parameters")
    if isinstance(parameters, list):
        parts.extend(str(value) for value in parameters)
    elif parameters:
        parts.append(str(parameters))
    return " ".join(parts).lower()


def _risk_families_from_vuln_types(vuln_types: Any) -> set[str]:
    if not isinstance(vuln_types, dict):
        return set()
    text = " ".join(str(vuln_type).lower() for vuln_type in vuln_types)
    families: set[str] = set()
    for hint in _RISK_FAMILY_HINTS:
        if any(term in text for term in hint["vuln_terms"]):
            families.add(str(hint["family"]))
    return families


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
    directory_surfaces: list[tuple[str | None, str]] = []
    for item in attack_surface:
        method = str(item.get("method") or "").strip().upper() or None
        targets = _endpoint_variants(item.get("url") or item.get("address"))
        for target in targets:
            surface_keys.add((method, target))
            surface_by_target.setdefault(target, set()).add(method)
            if _is_directory_surface(item, target):
                directory_surfaces.append((method, target))

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
        if not matched:
            matched = _covered_by_directory_surface(method, targets, directory_surfaces)
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


def _is_directory_surface(item: dict[str, Any], target: str) -> bool:
    kind = str(item.get("kind") or item.get("original_kind") or "").strip().lower()
    if kind not in {"static_asset", "static_directory", "directory", "url"}:
        return False
    for raw in (item.get("url"), item.get("address"), item.get("path"), item.get("endpoint")):
        raw_text = str(raw or "").strip()
        if not raw_text:
            continue
        parsed_raw = urlsplit(raw_text if "://" in raw_text else f"http://placeholder{raw_text}")
        raw_path = parsed_raw.path or raw_text
        if raw_path not in {"", "/"} and raw_path.endswith("/"):
            return True
    parsed = urlsplit(target)
    path = parsed.path or target
    return path not in {"", "/"} and path.endswith("/")


def _covered_by_directory_surface(
    method: str | None,
    targets: set[str],
    directory_surfaces: list[tuple[str | None, str]],
) -> bool:
    for surface_method, surface_target in directory_surfaces:
        if method and surface_method and method != surface_method:
            continue
        for target in targets:
            if _target_is_below_directory(target, surface_target):
                return True
    return False


def _target_is_below_directory(target: str, directory_target: str) -> bool:
    target_text = str(target or "").strip().lower()
    directory_text = str(directory_target or "").strip().lower()
    if not target_text or not directory_text:
        return False
    if not directory_text.endswith("/"):
        directory_text += "/"
    return target_text != directory_text.rstrip("/") and target_text.startswith(directory_text)


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
    path = parsed.path or ""
    if parsed.scheme and parsed.netloc:
        path = path or "/"
        if path != "/":
            path = path.rstrip("/")
        variants.add(urlunsplit(("", "", path, parsed.query, "")).lower())
        variants.add(urlunsplit(("", "", path, "", "")).lower())
    elif path:
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


def _root_top_level_todos_from_state(state_dir: Path | None) -> list[dict[str, Any]]:
    if state_dir is None:
        return []
    path = state_dir / "todos.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(raw, dict):
        return []
    todos: list[dict[str, Any]] = []
    for owner_id, by_id in raw.items():
        if not isinstance(by_id, dict):
            continue
        for todo_id, item in by_id.items():
            if not isinstance(item, dict):
                continue
            if str(item.get("linked_agent_id") or "").strip():
                continue
            if str(item.get("parent_todo_id") or "").strip():
                continue
            todos.append({
                **item,
                "todo_id": str(todo_id),
                "owner_agent_id": str(owner_id),
            })
    def sort_key(item: dict[str, Any]) -> tuple[int, str, str]:
        try:
            order_index = int(item.get("order_index") or 1_000_000)
        except (TypeError, ValueError):
            order_index = 1_000_000
        return (
            order_index,
            str(item.get("created_at") or ""),
            str(item.get("todo_id") or ""),
        )

    todos.sort(key=sort_key)
    return todos


def _phase_title_allows_reporting(title: Any) -> bool:
    text = str(title or "").strip().lower()
    return bool(text and any(term in text for term in _REPORTING_PHASE_TERMS))


def reporting_phase_preflight(state_dir: Path | None) -> dict[str, Any]:
    """Return whether the root phase plan is currently in reporting mode.

    If a run has no root phase plan yet, keep this permissive so tests and
    legacy one-shot usage still rely on the memory gates. When a phase plan
    exists, formal vulnerability reports should happen only while the active
    top-level phase is explicitly validation/reporting/finalization shaped.
    """
    root_todos = _root_top_level_todos_from_state(state_dir)
    if not root_todos:
        return {"ok": True, "phase_plan_present": False}
    active = [
        item
        for item in root_todos
        if str(item.get("status") or "").strip().lower() == "in_progress"
    ]
    reporting_active = [
        item
        for item in active
        if _phase_title_allows_reporting(item.get("title"))
    ]
    if reporting_active:
        return {
            "ok": True,
            "phase_plan_present": True,
            "active_phase": {
                "todo_id": reporting_active[0].get("todo_id"),
                "title": reporting_active[0].get("title"),
                "status": reporting_active[0].get("status"),
            },
        }
    if active:
        return {
            "ok": False,
            "reason": "Root is not in the validation/reporting phase",
            "phase_plan_present": True,
            "active_phase": {
                "todo_id": active[0].get("todo_id"),
                "title": active[0].get("title"),
                "status": active[0].get("status"),
            },
            "recommended_next_steps": [
                "Record candidate evidence and coverage, then continue the current discovery/testing phase",
                "Use list_memory(kind=\"coverage_gaps\"), list_memory(kind=\"hypothesis_gaps\"), and list_memory(kind=\"surface_hypothesis_gaps\") before switching phases",
                "Start the validation/reporting phase only after the testing matrix is closed or explicitly blocked/skipped with concrete notes",
            ],
        }
    return {
        "ok": False,
        "reason": "Root has a phase plan but no active validation/reporting phase",
        "phase_plan_present": True,
        "recommended_next_steps": [
            "Start the validation/reporting phase before filing formal vulnerability reports",
            "If discovery/testing is not complete, resume that phase and close remaining coverage or hypothesis gaps first",
        ],
    }


def reporting_matrix_preflight(state_dir: Path | None) -> dict[str, Any]:
    if state_dir is None:
        return {"ok": True}
    attack_surface = attack_surface_from_file(state_dir / "attack_surface.json")
    hypotheses = hypotheses_from_file(state_dir / "hypotheses.json")
    coverage = coverage_from_file(state_dir / "coverage.json")
    evidence = evidence_from_file(state_dir / "evidence.json")
    workflow_state = load_workflow_state(state_dir)
    try:
        from strix.platform.node_runner import coverage_without_hypothesis_links, surface_hypothesis_gaps
        from strix.tools.run_memory.tools import hypothesis_gaps
    except ImportError:
        surface_gaps: list[dict[str, Any]] = []
        unlinked_coverage: list[dict[str, Any]] = []
        hypothesis_gap_list: list[dict[str, Any]] = []
    else:
        surface_gaps = surface_hypothesis_gaps(attack_surface, hypotheses, workflow_state)
        unlinked_coverage = coverage_without_hypothesis_links(coverage, hypotheses)
        coverage_by_id = {
            str(item.get("coverage_id")): item
            for item in coverage
            if str(item.get("coverage_id") or "").strip()
        }
        evidence_by_id = {
            str(item.get("evidence_id")): item
            for item in evidence
            if str(item.get("evidence_id") or "").strip()
        }
        hypothesis_gap_list = hypothesis_gaps(hypotheses, coverage_by_id, evidence_by_id)
    coverage_gaps = coverage_gaps_for_state(state_dir)
    gaps = {
        "surface_hypothesis_gap_count": len(surface_gaps),
        "hypothesis_gap_count": len(hypothesis_gap_list),
        "coverage_without_hypothesis_count": len(unlinked_coverage),
        "uncovered_attack_surface_count": len(coverage_gaps),
        "surface_hypothesis_gaps": surface_gaps[:20],
        "hypothesis_gaps": hypothesis_gap_list[:20],
        "coverage_without_hypothesis": unlinked_coverage[:20],
        "uncovered_attack_surfaces": coverage_gaps[:20],
    }
    if any(gaps[key] for key in (
        "surface_hypothesis_gap_count",
        "hypothesis_gap_count",
        "coverage_without_hypothesis_count",
        "uncovered_attack_surface_count",
    )):
        return {
            "ok": False,
            "reason": "Discovery/testing matrix is still open; reporting now would collapse coverage around early findings",
            **gaps,
            "recommended_next_steps": [
                "Continue discovery/testing for uncovered attack surfaces",
                "Create or link missing hypotheses for recorded surfaces and coverage",
                "Close planned hypotheses with evidence-backed coverage, or explicit blocked/skipped notes",
                "Keep confirmed candidates in evidence/coverage memory until validation/reporting phase",
            ],
        }
    return {"ok": True, **gaps}


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


def _task_has_unbounded_scope(task: str | None) -> bool:
    text = str(task or "").lower()
    return any(phrase in text for phrase in _UNBOUNDED_TASK_PHRASES)


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
        readiness = inventory_readiness_for_state(state_dir)
        if not readiness.get("ok"):
            return {
                "ok": False,
                "reason": readiness.get("reason") or "Attack-surface inventory is not ready for vulnerability testing",
                "workflow_state": gate.get("workflow_state"),
                "inventory_readiness": readiness,
                "blocks_testing_until_inventory_ready": True,
                "recommended_next_steps": readiness.get("recommended_next_steps") or [
                    "Finish attack-surface inventory and hypothesis/test matrix before spawning testing agents",
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
        gate = testing_preflight(state_dir, require_attack_surface=True)
        if not gate.get("ok"):
            return gate
        return {"ok": True}
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
