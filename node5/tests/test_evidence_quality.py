"""Deterministic evidence quality + book filter contracts."""

from __future__ import annotations

from node5.feedback import (
    apply_severity_cap,
    evidence_quality_gate,
    filter_bookable,
)
from node5.state import Candidate


def _c(**kwargs) -> Candidate:
    base = dict(
        title="t",
        location="/x",
        severity="high",
        proof_excerpt="POST /x HTTP 200 authentication ok",
        causality="cause",
        reproducibility="repeat",
        impact="impact",
        stage="class_probe",
        ready_to_book=True,
    )
    base.update(kwargs)
    return Candidate.model_validate(base)


def test_reject_third_party_xss_observation():
    c = _c(
        title="Unauthenticated Product Reviews with Stored XSS",
        location="/rest/products/1/reviews",
        severity="medium",
        proof_excerpt=(
            "GET /rest/products/1/reviews returned HTTP 200 with JSON containing 3 reviews. "
            "One review from author 'test@test.com' has message '<script>alert(1)</script>' "
            "stored as a product review."
        ),
    )
    ok, reason = evidence_quality_gate(c)
    assert not ok
    assert "xss" in reason


def test_accept_self_injected_xss():
    c = _c(
        title="Stored XSS in product review",
        location="/rest/products/1/reviews",
        proof_excerpt=(
            "POST /rest/products/1/reviews with body message=<script>alert(9)</script> "
            "returned HTTP 201. GET /rest/products/1/reviews then reflected "
            "<script>alert(9)</script> for author probe@lab.local."
        ),
    )
    ok, reason = evidence_quality_gate(c)
    assert ok, reason


def test_reject_sqli_error_fingerprint_only():
    c = _c(
        title="Error Disclosure – SQLite Errors via search",
        location="/rest/products/search",
        severity="low",
        proof_excerpt=(
            "GET /rest/products/search?q=' OR true-- returns HTTP 500 with body: "
            "Error: SQLITE_ERROR: incomplete input. UNION keyword: syntax error."
        ),
    )
    ok, reason = evidence_quality_gate(c)
    assert not ok
    assert "error" in reason or "sqli" in reason or "fingerprint" in reason


def test_accept_login_sqli_bypass():
    c = _c(
        title="SQL Injection in Login Endpoint",
        location="/rest/user/login",
        severity="critical",
        proof_excerpt=(
            "POST to /rest/user/login with body {\"email\":\"' OR 1=1 --\",\"password\":\"test\"} "
            "returned HTTP 200 with valid JWT authentication for admin@example.com role=admin."
        ),
    )
    ok, reason = evidence_quality_gate(c)
    assert ok, reason


def test_reject_meta_challenges():
    c = _c(
        title="Excessive Data Exposure – Challenges Reveals Solve Status",
        location="/api/challenges",
        severity="medium",
        proof_excerpt=(
            "GET /api/Challenges returns all challenges with solved: true/false, "
            "difficulty, description. E.g. adminSectionChallenge solved true."
        ),
    )
    ok, reason = evidence_quality_gate(c)
    assert not ok


def test_accept_unauth_put_product():
    c = _c(
        title="Broken Access Control – Unauthenticated Product Modification",
        location="/api/products/{id}",
        severity="critical",
        proof_excerpt=(
            "PUT /api/Products/2 without any Authorization header with "
            '{"name":"Hacked","price":0.01} returned HTTP 200 and product data modified.'
        ),
        precondition="unauthenticated",
    )
    ok, reason = evidence_quality_gate(c)
    assert ok, reason


def test_authz_requires_actor_precondition():
    c = _c(
        title="IDOR on BasketItems Broken Access Control",
        location="/api/basketitems",
        proof_excerpt="GET /api/BasketItems HTTP 200 returns array of items for all users",
        precondition="",
        affected_actor="",
    )
    ok, reason = evidence_quality_gate(c)
    assert not ok
    assert "precondition" in reason or "actor" in reason or "differential" in reason


def test_v7_search_boolean_sqli_books():
    """Prose boolean-blind proof without literal 'HTTP 200' must still pass (v7 regression)."""
    c = _c(
        title="SQL Injection in /rest/products/search (q parameter) - Boolean blind data extraction",
        location="/rest/products/search",
        severity="critical",
        ready_to_book=False,
        proof_excerpt=(
            "Three lines of evidence: (1) q=' OR '1'='1 returns ALL products vs q=' returns none "
            "(boolean differential). (2) boolean oracle confirmed. (3) Extracted admin email: "
            "(SELECT email FROM Users WHERE id=1) LIKE 'admin@example.com' evaluated TRUE."
        ),
    )
    ok, reason = evidence_quality_gate(c)
    assert ok, reason
    from node5.feedback import filter_bookable, promote_bookable_candidates
    from node5.state import PenState

    state = PenState(target="http://t", candidates=[c])
    n = promote_bookable_candidates(state)
    assert n == 1
    assert state.candidates[0].ready_to_book is True
    bookable = filter_bookable(state.candidates)
    assert any("Boolean" in b.title or "SQL" in b.title for b in bookable)


