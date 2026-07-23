"""Attack-surface coverage for Feedback Graph (not a fourth Graph).

required_coverage() derives what must be attempted from live surfaces/resources.
coverage_ledger on PenState is append-only probe records.
Hints feed Agent prompts; metrics report required/attempted/closed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from node5.identity import infer_vuln_class
from node5.state import PenState

CoverageOutcome = Literal["attempted", "closed", "failed", "blocked"]


@dataclass
class CoverageReq:
    id: str
    reason: str
    paths: list[str] = field(default_factory=list)
    priority: int = 50  # lower = earlier probe


def _surface_blob(state: PenState) -> str:
    return " ".join(f"{s.path} {s.note}" for s in state.surfaces).lower()


def _paths_matching(state: PenState, *needles: str) -> list[str]:
    out: list[str] = []
    for s in state.surfaces:
        p = f"{s.path} {s.note}".lower()
        if any(n in p for n in needles):
            path = s.path or ""
            if path and path not in out:
                out.append(path)
    return out[:12]


def _has_path(state: PenState, *needles: str) -> bool:
    return bool(_paths_matching(state, *needles))


def required_coverage(state: PenState) -> list[CoverageReq]:
    """Derive coverage requirements from ledger signals (generic, not target keys)."""
    reqs: list[CoverageReq] = []
    blob = _surface_blob(state)

    if _has_path(state, "search", "query", "?q=") or "search" in blob:
        reqs.append(
            CoverageReq(
                id="injection_search",
                reason="Search/query surface — injection ladder to data/auth effect",
                paths=_paths_matching(state, "search", "query", "?q="),
                priority=10,
            )
        )
    if any(
        x in blob
        for x in ("image/url", "profile/image", "webhook", "callback", "[egress]")
    ):
        reqs.append(
            CoverageReq(
                id="ssrf_url_sink",
                reason="URL-fetch sink — prove server-side fetch",
                paths=_paths_matching(
                    state, "image/url", "profile/image", "webhook", "callback"
                ),
                priority=15,
            )
        )
    if "graphql" in blob or "graphiql" in blob:
        reqs.append(
            CoverageReq(
                id="graphql",
                reason="GraphQL endpoint — introspection and/or authz data probe",
                paths=_paths_matching(state, "graphql"),
                priority=20,
            )
        )
    if any(
        x in blob
        for x in (
            "reset-password",
            "reset_password",
            "forgot",
            "security-question",
            "security_question",
        )
    ):
        reqs.append(
            CoverageReq(
                id="identity_reset",
                reason="Reset/security-question surface",
                paths=_paths_matching(
                    state, "reset-password", "forgot", "security-question", "security"
                ),
                priority=25,
            )
        )
    if "change-password" in blob or "change_password" in blob:
        reqs.append(
            CoverageReq(
                id="identity_change_password",
                reason="Change-password surface",
                paths=_paths_matching(state, "change-password", "change_password"),
                priority=26,
            )
        )
    totp_signal = any(x in blob for x in ("2fa", "totp", "mfa", "otp")) or any(
        any(
            x in f"{c.title} {c.proof_excerpt}".lower()
            for x in ("totp", "totpsecret", "2fa", "otp secret")
        )
        for c in state.candidates
    ) or any(
        any(x in f"{f.title} {f.proof}".lower() for x in ("totp", "totpsecret", "2fa"))
        for f in state.findings
    )
    if totp_signal:
        reqs.append(
            CoverageReq(
                id="identity_2fa",
                reason="2FA/OTP signal (surface or SQLi data) — probe related endpoints",
                paths=_paths_matching(state, "2fa", "totp", "mfa", "otp"),
                priority=27,
            )
        )
    if any(x in blob for x in ("encryptionkey", "jwt.pub", ".pem", "key_material")):
        reqs.append(
            CoverageReq(
                id="jwt_key_material",
                reason="Key material surface — signed JWT confusion with accept proof",
                paths=_paths_matching(state, "encryptionkey", "jwt.pub", ".pem"),
                priority=18,
            )
        )
    if any(
        x in blob
        for x in ("register", "/users", "basket", "cart", "order", "login", "/api/")
    ):
        reqs.append(
            CoverageReq(
                id="authz_matrix",
                reason="Multi-user/API surfaces — dual-actor or unauth differential",
                paths=_paths_matching(
                    state, "basket", "user", "order", "complaint", "cart", "api"
                ),
                priority=30,
            )
        )
    if any(x in blob for x in ("upload", "image/file", "multipart")):
        reqs.append(
            CoverageReq(
                id="upload",
                reason="Upload sink — type/path impact",
                paths=_paths_matching(state, "upload", "image/file", "multipart"),
                priority=40,
            )
        )
    if any(x in blob for x in ("review", "comment", "guestbook", "feedback")):
        reqs.append(
            CoverageReq(
                id="xss_self_inject",
                reason="UGC surface — self-inject XSS proof",
                paths=_paths_matching(state, "review", "comment", "guestbook", "feedback"),
                priority=45,
            )
        )
    if any(x in blob for x in ("support/logs", "/logs", "encryptionkey", "metrics")):
        reqs.append(
            CoverageReq(
                id="sensitive_tech_exposure",
                reason="Logs/keys/metrics — secret-grade content only",
                paths=_paths_matching(
                    state, "support/logs", "/logs", "encryptionkey", "metrics"
                ),
                priority=35,
            )
        )
    if any(
        x in blob
        for x in ("review", "comment", "#/", "angular", "spa", "socket.io")
    ) or any("script" in (c.proof_excerpt or "").lower() for c in state.candidates):
        reqs.append(
            CoverageReq(
                id="dom_client",
                reason="SPA/UGC — DOM/client XSS needs browser execution proof",
                paths=_paths_matching(state, "review", "comment", "search"),
                priority=48,
            )
        )
    if any(
        x in blob
        for x in ("basket", "cart", "quantity", "coupon", "payment", "order")
    ):
        reqs.append(
            CoverageReq(
                id="business_logic",
                reason="Cart/order/payment — parameter tamper differentials",
                paths=_paths_matching(
                    state, "basket", "cart", "quantity", "coupon", "payment", "order"
                ),
                priority=50,
            )
        )
    if any(x in blob for x in ("socket.io", "websocket", "/ws")):
        reqs.append(
            CoverageReq(
                id="websocket",
                reason="WebSocket/socket.io — handshake/authz observation",
                paths=_paths_matching(state, "socket.io", "websocket", "/ws"),
                priority=55,
            )
        )
    # Dedupe by id keep first
    seen: set[str] = set()
    out: list[CoverageReq] = []
    for r in sorted(reqs, key=lambda x: (x.priority, x.id)):
        if r.id in seen:
            continue
        seen.add(r.id)
        out.append(r)
    return out


def _ledger_for(state: PenState, cov_id: str) -> list[dict[str, Any]]:
    return [e for e in (state.coverage_ledger or []) if e.get("id") == cov_id]


def _quality_closed(state: PenState, cov_id: str) -> bool:
    """True if a quality-ish candidate/finding matches this coverage family."""
    from node5.feedback import evidence_quality_gate

    keywords: dict[str, tuple[str, ...]] = {
        "injection_search": ("sql", "injection", "union", "boolean"),
        "ssrf_url_sink": ("ssrf", "server-side request", "url-fetch"),
        "graphql": ("graphql", "introspection"),
        "identity_reset": ("reset", "security question", "forgot"),
        "identity_change_password": ("change-password", "change password", "current password"),
        "identity_2fa": ("2fa", "totp", "otp", "mfa"),
        "jwt_key_material": ("jwt", "algorithm", "hs256", "alg:none", "alg none"),
        "authz_matrix": ("access control", "bola", "idor", "unauthenticated", "authz", "broken access"),
        "upload": ("upload", "multipart", "filename"),
        "xss_self_inject": ("xss", "cross-site", "self-inject"),
        "sensitive_tech_exposure": ("encryption", "key material", "directory listing", "log"),
        "dom_client": ("dom xss", "dom-based", "client-side xss", "browser"),
        "business_logic": ("price", "quantity", "coupon", "business logic", "mass assignment"),
        "websocket": ("websocket", "socket.io"),
    }
    keys = keywords.get(cov_id, (cov_id,))
    for c in state.candidates:
        title = (c.title or "").lower()
        if not any(k in title for k in keys):
            continue
        if c.causality and c.reproducibility and c.impact and c.proof_excerpt:
            ok, _ = evidence_quality_gate(c)
            if ok:
                return True
    for f in state.findings:
        title = (f.title or "").lower()
        if any(k in title for k in keys) and (f.proof or ""):
            return True
    return False


def coverage_outcome(state: PenState, cov_id: str) -> str:
    """untested | attempted | closed | failed | blocked"""
    rows = _ledger_for(state, cov_id)
    if _quality_closed(state, cov_id):
        return "closed"
    if not rows:
        return "untested"
    last = rows[-1]
    outcome = str(last.get("outcome") or "attempted")
    if outcome in ("failed", "blocked", "closed", "attempted"):
        if outcome == "attempted" and any(r.get("outcome") == "failed" for r in rows):
            return "failed"
        return outcome
    return "attempted"


def record_coverage(
    state: PenState,
    cov_id: str,
    *,
    outcome: CoverageOutcome,
    detail: str = "",
    paths: list[str] | None = None,
) -> None:
    """Append-only ledger entry (Feedback reads this; not a campaign state machine)."""
    entry = {
        "id": cov_id,
        "outcome": outcome,
        "detail": (detail or "")[:500],
        "paths": list(paths or [])[:8],
    }
    state.coverage_ledger.append(entry)
    state.note(f"coverage[{cov_id}] {outcome} {detail[:120]}".strip())


def coverage_hints(state: PenState, *, limit: int = 6) -> str:
    """Agent prompt block: untested/failed required coverage (not a challenge list)."""
    reqs = required_coverage(state)
    lines: list[str] = []
    tips = {
        "injection_search": "Complete SQL ladder to data/auth effect (not error-only).",
        "ssrf_url_sink": "Authenticated URL-fetch sink; prove server-side fetch / profileImage change.",
        "graphql": "Introspection and/or authz data query with proof.",
        "identity_reset": "Reset/security-question without inventing secrets.",
        "identity_change_password": "Empty/missing current password only with accept proof.",
        "identity_2fa": "Probe 2FA endpoints if present within RoE.",
        "jwt_key_material": "Key file + server ACCEPTANCE of forged signed token.",
        "authz_matrix": "Dual-actor or unauth differential on object resources.",
        "upload": "Type/path impact with stored path proof.",
        "xss_self_inject": "Self-inject marker via POST/PUT then re-fetch.",
        "sensitive_tech_exposure": "Secret-grade content only.",
        "dom_client": "Use browser tool: open SPA route, prove marker execution.",
        "business_logic": "Tamper qty/price/coupon; book only with state differential.",
        "websocket": "Probe socket.io/ws handshake and authz if tools allow.",
    }
    for r in reqs:
        st = coverage_outcome(state, r.id)
        if st in ("closed",):
            continue
        if st == "untested" or st == "failed" or st == "blocked":
            tip = tips.get(r.id, "")
            paths = ", ".join(r.paths[:4]) if r.paths else ""
            lines.append(
                f"COVERAGE GAP [{st}] {r.id}: {r.reason}"
                + (f" paths=[{paths}]" if paths else "")
                + (f" — {tip}" if tip else "")
            )
        if len(lines) >= limit:
            break
    if not lines:
        return ""
    return "COVERAGE GAPS (Feedback — attempt before finishing):\n" + "\n".join(lines)


def compute_coverage_metrics(state: PenState) -> dict[str, Any]:
    """Fill state.coverage_metrics / hv_metrics for summary."""
    reqs = required_coverage(state)
    required_ids = [r.id for r in reqs]
    statuses = {rid: coverage_outcome(state, rid) for rid in required_ids}
    attempted = [
        rid
        for rid, st in statuses.items()
        if st in ("attempted", "closed", "failed", "blocked")
    ]
    closed = [rid for rid, st in statuses.items() if st == "closed"]
    failed = [rid for rid, st in statuses.items() if st == "failed"]
    blocked = [rid for rid, st in statuses.items() if st == "blocked"]
    untested = [rid for rid, st in statuses.items() if st == "untested"]
    n_req = len(required_ids) or 0
    n_att = len(attempted)
    n_closed = len(closed)
    metrics: dict[str, Any] = {
        "coverage_required": required_ids,
        "coverage_attempted": attempted,
        "coverage_closed": closed,
        "coverage_failed": failed,
        "coverage_blocked": blocked,
        "coverage_untested": untested,
        "coverage_required_n": n_req,
        "coverage_attempted_n": n_att,
        "coverage_closed_n": n_closed,
        "coverage_blocked_n": len(blocked),
        "coverage_attempt_rate": round(n_att / n_req, 3) if n_req else 1.0,
        "coverage_close_rate": round(n_closed / n_att, 3) if n_att else 0.0,
        "coverage_statuses": statuses,
        "forced_packages": list(state.forced_packages or []),
        "effective_max_workers": state.effective_max_workers or state.max_workers,
        "authz_matrix_cells": len(state.authz_matrix or []),
        # legacy aliases for older EVAL readers
        "hv_campaigns_opened": n_req,
        "hv_campaigns_attempted": n_att,
        "hv_campaigns_booked": n_closed,
        "hv_attempt_rate": round(n_att / n_req, 3) if n_req else 1.0,
        "hv_success_rate": round(n_closed / n_att, 3) if n_att else 0.0,
    }
    # recon hits (lightweight)
    surf = _surface_blob(state)
    recon = []
    for name, needles in (
        ("encryptionkeys", ("encryptionkey", "jwt.pub")),
        ("image_url", ("image/url", "profile/image")),
        ("search", ("search", "products/search")),
        ("logs", ("support/logs", "/logs")),
        ("graphql", ("graphql",)),
    ):
        if any(n in surf for n in needles):
            recon.append(name)
    metrics["hv_recon_hits"] = recon
    metrics["hv_recon_hit_count"] = len(recon)
    state.coverage_metrics = metrics
    state.hv_metrics = metrics  # keep field for older code paths
    return metrics


def untested_required(state: PenState) -> list[str]:
    return [
        r.id
        for r in required_coverage(state)
        if coverage_outcome(state, r.id) == "untested"
    ]
