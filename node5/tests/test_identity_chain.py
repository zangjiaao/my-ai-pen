"""identity_chain trigger + catalog checkpoints."""

from __future__ import annotations

from pathlib import Path

from node5.agent_graph import identity_chain_should_run
from node5.feedback import evidence_quality_gate
from node5.knowledge import read_ref
from node5.state import Candidate, PenState, Surface


def _pack() -> Path:
    return Path(__file__).resolve().parents[1].parent / "experts" / "pentest"


def test_identity_chain_triggers_on_2fa_surface():
    state = PenState(
        target="http://t",
        surfaces=[
            Surface(path="/rest/2fa/status"),
            Surface(path="/rest/user/login"),
        ],
        candidates=[
            Candidate(
                title="SQL Injection Authentication Bypass on Login",
                location="/rest/user/login",
                proof_excerpt="POST login HTTP 200 JWT admin",
                ready_to_book=True,
            )
        ],
    )
    run, cat, reason = identity_chain_should_run(state)
    assert run
    assert cat == "totp-2fa"
    assert reason


def test_identity_chain_skip_without_signal():
    state = PenState(
        target="http://t",
        surfaces=[Surface(path="/api/Products")],
    )
    run, cat, reason = identity_chain_should_run(state)
    assert not run
    assert reason == "no_signal"


def test_identity_chain_max_two_passes():
    state = PenState(
        target="http://t",
        surfaces=[Surface(path="/rest/2fa/setup")],
    )
    state._identity_chain_passes = 2  # type: ignore[attr-defined]
    run, _, reason = identity_chain_should_run(state)
    assert not run
    assert reason == "max_passes"


def test_identity_chain_needs_continue_s1():
    from node5.agent_graph import identity_chain_needs_continue

    state = PenState(target="http://t")
    state.notes.append("identity_chain: catalog totp-2fa chain_stop=S1 secret exposure")
    state.candidates.append(
        Candidate(
            title="TOTP Secret Exposure via /rest/2fa/status (chain_stop=S1)",
            location="/rest/2fa/status",
            proof_excerpt="GET status totpSecret=ABCDEF HTTP 200",
        )
    )
    assert identity_chain_needs_continue(state, "totp-2fa")


def test_identity_chain_needs_continue_setup_401_without_chain_stop_wording():
    """v16 gap: agent never wrote chain_stop=S1 but hit setup 401 / secret path."""
    from node5.agent_graph import identity_chain_needs_continue

    state = PenState(target="http://t")
    state.candidates.append(
        Candidate(
            title="TOTP Secret Exposure on /rest/2fa/status",
            location="/rest/2fa/status",
            proof_excerpt="totpSecret present; POST /rest/2fa/setup returns 401",
        )
    )
    assert identity_chain_needs_continue(state, "totp-2fa", pass0_tools=5)


def test_identity_chain_force_continue_on_budget_without_s3():
    from node5.agent_graph import identity_chain_needs_continue

    state = PenState(target="http://t")
    state.notes.append("identity_chain: pass=0 tools=34 new_cands=0 catalog=totp-2fa")
    # no half-step keywords — force by tools
    assert identity_chain_needs_continue(state, "totp-2fa", pass0_tools=34)


def test_identity_chain_no_continue_when_s3_done():
    from node5.agent_graph import identity_chain_needs_continue

    state = PenState(target="http://t")
    state.notes.append("identity_chain: 2FA bypass chain_stop=S3 verify success")
    state.candidates.append(
        Candidate(
            title="2FA Bypass complete",
            location="/rest/2fa/verify",
            proof_excerpt="login after 2fa whoami HTTP 200",
        )
    )
    assert not identity_chain_needs_continue(state, "totp-2fa", pass0_tools=40)


def test_annotate_identity_half_step_writes_chain_stop():
    from node5.agent_graph import annotate_identity_half_step

    state = PenState(target="http://t")
    state.candidates.append(
        Candidate(
            title="TOTP Secret Exposure",
            location="/rest/2fa/status",
            proof_excerpt="totpSecret=X",
        )
    )
    annotate_identity_half_step(state, "totp-2fa", 0, 34)
    assert any("chain_stop" in n.lower() for n in state.notes)


def test_ato_incomplete_gate():
    c = Candidate(
        title="Account Takeover via Password Reset",
        location="/rest/user/reset-password",
        proof_excerpt="POST reset-password HTTP 200 answer accepted",
        ready_to_book=True,
        impact="full account access",
        causality="reset",
        reproducibility="replay",
    )
    ok, reason = evidence_quality_gate(c)
    assert not ok
    assert "ato_incomplete" in reason


def test_2fa_bypass_incomplete_gate():
    c = Candidate(
        title="2FA Bypass via TOTP Setup",
        location="/rest/2fa/setup",
        proof_excerpt="POST /rest/2fa/setup HTTP 401 unauthorized",
        ready_to_book=True,
        impact="bypass 2fa",
        causality="setup",
        reproducibility="replay",
    )
    ok, reason = evidence_quality_gate(c)
    assert not ok
    assert "2fa_bypass_incomplete" in reason


def test_2fa_secret_exposure_not_blocked_as_bypass():
    c = Candidate(
        title="TOTP Secret Exposure via /rest/2fa/status",
        location="/rest/2fa/status",
        proof_excerpt="GET /rest/2fa/status HTTP 200 totpSecret=ABCDEF browser not used",
        ready_to_book=True,
        impact="secret leak",
        causality="authz",
        reproducibility="replay",
    )
    ok, reason = evidence_quality_gate(c)
    # may fail other gates but not 2fa_bypass_incomplete
    if not ok:
        assert "2fa_bypass_incomplete" not in reason


def test_chain_cards_have_checkpoints():
    for name in ("password-reset-ato", "totp-2fa", "xss-dom-client"):
        body = read_ref(_pack(), f"vulns/{name}.md", max_chars=4000)
        assert "Checkpoints" in body or "checkpoint" in body.lower()
        assert "S0" in body or "S1" in body