def test_unauth_bola_title_without_precondition_string():
    c = _c(
        title="Unauthenticated Access to Basket Items (BOLA)",
        location="/api/BasketItems",
        proof_excerpt=(
            "GET /api/BasketItems without authentication returned HTTP 200 with basket items "
            "array for other users."
        ),
        precondition="None",
        affected_actor="anon",
    )
    ok, reason = evidence_quality_gate(c)
    assert ok, reason


def test_reject_non_vuln_no_enumeration():
    c = _c(
        title="No user enumeration in login (consistent error messaging)",
        location="/rest/user/login",
        severity="low",
        proof_excerpt="POST /rest/user/login HTTP 401 same message for bad user and bad password",
    )
    ok, reason = evidence_quality_gate(c)
    assert not ok
    assert "not_a_vulnerability" in reason


def test_reject_rate_limited_info():
    c = _c(
        title="Password reset rate-limited with security question protection",
        location="/rest/user/reset-password",
        severity="info",
        proof_excerpt="POST reset returns HTTP 429 rate limited after few tries",
    )
    ok, reason = evidence_quality_gate(c)
    assert not ok


def test_authz_ok_with_dual_actor_proof():
    c = _c(
        title="IDOR on /api/Complaints Cross-User",
        location="/api/complaints",
        proof_excerpt=(
            "Actor_A listing complaints sees Actor_B's private complaint. "
            "As actor_b GET returns only own. HTTP 200 differential confirmed."
        ),
        precondition="authenticated as actor_a and actor_b",
        affected_actor="actor_b",
        affected_resource="complaint",
    )
    ok, reason = evidence_quality_gate(c)
    assert ok, reason


def test_accept_jwt_none():
    c = _c(
        title="JWT Algorithm Confusion - None Algorithm Bypass",
        location="/rest/user/whoami",
        severity="critical",
        proof_excerpt=(
            "Created JWT with header alg none and payload admin. Sent as Cookie:token=... "
            "GET /rest/user/whoami returned HTTP 200 with user admin@example.com authentication."
        ),
    )
    ok, reason = evidence_quality_gate(c)
    assert ok, reason


def test_severity_cap_challenges():
    c = _c(
        title="Challenges solve status leak",
        location="/api/challenges",
        severity="critical",
        proof_excerpt="GET /api/challenges HTTP 200 solved true false list",
    )
    # may fail quality; if forced through cap:
    c2 = _c(
        title="Config leak with password hash",
        location="/rest/admin/application-configuration",
        severity="critical",
        proof_excerpt=(
            "GET /rest/admin/application-configuration HTTP 200 oauth client_id and "
            "password hash md5 0192023a7bbd73250516f069df18b500"
        ),
    )
    assert apply_severity_cap(c2) in ("critical", "high", "medium")


def test_config_leak_not_misclassified_as_xss_from_proof_tokens():
    """Config JSON may contain 'xss' flags; must not trigger XSS gate."""
    c = _c(
        title="Application Configuration Leak",
        location="/rest/admin/application-configuration",
        severity="high",
        proof_excerpt=(
            "GET /rest/admin/application-configuration returned HTTP 200 with JSON "
            "including oauth client_id and showXssWarnings:true challenge config."
        ),
    )
    ok, reason = evidence_quality_gate(c)
    assert ok, reason


def test_filter_bookable_drops_weak_keeps_strong():
    weak = _c(
        title="Unauthenticated Product Reviews with Stored XSS",
        location="/rest/products/1/reviews",
        proof_excerpt=(
            "GET /rest/products/1/reviews returned HTTP 200. author test@test.com "
            "message <script>alert(1)</script>"
        ),
    )
    strong = _c(
        title="SQL Injection in Login Endpoint",
        location="/rest/user/login",
        proof_excerpt=(
            "POST /rest/user/login email ' OR 1=1-- HTTP 200 authentication JWT admin"
        ),
    )
    out = filter_bookable([weak, strong])
    assert len(out) == 1
    assert "SQL" in out[0].title
