"""Feedback Graph — multi-loop checks that balance Task/Agent progress.

Loops (not Task edges):
  structure  — stage produced parseable JSON (or fan-out had structured workers)
  tool_use   — live stage used tools
  evidence   — ready_to_book candidates need non-empty proof excerpts
  evidence_quality — attacker-controlled / differential proof bar
  coverage   — class_probe / surface ledger adequacy (attempt/close honesty)
  discovery_yield — process quality: empty/low candidate yield after real tool work
  surface_ledger — surfaces[] actually landed recon paths
  retry      — re-run when structure/ledger/discovery yield weak

Graph constrains process quality contracts (structure, salvage, yield), not answer keys.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from node5.identity import infer_vuln_class, normalize_path
from node5.state import Candidate, PenState
from node5.surface_model import surface_model_ok

# Stages that must return structured JSON for State Handoff to work
_JSON_REQUIRED_STAGES = frozenset(
    {
        "surface",
        "prior_reverify",
        "auth_session",
        "class_probe",
        "authz_logic",
        "component",
    }
)

# Live stages where tools + empty ready_to_book warrants one process retry
# (no vuln names — only "emit candidates if you observed effects")
_DISCOVERY_READY_STAGES = frozenset({"prior_reverify", "auth_session"})

# Minimum tool calls before empty-ready counts as process failure (not idle skip)
_EMPTY_READY_MIN_TOOLS = 8
# class_probe yield: soft-fail when structured workers exist but almost no new cands
_CLASS_PROBE_MIN_WORKERS_FOR_YIELD = 2
_CLASS_PROBE_MIN_SURFACES_FOR_YIELD = 8

_SEV_RANK = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


@dataclass
class StageFeedback:
    structure_ok: bool
    tool_ok: bool
    evidence_ok: bool
    coverage_ok: bool
    surface_ledger_ok: bool
    should_retry: bool
    details: list[str]


def _fresh_proof_ok(proof: str) -> bool:
    p = (proof or "").strip()
    if len(p) < 12:
        return False
    markers = (
        "HTTP ",
        "GET ",
        "POST ",
        "PUT ",
        "PATCH ",
        "DELETE ",
        "uid=",
        "error in your SQL",
        "root:x:",
        "<script",
        "Surname:",
        "Index of",
        "set-cookie",
        "User ID",
        "db_password",
        "Password Changed",
        "authentication",
        "Bearer ",
        "alg",
    )
    low = p.lower()
    if any(m.lower() in low for m in markers):
        return True
    return len(p) >= 40


def injection_data_effect_ok(proof: str) -> bool:
    """True if proof shows data retrieval or stable result-set change (not mere errors)."""
    p = (proof or "").lower()
    markers = (
        "union select",
        "union all",
        "sqlite_schema",
        "sqlite_master",
        "information_schema",
        "email",
        "password",
        "totp",
        "@",
        "column",
        "table",
        "rows returned",
        "result set",
        "boolean",
        "boolean differential",
        "boolean oracle",
        "different product",
        "products listed",
        "all products",
        "empty result",
        "empty json",
        "data array",
        "extracted",
        "dumped",
        "admin@",
        "sleep(",
        "time-based",
        "delay",
        "like '",
        "evaluated true",
        "evaluated false",
        "returns all",
        "returns none",
        "result-set",
        "result set change",
    )
    if any(m in p for m in markers):
        return True
    # multiple emails often indicate dump
    if len(re.findall(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", p)) >= 2:
        return True
    return False


def ssrf_server_side_ok(proof: str) -> bool:
    """SSRF book needs evidence the server fetched something (not param-exists-only)."""
    p = (proof or "").lower()
    # Avoid matching path names like "image/url" as proof of server-side fetch
    return any(
        x in p
        for x in (
            "fetched",
            "server retrieved",
            "server requested",
            "server-side",
            "server side",
            "server-side fetch",
            "profileimage",
            "profile image",
            "profileimage_changed",
            "profileimage updated",
            "profileimage=",
            "baseline_profileimage",
            "images/uploads/",
            "upload_file_hit",
            "saved upload",
            "stored as profile",
            "url-fetch sink",
            "cookie session",
            "127.0.0.1",
            "localhost",
            "169.254",
            "metadata",
            "internal host",
            "internal network",
            "content-type: image",
            "content-type: application",
            "application/octet",
            "image/jpeg",
            "image/png",
            "file content",
            "directory listing",
            "quarantine",
            "redirected to",
            "dns callback",
            "out-of-band",
            "oob",
            "non-ok status",
            "empty body",
        )
    )


def is_non_vulnerability_claim(title: str, proof: str = "") -> bool:
    """Positive security observations are not bookable findings."""
    t = f"{title} {proof}".lower()
    patterns = (
        "no user enumeration",
        "no username enumeration",
        "does not enumerate",
        "does not reveal",
        "consistent error messaging",
        "rate-limited",
        "rate limited",
        "anti-abuse",
        "anti abuse",
        "currently mitigated",
        "mitigated",
        "protection present",
        "with protection",
        "confirmed working",
        "functionality confirmed",
        "logout endpoint missing",  # soft observation unless session still valid proven
        "soft-skip",
        "no vulnerability",
        "not vulnerable",
        "properly protected",
        "correctly rejects",
        "not a vulnerability",
    )
    if any(p in t for p in patterns):
        # Allow if proof still shows an exploit effect
        if any(
            x in t
            for x in (
                "bypass",
                "still accepted",
                "still valid",
                "forged",
                "unauthorized write",
                "injection",
            )
        ):
            return False
        return True
    return False


def has_search_injection_surface(state: PenState) -> bool:
    for s in state.surfaces:
        blob = f"{s.path} {s.note}".lower()
        if any(x in blob for x in ("search", "query", "?q=", "/q/", "filter")):
            return True
    for r in state.resources:
        blob = f"{r.name} {' '.join(r.paths)} {r.notes}".lower()
        if "search" in blob or "query" in blob:
            return True
    return False


def _has_sensitive_material(text: str) -> bool:
    """Generic secret/PII-grade material — not a target answer key."""
    t = (text or "").lower()
    if any(
        x in t
        for x in (
            "password",
            "passwd",
            "hash",
            "md5",
            "bcrypt",
            "private key",
            "api_key",
            "apikey",
            "secret",
            "mnemonic",
            "seed phrase",
            "authorization: bearer",
            "role\":\"admin",
            "role=admin",
            '"role":"admin"',
            "keepass",
            ".kdbx",
            "jwt",
            "ssh-rsa",
            "begin rsa",
            "credit card",
            "ssn",
        )
    ):
        return True
    # hex hash-ish 32 chars consecutive
    if re.search(r"\b[a-f0-9]{32}\b", t):
        return True
    return False


def _has_write_or_inject(proof: str) -> bool:
    p = (proof or "").lower()
    return any(
        x in p
        for x in (
            "post ",
            "put ",
            "patch ",
            "delete ",
            "submitted",
            "injected",
            "created ",
            "registered",
            "uploaded",
            "forged",
            "crafted",
            "sent as",
            "request body",
            "with body",
        )
    )


def _has_auth_or_state_effect(proof: str) -> bool:
    p = (proof or "").lower()
    return any(
        x in p
        for x in (
            "logged in",
            "authentication",
            "jwt",
            "token",
            "bypass",
            "role=admin",
            'role":"admin"',
            "role':'admin",
            "http 201",
            "http 200",
            "modified",
            "updated",
            "created user",
            "privilege",
            "whoami",
            "without any authorization",
            "without authorization",
            "no authorization",
            "unauthenticated",
            "unauth",
        )
    )


def evidence_quality_gate(c: Candidate) -> tuple[bool, str]:
    """Generic quality bar: attacker-controlled / differential proof.

    Not a vulnerability allowlist. Rejects common mediocre patterns
    (sightseeing XSS, scoreboard meta, pure SQL error fingerprints).
    """
    proof = (c.proof_excerpt or "").strip()
    if not proof:
        return False, "empty_proof"
    title = (c.title or "").lower()
    loc = (c.location or "").lower()
    impact = (c.impact or "").lower()
    proof_l = proof.lower()
    # Classify from title/location only — proof text often contains unrelated
    # tokens (e.g. config JSON with "xss" flags) that would mis-route the gate.
    klass = infer_vuln_class(c.title, c.location, "")

    # --- Positive security observations are not findings ---
    if is_non_vulnerability_claim(c.title or "", proof):
        return False, "not_a_vulnerability"

    # --- Multi-step identity: ATO/takeover titles need login-after-reset proof ---
    ato_title = any(
        x in title
        for x in (
            "account takeover",
            "ato",
            "takeover",
            "password reset success",
            "full reset",
        )
    )
    if ato_title:
        login_after = any(
            x in proof_l
            for x in (
                "login with new",
                "logged in with new",
                "re-login",
                "relogin",
                "new password",
                "password changed",
                "jwt",
                "authentication successful",
                "whoami",
            )
        ) and any(
            x in proof_l for x in ("login", "whoami", "token", "session", "jwt", "200")
        )
        if not login_after:
            return False, "ato_incomplete_chain_need_login_proof"

    # --- 2FA bypass titles need post-verify auth proof (S3); secret exposure is separate ---
    is_2fa_bypass = (
        ("2fa" in title or "totp" in title or "mfa" in title)
        and any(x in title for x in ("bypass", "disable", "skip", "broken"))
        and "exposure" not in title
        and "secret" not in title
    )
    if is_2fa_bypass:
        s3_proof = any(
            x in proof_l
            for x in (
                "verify",
                "whoami",
                "login after",
                "after 2fa",
                "authenticated",
                "session after",
            )
        ) and any(
            x in proof_l
            for x in ("200", "jwt", "token", "whoami", "authentication", "success")
        )
        if not s3_proof:
            return False, "2fa_bypass_incomplete_need_s3_verify_proof"

    # --- DOM XSS titles need browser execution proof ---
    if "dom" in title and "xss" in title:
        if not any(
            x in proof_l
            for x in (
                "browser",
                "open_eval",
                "open_text",
                "innerhtml",
                "document.",
                "alert",
                "execution",
            )
        ):
            return False, "dom_xss_no_browser_execution_proof"

    # --- XSS: own injection required (title-driven; do not use proof for class) ---
    if (
        klass.startswith("xss")
        or "xss" in title
        or "cross-site scripting" in title
    ):
        if not _has_write_or_inject(proof_l):
            return False, "xss_no_own_injection"
        # Pure GET of someone else's payload
        if re.search(r"\bget\s+/", proof_l) and not re.search(
            r"\b(post|put|patch)\s+/", proof_l
        ):
            if any(
                x in proof_l
                for x in (
                    "test@test.com",
                    "already present",
                    "existing",
                    "from author",
                    "one review from",
                )
            ):
                return False, "xss_third_party_observation"
        return True, "ok"

    # --- SQLi: require data/auth effect beyond error fingerprint (P1.1) ---
    is_sqli = (
        klass.startswith("sqli")
        or "sql injection" in title
        or ("sql" in title and "injection" in title)
        or "sqlite_error" in proof_l
    )
    if is_sqli:
        login_auth_bypass = "login" in title or "login" in loc
        auth_effect = _has_auth_or_state_effect(proof_l) or any(
            x in proof_l
            for x in (
                "jwt",
                "authentication",
                "logged in",
                "bypass",
                "admin@",
            )
        )
        data_effect = injection_data_effect_ok(proof_l)
        error_fp = any(
            x in proof_l
            for x in (
                "sqlite_error",
                "syntax error",
                "sql syntax",
                "mysql",
                "odbc",
                "postgresql",
                "ora-",
            )
        )
        # Login SQLi: auth effect is enough
        if login_auth_bypass:
            if not (auth_effect or data_effect):
                return False, "sqli_login_no_auth_effect"
            return True, "ok"
        # Search/API SQLi: need data effect or stable boolean result-set change; bare error no
        if error_fp and not data_effect and not auth_effect:
            return False, "sqli_error_fingerprint_only"
        if not data_effect and not auth_effect:
            return False, "sqli_no_data_or_auth_effect"
        # Pass: do not fall through to default no_tool_effect (prose proofs often omit "HTTP 200")
        return True, "ok"

    # --- SSRF / server-side fetch (P1.2) ---
    if (
        klass == "ssrf"
        or "ssrf" in title
        or "server-side request" in title
        or "server side request" in title
    ):
        if not ssrf_server_side_ok(proof_l):
            return False, "ssrf_no_server_side_evidence"
        return True, "ok"

    # --- GraphQL ---
    if "graphql" in title or "introspection" in title:
        if any(
            x in proof_l
            for x in (
                "introspection",
                "__schema",
                "querytype",
                "mutation",
                '"data"',
                "types",
            )
        ):
            return True, "ok"
        return False, "graphql_no_schema_or_data"

    # --- SSTI (P2) ---
    if klass == "ssti" or "ssti" in title or "template injection" in title:
        evaluated = any(
            x in proof_l
            for x in ("49", "7777777", "evaluated", "rendered as", "template output")
        )
        injected = _has_write_or_inject(proof_l) or "post " in proof_l or "put " in proof_l
        if not (evaluated and injected):
            return False, "ssti_no_evaluation_proof"
        return True, "ok"

    # --- NoSQL operator injection (P2) ---
    if "nosql" in title or "$ne" in proof_l or "$gt" in proof_l or "$where" in proof_l:
        if "nosql" in title or "mongo" in title:
            if not (
                _has_auth_or_state_effect(proof_l)
                or injection_data_effect_ok(proof_l)
                or "bypass" in proof_l
            ):
                return False, "nosql_no_effect"
            return True, "ok"

    # --- Authz / BAC / mass assignment / unauth write ---
    authzish = (
        klass == "authz"
        or any(
            x in title
            for x in (
                "idor",
                "broken access",
                "bola",
                "bfla",
                "mass assignment",
                "privilege escalat",
                "unauthorized",
                "access control",
            )
        )
        or "unauthenticated" in title
    )
    if authzish:
        if not (
            _has_auth_or_state_effect(proof_l)
            or _has_write_or_inject(proof_l)
            or "without" in proof_l
            or "unauthenticated" in title
            or "unauth" in title
            or "no authentication" in proof_l
            or "without authentication" in proof_l
        ):
            return False, "authz_no_differential"
        # P0.3: require role/actor precondition signal for authz-class books
        pre = (c.precondition or "").strip().lower()
        if pre in ("none", "null", "n/a", "-"):
            pre = ""
        actor_blob = (
            proof_l
            + " "
            + pre
            + " "
            + (c.affected_actor or "").lower()
            + " "
            + title
            + " "
            + loc
        )
        actor_sig = any(
            x in actor_blob
            for x in (
                "actor",
                "user_a",
                "user_b",
                "actor_a",
                "actor_b",
                "unauth",
                "unauthenticated",
                "anonymous",
                "anon",
                "customer",
                "admin",
                "low-priv",
                "authenticated",
                "as user",
                "without auth",
                "without authentication",
                "no authentication",
                "no auth",
                "cross-user",
                "cross user",
                "other user",
                "another user",
                "horizontal",
                "vertical",
            )
        )
        if not actor_sig and not pre:
            return False, "authz_missing_actor_precondition"
        return True, "ok"

    # --- Meta scoreboard / challenge list without secrets ---
    if any(
        x in title or x in loc
        for x in ("challenge", "scoreboard", "solve status", "ctf progress")
    ):
        if not _has_sensitive_material(proof_l):
            return False, "meta_scoreboard_or_progress"

    # --- Weak info-only error disclosure ---
    if "error disclosure" in title or (
        "information disclosure" in title and "error" in proof_l
    ):
        if not _has_sensitive_material(proof_l) and not strong_if_any(proof_l):
            if any(x in proof_l for x in ("sqlite_error", "syntax error", "stack trace")):
                return False, "error_fingerprint_only"

    # --- Default: need tool-shaped effect OR sensitive material OR strong write ---
    if not (
        _has_auth_or_state_effect(proof_l)
        or _has_write_or_inject(proof_l)
        or _has_sensitive_material(proof_l)
        or "http " in proof_l
        and any(x in proof_l for x in ("200", "201", "401", "403", "500"))
    ):
        return False, "no_tool_effect"

    # Pure public GET info without secrets / writes: reject weak meta exposures
    get_only = re.search(r"\bget\s+/", proof_l) and not re.search(
        r"\b(post|put|patch|delete)\s+/", proof_l
    )
    if get_only and not _has_write_or_inject(proof_l) and not _has_auth_or_state_effect(proof_l):
        if klass == "dirlist" or "directory listing" in title or "/ftp" in loc:
            if any(
                x in proof_l
                for x in (".md", ".bak", ".kdbx", ".pdf", "quarantine", "coupon", "index of")
            ):
                return True, "ok"
            if not _has_sensitive_material(proof_l + impact):
                return False, "dirlist_no_sensitive"
        if klass == "config" or "configuration" in title:
            if any(
                x in proof_l
                for x in ("clientid", "client_id", "oauth", "secret", "password", "hash")
            ):
                return True, "ok"
            if not _has_sensitive_material(proof_l + impact):
                return False, "config_no_sensitive"
        if any(x in title for x in ("excessive", "solve status", "challenge list")):
            if not _has_sensitive_material(proof_l + impact):
                return False, "public_get_info_only"

    return True, "ok"


def strong_if_any(proof_l: str) -> bool:
    return _has_auth_or_state_effect(proof_l) or _has_sensitive_material(proof_l)


def apply_severity_cap(c: Candidate) -> str:
    """Deterministic severity discipline — never inflate, may lower."""
    sev = (c.severity or "medium").strip().lower() or "medium"
    if sev not in _SEV_RANK:
        sev = "medium"
    title = (c.title or "").lower()
    proof = (c.proof_excerpt or "").lower()
    klass = infer_vuln_class(c.title, c.location, "")
    strong = _has_sensitive_material(proof) or any(
        x in proof
        for x in (
            "role=admin",
            'role":"admin"',
            "alg\":\"none",
            "alg': 'none",
            "alg=none",
            "logged in",
            "authentication",
        )
    )

    cap: str | None = None
    if any(x in title for x in ("challenge", "scoreboard", "solve status")):
        cap = "low"
    elif klass in ("config", "dirlist") or "disclosure" in title or "excessive data" in title:
        if not strong:
            cap = "medium"
    elif "error disclosure" in title or "information disclosure" in title:
        if not strong:
            cap = "low"

    if cap is None:
        return c.severity or sev
    if _SEV_RANK.get(sev, 2) > _SEV_RANK[cap]:
        return cap
    return c.severity or sev


def _surface_paths(state: PenState) -> list[str]:
    paths: list[str] = []
    for s in state.surfaces:
        p = normalize_path(s.path, state.target) or (s.path or "").strip()
        if p:
            paths.append(p.lower())
    return sorted(set(paths))


def surface_ledger_ok(state: PenState) -> tuple[bool, str]:
    """Surface stage must land enough paths into State (not only summary prose)."""
    if state.dry_run:
        return True, "dry-run"
    uniq = _surface_paths(state)
    if len(uniq) < 6:
        return False, f"surface_count={len(uniq)} need>=6"

    # App-ish / content paths (generic heuristics, not a target answer key)
    markers = (
        "/vulnerabilit",
        "/api",
        "/rest",
        "/admin",
        "/login",
        "/upload",
        "/config",
        "/hackable",
        "/graphql",
        "/user",
        "/account",
        "/basket",
        "/cart",
        "/order",
        "/b2b",
        "/profile",
        ".php",
        ".jsp",
        ".aspx",
        ".do",
    )
    appish = [p for p in uniq if any(m in p for m in markers)]
    if len(appish) < 3:
        return False, f"appish_paths={len(appish)} need>=3 (total={len(uniq)})"

    # API-shaped apps need denser appish ledger (still generic — no vuln names)
    api_shaped = any("/api" in p or "/rest" in p for p in uniq)
    if api_shaped and len(appish) < 5:
        return False, f"api_appish={len(appish)} need>=5 (total={len(uniq)})"
    if api_shaped:
        auth_ish = any(
            any(m in p for m in ("login", "register", "user", "auth", "session", "whoami"))
            for p in uniq
        )
        if not auth_ish:
            return False, "api_present but no auth/user surface"
    return True, f"surfaces={len(uniq)} appish={len(appish)}"


def surface_needs_salvage(state: PenState) -> tuple[bool, str]:
    """True when ledger is thin enough to warrant deterministic salvage/probes.

    Broader than surface_ledger_ok failure: also catches API apps missing
    common resource families (still not target answer keys).
    """
    if state.dry_run:
        return False, "dry-run"
    ok, det = surface_ledger_ok(state)
    if not ok:
        return True, det
    uniq = _surface_paths(state)
    api_shaped = any("/api" in p or "/rest" in p for p in uniq)
    if not api_shaped:
        return False, "ok"
    # Object-ish collection paths help Agent Graph path partition
    object_ish = [
        p
        for p in uniq
        if any(
            m in p
            for m in (
                "/user",
                "/product",
                "/basket",
                "/cart",
                "/order",
                "/feedback",
                "/card",
                "/payment",
                "/register",
                "/login",
                "/search",
                "/profile",
            )
        )
    ]
    if len(object_ish) < 4:
        return True, f"api_object_ish={len(object_ish)} need>=4"
    return False, "ok"


def evaluate_stage(
    state: PenState,
    stage: str,
    *,
    payload: dict[str, Any] | None,
    tool_calls: int,
    new_candidates: int = 0,
    fan_out: bool = False,
    structured_workers: int = 0,
) -> StageFeedback:
    details: list[str] = []

    if fan_out:
        structure_ok = structured_workers > 0 or payload is not None
        if not structure_ok:
            details.append("no structured worker outputs")
    elif stage == "coverage_probe":
        # Deterministic probes; JSON optional
        structure_ok = payload is not None or tool_calls > 0 or state.dry_run
        if not structure_ok:
            details.append("coverage_probe produced no probe result")
    else:
        structure_ok = payload is not None
        if not structure_ok:
            details.append("no parseable JSON")

    pure_judgment = stage in ("prior_reverify",)
    tool_ok = tool_calls > 0 or state.dry_run
    if not tool_ok and pure_judgment:
        tool_ok = True
        details.append("tool_use soft-pass for judgment stage")
    elif not tool_ok and stage == "coverage_probe" and state.dry_run:
        tool_ok = True
    elif not tool_ok:
        details.append(f"tool_calls={tool_calls}")

    stage_cands = [
        c
        for c in state.candidates
        if c.stage == stage or (c.worker_id and c.worker_id.startswith(stage))
    ]
    ready = [c for c in stage_cands if c.ready_to_book]
    bad_ready: list[Candidate] = []
    quality_cleared = 0
    for c in ready:
        if not _fresh_proof_ok(c.proof_excerpt):
            bad_ready.append(c)
            continue
        ok, reason = evidence_quality_gate(c)
        if not ok:
            c.ready_to_book = False
            quality_cleared += 1
            details.append(f"quality:{reason}")
    for c in bad_ready:
        c.ready_to_book = False

    evidence_ok = len(bad_ready) == 0 and quality_cleared == 0
    if bad_ready:
        details.append(f"weak_proof_ready={len(bad_ready)}")
        state.feedback_log(
            "evidence",
            stage,
            False,
            f"cleared ready_to_book on {len(bad_ready)} weak-proof candidate(s)",
        )
    elif quality_cleared:
        state.feedback_log(
            "evidence_quality",
            stage,
            False,
            f"cleared ready_to_book on {quality_cleared} low-quality candidate(s)",
        )
        state.feedback_log("evidence", stage, True, f"ready={len(ready) - quality_cleared}")
    else:
        state.feedback_log("evidence", stage, True, f"ready={len(ready)}")

    # Surface ledger loop
    ledger_ok = True
    ledger_detail = "n/a"
    model_ok = True
    model_detail = "n/a"
    if stage == "surface":
        ledger_ok, ledger_detail = surface_ledger_ok(state)
        state.feedback_log("surface_ledger", stage, ledger_ok, ledger_detail)
        if not ledger_ok:
            details.append(ledger_detail)
        model_ok, model_detail = surface_model_ok(state)
        state.feedback_log("surface_model", stage, model_ok, model_detail)
        if not model_ok:
            details.append(model_detail)

    # Coverage: class_probe + injection depth + authz dual-actor
    injection_retry = False
    discovery_retry = False
    discovery_soft_fail = False
    if stage == "class_probe" and not state.dry_run:
        coverage_ok = new_candidates > 0 or any(s.status == "probed" for s in state.surfaces)
        if not coverage_ok and state.surfaces:
            details.append(f"open_surfaces={len(state.surfaces)} but no new candidates")
        # Process yield: many workers / rich surfaces but almost no new candidates
        ready_n = len([c for c in stage_cands if c.ready_to_book])
        if (
            fan_out
            and structured_workers >= _CLASS_PROBE_MIN_WORKERS_FOR_YIELD
            and len(state.surfaces) >= _CLASS_PROBE_MIN_SURFACES_FOR_YIELD
        ):
            min_cands = 2 if structured_workers >= 4 else 1
            if new_candidates < min_cands:
                discovery_soft_fail = True
                discovery_retry = True
                details.append(
                    f"discovery_low_yield new_cands={new_candidates} "
                    f"workers={structured_workers} min={min_cands}"
                )
                state.feedback_log(
                    "discovery_yield",
                    stage,
                    False,
                    f"new_cands={new_candidates} ready={ready_n} "
                    f"structured_workers={structured_workers} min={min_cands}",
                )
            else:
                state.feedback_log(
                    "discovery_yield",
                    stage,
                    True,
                    f"new_cands={new_candidates} ready={ready_n} "
                    f"structured_workers={structured_workers}",
                )
        # P1.1: search surface present but only error-level sqli candidates
        if has_search_injection_surface(state):
            sqli_cands = [
                c
                for c in stage_cands
                if "sql" in (c.title or "").lower() or "injection" in (c.title or "").lower()
            ]
            deep = [
                c
                for c in sqli_cands
                if injection_data_effect_ok(c.proof_excerpt or "")
                or _has_auth_or_state_effect(c.proof_excerpt or "")
            ]
            shallow = [
                c
                for c in sqli_cands
                if c not in deep
                and any(
                    x in (c.proof_excerpt or "").lower()
                    for x in ("sqlite_error", "syntax error", "sql syntax", "http 500")
                )
            ]
            if shallow and not deep:
                state.feedback_log(
                    "injection_depth",
                    stage,
                    False,
                    f"search_surface_with_error_only_sqli={len(shallow)}",
                )
                details.append("injection_depth_shallow")
                injection_retry = True
            else:
                state.feedback_log(
                    "injection_depth",
                    stage,
                    True,
                    f"sqli_cands={len(sqli_cands)} deep={len(deep)}",
                )
    elif stage in _DISCOVERY_READY_STAGES and not state.dry_run:
        coverage_ok = True
        ready_after = sum(1 for c in stage_cands if c.ready_to_book)
        # Tools ran hard, structure ok, but zero ready candidates → process hole (v11 prior/auth)
        if (
            structure_ok
            and tool_ok
            and ready_after == 0
            and tool_calls >= _EMPTY_READY_MIN_TOOLS
            and len(state.surfaces) >= 6
        ):
            discovery_retry = True
            discovery_soft_fail = True
            details.append("discovery_empty_ready")
            state.feedback_log(
                "discovery_yield",
                stage,
                False,
                f"ready=0 tools={tool_calls} surfaces={len(state.surfaces)}",
            )
        else:
            state.feedback_log(
                "discovery_yield",
                stage,
                True,
                f"ready={ready_after} tools={tool_calls}",
            )
    elif stage == "authz_logic" and not state.dry_run:
        sens = [
            r
            for r in state.resources
            if r.sensitivity in ("user", "admin", "secret")
        ]
        dual = any(a.id in ("actor_a", "actor_b") for a in state.actors) or len(
            state.actor_cookies
        ) >= 2
        authz_ready = [
            c
            for c in stage_cands
            if c.ready_to_book or (c.precondition and c.proof_excerpt)
        ]
        if sens and dual and not authz_ready and structure_ok:
            coverage_ok = False
            details.append("authz_matrix_empty")
            state.feedback_log(
                "authz_coverage",
                stage,
                False,
                f"sensitive_resources={len(sens)} dual_actor_ready but no authz candidates",
            )
        else:
            coverage_ok = True
            state.feedback_log(
                "authz_coverage",
                stage,
                True,
                f"sens={len(sens)} authz_cands={len(authz_ready)}",
            )
    else:
        coverage_ok = True

    # Surface/class_probe coverage gaps from required_coverage (Feedback owns coverage)
    coverage_retry = False
    if stage in ("coverage_probe", "class_probe", "finalize") and not state.dry_run:
        from node5.coverage import compute_coverage_metrics, untested_required

        compute_coverage_metrics(state)
        unt = untested_required(state)
        if unt and stage == "coverage_probe":
            coverage_ok = False
            details.append(f"untested_coverage={unt[:8]}")
            state.feedback_log(
                "coverage",
                stage,
                False,
                f"untested={unt} (must attempt; no silent skip)",
            )
            coverage_retry = True
        elif unt and stage == "class_probe":
            # class_probe may leave gaps for coverage_probe; log soft coverage note
            state.feedback_log(
                "coverage",
                stage,
                True,
                f"deferred_to_coverage_probe untested={unt[:6]}",
            )
        elif stage == "coverage_probe":
            state.feedback_log(
                "coverage",
                stage,
                True,
                f"all_required_attempted_or_none required={state.coverage_metrics.get('coverage_required_n')}",
            )

    state.feedback_log(
        "structure",
        stage,
        structure_ok,
        details[0] if not structure_ok else "json_ok",
    )
    state.feedback_log("tool_use", stage, tool_ok, f"calls={tool_calls}")
    if stage == "class_probe":
        state.feedback_log("coverage", stage, coverage_ok, f"new_candidates={new_candidates}")

    # Retry policy (bounded one shot at stage runner — process contracts, not answer keys):
    # - surface: weak ledger OR model OR no JSON
    # - json-required stages: no parseable structure (even if tools ran)
    # - discovery empty/low yield after real tool work
    # - fan-out dead: no structured workers
    # - coverage_probe: untested required coverage
    should_retry = False
    if not state.dry_run:
        if stage == "surface" and (not ledger_ok or not model_ok or not structure_ok):
            should_retry = True
        elif stage in _JSON_REQUIRED_STAGES and not structure_ok:
            should_retry = True
        elif fan_out and structured_workers == 0:
            should_retry = True
        elif stage == "class_probe" and injection_retry and not fan_out:
            # Captain path only: one depth retry when fan-out already joined
            should_retry = True
        elif fan_out and injection_retry:
            # After fan-out, still request captain retry for injection depth
            should_retry = True
        elif discovery_retry:
            should_retry = True
        elif stage == "coverage_probe" and coverage_retry:
            should_retry = True

    return StageFeedback(
        structure_ok=structure_ok,
        tool_ok=tool_ok,
        evidence_ok=evidence_ok,
        coverage_ok=coverage_ok,
        surface_ledger_ok=ledger_ok,
        should_retry=should_retry,
        details=details,
    )


def process_quality_metrics(state: PenState) -> dict[str, Any]:
    """Aggregate process contracts for summary (orthogonal to coverage_attempt_rate)."""
    fb = state.feedback or []
    structure_fails = [
        f for f in fb if f.loop == "structure" and not f.ok
    ]
    discovery_fails = [
        f for f in fb if f.loop == "discovery_yield" and not f.ok
    ]
    discovery_ok = [
        f for f in fb if f.loop == "discovery_yield" and f.ok
    ]
    retries = [f for f in fb if f.loop == "retry" and f.ok]
    surface_fails = [
        f for f in fb if f.loop == "surface_ledger" and not f.ok
    ]
    # Per-stage ready counts from evidence log detail ready=N
    ready_by_stage: dict[str, int] = {}
    for f in fb:
        if f.loop == "evidence" and f.detail.startswith("ready="):
            try:
                ready_by_stage[f.stage] = int(f.detail.split("=", 1)[1].split()[0])
            except ValueError:
                pass
    class_probe_yield = next(
        (f.detail for f in fb if f.loop == "discovery_yield" and f.stage == "class_probe"),
        "",
    )
    return {
        "structure_fail_n": len(structure_fails),
        "structure_fail_stages": sorted({f.stage for f in structure_fails}),
        "discovery_yield_soft_fail_n": len(discovery_fails),
        "discovery_yield_soft_fail_stages": sorted({f.stage for f in discovery_fails}),
        "discovery_yield_ok_n": len(discovery_ok),
        "retry_n": len(retries),
        "surface_ledger_fail_n": len(surface_fails),
        "ready_by_stage": ready_by_stage,
        "class_probe_discovery_yield": class_probe_yield,
        # Explicit: process health is not coverage attempt rate
        "note": "process_quality orthogonal to coverage_attempt_rate",
    }


def prior_reverify_bookable(c: Candidate) -> tuple[bool, str]:
    """prior_reverify may only book hard exploit / secret-grade issues.

    Pure list-API exposures and recon-style GETs wait for auth/class/authz stages.
    """
    if (c.stage or "") != "prior_reverify":
        return True, "ok"
    title = (c.title or "").lower()
    proof = (c.proof_excerpt or "").lower()
    blob = f"{title} {proof}"
    jwt_hard = any(
        x in blob for x in ("alg:none", "alg none", "algorithm confusion")
    ) or (
        "jwt" in blob
        and any(x in blob for x in ("accept", "bypass", "whoami", "authentication", "forged", "alg"))
    )
    hard = (
        "sql injection" in title
        or "mass assignment" in title
        or jwt_hard
        or any(
            x in title
            for x in (
                "unauth",
                "without auth",
                "privilege escalat",
                "null-byte",
                "path traversal",
            )
        )
        or (
            re.search(r"\b(put|post|patch|delete)\b", proof)
            and any(
                x in blob
                for x in (
                    "without",
                    "unauth",
                    "no authorization",
                    "role=admin",
                    'role":"admin',
                )
            )
        )
        or (
            _has_sensitive_material(proof)
            and any(
                x in blob
                for x in (
                    "password",
                    "hash",
                    "kdbx",
                    "private key",
                    "mnemonic",
                    "seed phrase",
                )
            )
        )
    )
    if hard:
        return True, "prior_hard"
    return False, "prior_defer_list_or_recon"


# Max prior_reverify findings after strength sort (hard-only already filtered)
_PRIOR_BOOK_CAP = 4


def promote_bookable_candidates(state: PenState) -> int:
    """Set ready_to_book when full fields + quality gate pass (models often forget flag)."""
    n = 0
    for c in state.candidates:
        if (c.stage or "") == "surface":
            if c.ready_to_book:
                c.ready_to_book = False
            continue
        if not (c.causality and c.reproducibility and c.impact and c.proof_excerpt):
            continue
        if not _fresh_proof_ok(c.proof_excerpt):
            if c.ready_to_book:
                c.ready_to_book = False
            continue
        ok, _reason = evidence_quality_gate(c)
        if ok:
            if not c.ready_to_book:
                c.ready_to_book = True
                n += 1
        elif c.ready_to_book:
            c.ready_to_book = False
    return n


def filter_bookable(candidates: list[Candidate]) -> list[Candidate]:
    """Book candidates that clear field bar + proof freshness + quality gate.

    ready_to_book is preferred but not required when evidence quality passes
    (models sometimes fill bars and forget the flag).
    prior_reverify: hard exploits only, capped.
    """
    out: list[Candidate] = []
    prior_pool: list[Candidate] = []
    for c in candidates:
        if not (c.causality and c.reproducibility and c.impact and c.proof_excerpt):
            continue
        if not _fresh_proof_ok(c.proof_excerpt):
            continue
        ok, _reason = evidence_quality_gate(c)
        if not ok:
            continue
        ok_p, _pr = prior_reverify_bookable(c)
        if not ok_p:
            continue
        capped = apply_severity_cap(c)
        if capped != c.severity:
            c.severity = capped
        if (c.stage or "") == "prior_reverify":
            prior_pool.append(c)
        else:
            out.append(c)

    if prior_pool:
        from node5.identity import proof_strength

        prior_pool.sort(key=proof_strength, reverse=True)
        out.extend(prior_pool[:_PRIOR_BOOK_CAP])
    return out


def unclosed_surface_paths(state: PenState) -> list[str]:
    """Paths still open/probed without a booked finding identity."""
    booked_paths = set()
    for f in state.findings:
        booked_paths.add(normalize_path(f.location, state.target))
    for c in state.candidates:
        if c.ready_to_book:
            booked_paths.add(normalize_path(c.location, state.target))
    out = []
    for s in state.surfaces:
        p = normalize_path(s.path, state.target)
        if not p:
            continue
        if s.status in ("open", "probed") and p not in booked_paths:
            out.append(p)
    return out[:20]
