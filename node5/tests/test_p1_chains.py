"""P1: injection depth, SSRF evidence, package scores for egress/search."""

from __future__ import annotations

from pathlib import Path

from node5.feedback import (
    evidence_quality_gate,
    has_search_injection_surface,
    injection_data_effect_ok,
)
from node5.packages import packages_from_surfaces
from node5.state import Candidate, PenState, Surface
from node5.surface_model import salvage_model_from_surfaces


def _c(**kw) -> Candidate:
    base = dict(
        title="t",
        location="/x",
        severity="high",
        proof_excerpt="POST /x HTTP 200",
        causality="c",
        reproducibility="r",
        impact="i",
        stage="class_probe",
        ready_to_book=True,
    )
    base.update(kw)
    return Candidate.model_validate(base)


def test_injection_data_effect_markers():
    assert injection_data_effect_ok("UNION SELECT email,password FROM users")
    assert not injection_data_effect_ok("HTTP 500 SQLITE_ERROR incomplete input")


def test_search_sqli_error_only_rejected():
    c = _c(
        title="SQL Injection in Product Search",
        location="/rest/products/search",
        proof_excerpt="GET /rest/products/search?q=' HTTP 500 SQLITE_ERROR incomplete input",
    )
    ok, reason = evidence_quality_gate(c)
    assert not ok
    assert "sqli" in reason or "error" in reason or "data" in reason


def test_search_sqli_with_data_effect_ok():
    c = _c(
        title="SQL Injection in Product Search dumps users",
        location="/rest/products/search",
        proof_excerpt=(
            "GET search q=test')) UNION SELECT email,password,3,4,5,6,7,8 FROM Users-- "
            "HTTP 200 returns emails admin@x.com jim@y.com and password hashes extracted"
        ),
    )
    ok, reason = evidence_quality_gate(c)
    assert ok, reason


def test_login_sqli_still_ok():
    c = _c(
        title="SQL Injection Authentication Bypass at login",
        location="/rest/user/login",
        proof_excerpt="POST /rest/user/login ' OR 1=1-- HTTP 200 authentication JWT admin@x.com",
    )
    ok, reason = evidence_quality_gate(c)
    assert ok, reason


def test_ssrf_requires_server_side_proof():
    c = _c(
        title="SSRF via profile image URL parameter",
        location="/profile/image/url",
        proof_excerpt="POST /profile/image/url with imageUrl=http://evil.com parameter accepted",
    )
    ok, reason = evidence_quality_gate(c)
    assert not ok
    assert "ssrf" in reason


def test_ssrf_with_server_fetch_ok():
    c = _c(
        title="SSRF via profile image URL",
        location="/profile/image/url",
        proof_excerpt=(
            "POST imageUrl=http://127.0.0.1:3000/ftp/ HTTP 200 server-side fetched "
            "directory listing content-type text/html internal path appeared in response"
        ),
        precondition="authenticated as actor_a",
    )
    ok, reason = evidence_quality_gate(c)
    assert ok, reason


def test_packages_prefer_ssrf_and_sql_on_proxy_surfaces():
    pack = Path(__file__).resolve().parents[1].parent / "experts" / "pentest"
    state = PenState(
        target="http://127.0.0.1:3000",
        pack_root=str(pack),
        max_workers=4,
        surfaces=[
            Surface(path="/rest/products/search", note="q param"),
            Surface(path="/profile/image/url", note="avatar url fetch"),
            Surface(path="/profile/image/file", note="multipart upload"),
            Surface(path="/rest/user/login", method="POST"),
            Surface(path="/api/Users", method="POST"),
            Surface(path="/api/BasketItems"),
        ],
    )
    pkgs = packages_from_surfaces(state, max_workers=4, pack_root=pack)
    skills = [p["skill_id"] for p in pkgs]
    assert "pentest-sql-injection" in skills or "pentest-ssrf" in skills, skills
    # ssrf should own image/url when present
    ssrf = next((p for p in pkgs if p["skill_id"] == "pentest-ssrf"), None)
    if ssrf:
        assert any("image" in x or "url" in x for x in (ssrf.get("paths") or []))


def test_has_search_surface():
    state = PenState(
        target="http://t",
        surfaces=[Surface(path="/rest/products/search")],
    )
    assert has_search_injection_surface(state)


def test_egress_tag_on_salvage():
    state = PenState(
        target="http://t",
        surfaces=[
            Surface(path="/profile/image/url", note="url fetch"),
            Surface(path="/api/Users"),
            Surface(path="/rest/user/login"),
            Surface(path="/api/Products"),
            Surface(path="/ftp/"),
            Surface(path="/rest/products/search"),
        ],
    )
    salvage_model_from_surfaces(state)
    notes = " ".join(r.notes for r in state.resources)
    assert "egress" in notes or any("image" in r.name or "profile" in r.name for r in state.resources)


def test_identity_ref_query():
    from node5.knowledge import query_refs

    pack = Path(__file__).resolve().parents[1].parent / "experts" / "pentest"
    hits = query_refs(pack, "password reset identity flows", kind="payloads", limit=5)
    assert hits
    assert any("identity" in h["path"] or "auth" in h["path"] for h in hits)
