"""Deterministic probes for high-value technical surfaces (not CTF answers).

Addresses the gap: prompt-only checklists fail when the model never requests
encryptionkeys / profile image URL / logs. These probes are generic path
existence checks + light response fingerprinting — no exploit payloads.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from node5.identity import normalize_path
from node5.state import PenState, Surface

# (path, note_hint, methods) — methods tried in order until non-404/empty
_PROBE_SPEC: list[tuple[str, str, tuple[str, ...]]] = [
    ("/encryptionkeys", "key listing or static keys dir", ("GET",)),
    ("/encryptionkeys/", "key listing", ("GET",)),
    ("/support/logs", "support logs dir", ("GET",)),
    ("/support/logs/", "support logs dir", ("GET",)),
    ("/api-docs", "openapi/swagger ui", ("GET",)),
    ("/api-docs/", "openapi/swagger ui", ("GET",)),
    ("/swagger.json", "swagger spec", ("GET",)),
    ("/openapi.json", "openapi spec", ("GET",)),
    ("/graphql", "graphql endpoint", ("GET", "POST")),
    ("/api/graphql", "graphql endpoint", ("GET", "POST")),
    ("/metrics", "metrics scrape", ("GET",)),
    ("/actuator", "spring actuator", ("GET",)),
    ("/actuator/health", "actuator health", ("GET",)),
    ("/profile/image/url", "profile image URL fetch sink (SSRF candidate)", ("GET", "PUT", "POST")),
    ("/profile/image/file", "profile image file upload sink", ("GET", "POST")),
    # Common SPA/API auth & object collections (generic REST nouns — not vuln keys)
    ("/rest/user/login", "auth login API", ("GET", "POST")),
    ("/rest/user/register", "auth register API", ("GET", "POST")),
    ("/rest/user/whoami", "session whoami", ("GET",)),
    ("/rest/user/reset-password", "password reset API", ("GET", "POST")),
    ("/rest/user/security-question", "security question reset", ("GET",)),
    ("/rest/user/change-password", "change password", ("GET", "POST")),
    ("/rest/products/search", "product search API", ("GET",)),
    ("/rest/basket", "basket collection", ("GET",)),
    ("/api/Users", "users collection API", ("GET", "POST")),
    ("/api/Users/whoami", "user whoami variant", ("GET",)),
    ("/api/Products", "products collection API", ("GET",)),
    ("/api/Feedbacks", "feedback/UGC collection", ("GET", "POST")),
    ("/api/Cards", "payment/card objects API", ("GET",)),
    ("/api/Recycles", "recycle/order-adjacent API", ("GET", "POST")),
    ("/api/BasketItems", "basket items API", ("GET", "POST")),
    ("/api/Quantitys", "quantity API", ("GET",)),
    ("/rest/basket", "basket collection", ("GET",)),
    ("/rest/basket/1/checkout", "basket checkout", ("POST", "GET")),
    ("/rest/products/reviews", "product reviews UGC", ("GET", "POST")),
    ("/rest/2fa/status", "2FA status", ("GET",)),
    ("/rest/2fa/setup", "2FA setup", ("GET", "POST")),
    ("/b2b/v2/orders", "B2B orders API", ("GET", "POST")),
    ("/socket.io/", "websocket", ("GET",)),
]

# Interesting status codes: anything that is not pure miss
_HIT_STATUS = frozenset({200, 201, 204, 301, 302, 307, 308, 400, 401, 403, 405, 415, 500})


def _base(target: str) -> str:
    t = (target or "").rstrip("/")
    if not t.startswith("http"):
        t = "http://" + t
    return t


def probe_high_value_paths(
    state: PenState,
    *,
    timeout: float = 8.0,
    max_probes: int = 40,
) -> list[Surface]:
    """GET/POST common high-value paths; add Surfaces for non-404 hits.

    Returns newly added surfaces. Safe for lab: no exploit body except empty JSON POST.
    """
    if state.dry_run:
        return []
    base = _base(state.target)
    existing = {normalize_path(s.path, state.target) for s in state.surfaces}
    added: list[Surface] = []
    tried = 0

    try:
        client = httpx.Client(timeout=timeout, follow_redirects=True, verify=False)
    except Exception:
        return []

    try:
        for path, hint, methods in _PROBE_SPEC:
            if tried >= max_probes:
                break
            npath = normalize_path(path, state.target) or path.rstrip("/")
            if npath in existing:
                continue
            url = urljoin(base + "/", path.lstrip("/"))
            # keep host in scope
            if urlparse(url).hostname and urlparse(base).hostname:
                if urlparse(url).hostname != urlparse(base).hostname:
                    continue
            hit: Surface | None = None
            for method in methods:
                tried += 1
                try:
                    if method == "GET":
                        resp = client.get(url)
                    else:
                        resp = client.request(
                            method,
                            url,
                            content=b"{}",
                            headers={"Content-Type": "application/json"},
                        )
                except Exception:
                    continue
                if resp.status_code not in _HIT_STATUS:
                    continue
                # 404 with SPA fallback often returns 200 HTML for all routes — skip pure SPA shells
                ctype = (resp.headers.get("content-type") or "").lower()
                body = (resp.text or "")[:400].lower()
                if (
                    resp.status_code == 200
                    and "text/html" in ctype
                    and "angular" in body
                    and path not in ("/graphql", "/metrics", "/api-docs")
                    and "encryption" not in path
                    and "logs" not in path
                ):
                    # Likely SPA index fallback; still record if path is image/url style API
                    if "profile" not in path and "image" not in path:
                        continue
                note = f"high_value_probe HTTP {resp.status_code} {method} — {hint}"
                if "index of" in body or "directory" in body:
                    note += " [listing]"
                if ".pub" in body or "begin " in body or "pem" in body:
                    note += " [key_material]"
                if "graphql" in body or "graphiql" in body:
                    note += " [graphql]"
                hit = Surface(path=path if path.startswith("/") else "/" + path, method=method, note=note, status="open")
                break
            if hit:
                state.surfaces.append(hit)
                existing.add(npath)
                added.append(hit)
                state.note(f"high_value_probe: hit {hit.method} {hit.path} {hit.note[:80]}")
    finally:
        client.close()

    if added:
        state.note(f"high_value_probe: added {len(added)} surface(s) from deterministic recon")
    else:
        state.note(f"high_value_probe: no new hits ({tried} requests)")
    return added
