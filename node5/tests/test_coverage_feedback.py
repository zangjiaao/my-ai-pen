"""Coverage is Feedback-owned — no Campaign state machine."""

from __future__ import annotations

from node5.coverage import (
    compute_coverage_metrics,
    coverage_hints,
    coverage_outcome,
    record_coverage,
    required_coverage,
    untested_required,
)
from node5.feedback import evaluate_stage
from node5.state import Candidate, PenState, Surface


def test_required_ssrf_and_injection_from_surfaces():
    state = PenState(
        target="http://t",
        surfaces=[
            Surface(path="/profile/image/url"),
            Surface(path="/rest/products/search"),
            Surface(path="/graphql"),
        ],
    )
    ids = {r.id for r in required_coverage(state)}
    assert "ssrf_url_sink" in ids
    assert "injection_search" in ids
    assert "graphql" in ids
    assert all(coverage_outcome(state, i) == "untested" for i in ids)


def test_untested_fails_coverage_probe_feedback():
    state = PenState(
        target="http://t",
        surfaces=[Surface(path="/profile/image/url")],
        dry_run=False,
    )
    fb = evaluate_stage(
        state,
        "coverage_probe",
        payload={"_coverage_probes": {"attempted": []}},
        tool_calls=1,
        new_candidates=0,
    )
    assert not fb.coverage_ok or fb.should_retry or any(
        f.loop == "coverage" and not f.ok for f in state.feedback
    )
    assert "ssrf_url_sink" in untested_required(state)


def test_attempt_rate_does_not_ignore_untested():
    state = PenState(
        target="http://t",
        surfaces=[
            Surface(path="/profile/image/url"),
            Surface(path="/rest/products/search"),
        ],
    )
    record_coverage(state, "ssrf_url_sink", outcome="failed", detail="tried")
    m = compute_coverage_metrics(state)
    assert "ssrf_url_sink" in m["coverage_attempted"]
    assert "injection_search" in m["coverage_untested"]
    assert m["coverage_attempt_rate"] < 1.0
    # no silent skip success: untested remains in required
    assert m["coverage_required_n"] >= 2


def test_closed_when_quality_candidate():
    state = PenState(
        target="http://t",
        surfaces=[Surface(path="/profile/image/url")],
        candidates=[
            Candidate(
                title="SSRF via URL-fetch parameter (server-side request)",
                location="/profile/image/url",
                proof_excerpt=(
                    "POST urlencoded imageUrl=http://127.0.0.1:3000/ "
                    "profileImage_changed server-side fetch HTTP 302"
                ),
                causality="c",
                reproducibility="r",
                impact="i",
                stage="coverage_probe",
            )
        ],
    )
    record_coverage(state, "ssrf_url_sink", outcome="attempted", detail="probe")
    assert coverage_outcome(state, "ssrf_url_sink") == "closed"


def test_coverage_hints_list_gaps():
    state = PenState(
        target="http://t",
        surfaces=[Surface(path="/graphql"), Surface(path="/rest/products/search")],
    )
    text = coverage_hints(state)
    assert "COVERAGE GAP" in text
    assert "graphql" in text or "injection" in text


def test_budget_block_not_untested():
    """Scheduled-but-unrun items must be blocked, not left untested forever."""
    state = PenState(
        target="http://t",
        surfaces=[
            Surface(path="/profile/image/url"),
            Surface(path="/graphql"),
            Surface(path="/rest/products/search"),
        ],
    )
    record_coverage(state, "injection_search", outcome="blocked", detail="http_budget")
    assert coverage_outcome(state, "injection_search") == "blocked"
    m = compute_coverage_metrics(state)
    assert "injection_search" in m["coverage_blocked"]
    assert "injection_search" not in m["coverage_untested"]
    # blocked counts toward scheduled (attempted list includes blocked)
    assert "injection_search" in m["coverage_attempted"]


def test_dom_and_business_required():
    state = PenState(
        target="http://t",
        surfaces=[
            Surface(path="/api/BasketItems"),
            Surface(path="/rest/products/1/reviews"),
            Surface(path="/socket.io/"),
        ],
    )
    ids = {r.id for r in required_coverage(state)}
    assert "business_logic" in ids
    assert "dom_client" in ids
    assert "websocket" in ids
