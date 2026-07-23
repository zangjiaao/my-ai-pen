"""Report merge, prior book cap, and path partition contracts."""

from __future__ import annotations

from pathlib import Path

from node5.feedback import filter_bookable, prior_reverify_bookable
from node5.identity import merge_report_candidates, report_merge_key
from node5.packages import packages_from_surfaces
from node5.state import Candidate, PenState, Surface


def _c(**kw) -> Candidate:
    base = dict(
        title="t",
        location="/x",
        severity="high",
        proof_excerpt="POST /x HTTP 200 authentication bypass role=admin",
        causality="c",
        reproducibility="r",
        impact="i",
        stage="class_probe",
        ready_to_book=True,
    )
    base.update(kw)
    return Candidate.model_validate(base)


def test_report_merge_jwt_and_users_bola():
    a = _c(
        title="JWT Algorithm Confusion — None Algorithm Accepted",
        location="/api/users",
        proof_excerpt="GET /api/Users with alg none JWT HTTP 200 authentication forged",
    )
    b = _c(
        title="JWT Algorithm Confusion (alg:none) – Authentication Bypass",
        location="/cookie",
        proof_excerpt="Forged token alg none accepted GET /rest/user/whoami HTTP 200",
    )
    c = _c(
        title="Full User Data Exposure via GET /api/Users",
        location="/api/users",
        proof_excerpt="GET /api/Users with customer token HTTP 200 all users email role",
    )
    d = _c(
        title="Excessive Data Exposure on /api/Users (All Users List)",
        location="/api/Users",
        proof_excerpt="GET /api/Users returns all users as customer HTTP 200",
    )
    e = _c(
        title="Mass Assignment – Privilege Escalation via User Registration",
        location="/api/users",
        proof_excerpt='POST /api/Users role=admin HTTP 201 created admin authentication',
    )
    merged, n = merge_report_candidates([a, b, c, d, e], target="http://t")
    keys = {report_merge_key(title=x.title, location=x.location) for x in merged}
    assert ("*", "jwt") in keys
    assert any(k[1] == "mass_assignment" for k in keys)
    assert any(k[1] == "authz_bola" for k in keys)
    # jwt once, bola once for users, mass once
    assert n >= 2
    assert len(merged) <= 3


def test_product_put_merge():
    a = _c(
        title="Product Tampering - Unauthorized Price Modification via PUT",
        location="/api/products/1",
        proof_excerpt="PUT /api/Products/1 without auth HTTP 200 price 0.01",
    )
    b = _c(
        title="Unauthenticated Product Price Manipulation (BOLA/BFLA)",
        location="/api/products/{id}",
        proof_excerpt="PUT /api/Products/2 without authentication HTTP 200 modified",
    )
    merged, n = merge_report_candidates([a, b], target="http://t")
    assert len(merged) == 1
    assert n == 1


def test_prior_defers_list_exposure():
    c = _c(
        title="Full User Data Exposure via GET /api/Users",
        location="/api/users",
        stage="prior_reverify",
        proof_excerpt="GET /api/Users with admin JWT returns HTTP 200 with all user records",
    )
    ok, reason = prior_reverify_bookable(c)
    assert not ok
    assert "prior_defer" in reason


def test_prior_allows_sqli():
    c = _c(
        title="SQL Injection Authentication Bypass at /rest/user/login",
        location="/rest/user/login",
        stage="prior_reverify",
        proof_excerpt="POST /rest/user/login email ' OR 1=1-- HTTP 200 authentication JWT admin",
    )
    ok, _ = prior_reverify_bookable(c)
    assert ok


def test_filter_bookable_caps_prior():
    priors = []
    for i in range(6):
        priors.append(
            _c(
                title=f"SQL Injection Authentication Bypass variant {i}",
                location=f"/rest/user/login{i}",
                stage="prior_reverify",
                proof_excerpt=f"POST /rest/user/login{i} ' OR 1=1-- HTTP 200 authentication JWT admin {i}",
            )
        )
    # same report key for login sqli variants with different paths - may merge
    out = filter_bookable(priors)
    assert len(out) <= 4


def test_path_partition_reduces_login_overlap():
    pack = Path(__file__).resolve().parents[1].parent / "experts" / "pentest"
    state = PenState(
        target="http://127.0.0.1:3000",
        pack_root=str(pack),
        max_workers=4,
        surfaces=[
            Surface(path="/rest/user/login"),
            Surface(path="/rest/user/register"),
            Surface(path="/api/Users"),
            Surface(path="/api/BasketItems"),
            Surface(path="/api/Products"),
            Surface(path="/ftp/"),
            Surface(path="/rest/products/search"),
            Surface(path="/rest/products/1/reviews"),
        ],
    )
    pkgs = packages_from_surfaces(state, max_workers=4, pack_root=pack)
    # login should not appear in every package's exclusive paths
    login_owners = [
        p["skill_id"]
        for p in pkgs
        if any("login" in (x or "").lower() for x in (p.get("paths") or []))
    ]
    assert len(login_owners) <= 1, login_owners
