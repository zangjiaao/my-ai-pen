"""Process quality contracts (structure / discovery yield / surface salvage / package force).

Graph constrains process — not target vuln answer keys.
"""

from __future__ import annotations

from pathlib import Path

from node5.feedback import (
    evaluate_stage,
    process_quality_metrics,
    surface_ledger_ok,
    surface_needs_salvage,
)
from node5.packages import needed_high_value_skills, packages_from_surfaces
from node5.state import Candidate, PenState, Surface
from node5.surface_salvage import extract_paths_from_text, salvage_surfaces


def _pack_root() -> Path:
    here = Path(__file__).resolve()
    pack = here.parents[1].parent / "experts" / "pentest"
    assert pack.is_dir(), pack
    return pack


def test_auth_session_structure_fail_should_retry():
    state = PenState(target="http://t", dry_run=False, surfaces=[Surface(path="/api/Users")] * 6)
    # pad surfaces
    state.surfaces = [
        Surface(path=p)
        for p in (
            "/api/Users",
            "/rest/user/login",
            "/rest/products/search",
            "/api/Products",
            "/api/Feedbacks",
            "/rest/basket",
        )
    ]
    fb = evaluate_stage(
        state,
        "auth_session",
        payload=None,  # structure fail
        tool_calls=20,
        new_candidates=0,
    )
    assert not fb.structure_ok
    assert fb.should_retry
    assert any(f.loop == "structure" and not f.ok for f in state.feedback)


def test_prior_reverify_empty_ready_after_tools_should_retry():
    state = PenState(
        target="http://t",
        dry_run=False,
        surfaces=[
            Surface(path=p)
            for p in (
                "/api/Users",
                "/rest/user/login",
                "/rest/products/search",
                "/api/Products",
                "/api/Feedbacks",
                "/rest/basket",
            )
        ],
    )
    fb = evaluate_stage(
        state,
        "prior_reverify",
        payload={"summary": "looked around", "candidates": []},
        tool_calls=40,
        new_candidates=0,
    )
    assert fb.structure_ok
    assert fb.should_retry
    assert "discovery_empty_ready" in " ".join(fb.details)
    assert any(f.loop == "discovery_yield" and not f.ok for f in state.feedback)


def test_prior_reverify_with_ready_candidate_no_discovery_retry():
    state = PenState(
        target="http://t",
        dry_run=False,
        surfaces=[
            Surface(path=p)
            for p in (
                "/api/Users",
                "/rest/user/login",
                "/rest/products/search",
                "/api/Products",
                "/api/Feedbacks",
                "/rest/basket",
            )
        ],
        candidates=[
            Candidate(
                title="Login SQL injection auth bypass",
                location="/rest/user/login",
                stage="prior_reverify",
                ready_to_book=True,
                severity="critical",
                proof_excerpt=(
                    "POST /rest/user/login email=' OR 1=1-- HTTP 200 authentication "
                    "bypass JWT returned for admin"
                ),
            )
        ],
    )
    fb = evaluate_stage(
        state,
        "prior_reverify",
        payload={"candidates": []},
        tool_calls=40,
        new_candidates=1,
    )
    assert not fb.should_retry or "discovery_empty_ready" not in " ".join(fb.details)
    assert any(f.loop == "discovery_yield" and f.ok for f in state.feedback)


def test_class_probe_low_yield_soft_fail_and_retry():
    surfaces = [Surface(path=f"/api/r{i}") for i in range(10)]
    surfaces += [
        Surface(path="/rest/products/search"),
        Surface(path="/api/Users"),
    ]
    state = PenState(target="http://t", dry_run=False, surfaces=surfaces)
    fb = evaluate_stage(
        state,
        "class_probe",
        payload={"_fan_out": True},
        tool_calls=100,
        new_candidates=0,
        fan_out=True,
        structured_workers=5,
    )
    assert fb.should_retry
    assert any("discovery_low_yield" in d for d in fb.details)
    assert any(f.loop == "discovery_yield" and not f.ok for f in state.feedback)


def test_feedback_path_forces_xss_package():
    state = PenState(
        target="http://127.0.0.1:3000",
        pack_root=str(_pack_root()),
        max_workers=4,
        surfaces=[
            Surface(path="/", note="spa"),
            Surface(path="/rest/user/login"),
            Surface(path="/rest/products/search", note="q"),
            Surface(path="/api/Users"),
            Surface(path="/api/Products"),
            Surface(path="/api/Feedbacks", note="ugc feedback list"),
            Surface(path="/profile/image/url"),
            Surface(path="/encryptionkeys"),
            Surface(path="/support/logs"),
        ],
    )
    assert "pentest-xss" in needed_high_value_skills(state)
    pkgs = packages_from_surfaces(state, max_workers=4, pack_root=_pack_root())
    skills = [p["skill_id"] for p in pkgs]
    assert "pentest-xss" in skills, skills
    assert "pentest-xss" in (state.forced_packages or [])


def test_surface_api_without_auth_fails_ledger():
    state = PenState(
        target="http://t",
        dry_run=False,
        surfaces=[
            Surface(path="/api/Products"),
            Surface(path="/api/Items"),
            Surface(path="/api/Catalog"),
            Surface(path="/rest/widgets"),
            Surface(path="/api/v1/things"),
            Surface(path="/api/health"),
        ],
    )
    ok, det = surface_ledger_ok(state)
    assert not ok
    assert "auth" in det or "user" in det


def test_surface_needs_salvage_when_api_object_sparse():
    state = PenState(
        target="http://t",
        dry_run=False,
        surfaces=[
            Surface(path="/api/a"),
            Surface(path="/api/b"),
            Surface(path="/rest/c"),
            Surface(path="/api/d"),
            Surface(path="/rest/user/login"),  # auth present → ledger may pass
            Surface(path="/api/e"),
        ],
    )
    # ledger might pass (auth present, appish>=5) but object_ish thin
    need, det = surface_needs_salvage(state)
    assert need, det


def test_salvage_extracts_api_rest_paths_from_prose():
    raw = (
        "Discovered endpoints: /api/Users list, /rest/user/register, "
        "/api/Feedbacks, /b2b/v2/orders and /profile/image/url"
    )
    paths = extract_paths_from_text(raw, "http://127.0.0.1:3000")
    joined = " ".join(paths).lower()
    assert "/api/users" in joined or any("users" in p.lower() for p in paths)
    assert any("register" in p.lower() for p in paths)
    assert any("feedbacks" in p.lower() for p in paths)

    state = PenState(target="http://127.0.0.1:3000", surfaces=[])
    n = salvage_surfaces(state, raw=raw, source="test")
    assert n >= 3
    assert len(state.surfaces) >= 3


def test_process_quality_metrics_counts_soft_fails():
    state = PenState(target="http://t", dry_run=False)
    state.feedback_log("structure", "auth_session", False, "no parseable JSON")
    state.feedback_log("discovery_yield", "prior_reverify", False, "ready=0 tools=40")
    state.feedback_log("discovery_yield", "class_probe", True, "new_cands=4")
    state.feedback_log("evidence", "prior_reverify", True, "ready=0")
    m = process_quality_metrics(state)
    assert m["structure_fail_n"] == 1
    assert m["discovery_yield_soft_fail_n"] == 1
    assert "prior_reverify" in m["discovery_yield_soft_fail_stages"]
    assert m["ready_by_stage"].get("prior_reverify") == 0
