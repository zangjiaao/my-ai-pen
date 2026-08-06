"""Spec #284: Composer Graph + Expert harness bind (fail-closed) — pure envelope tests.

Product SOT: resolve_work_envelope + apply_work_envelope_to_task_assign.
Keeps test_participant_session.py under the file-size bar (#277/#282 only there).
"""
from __future__ import annotations

import pytest

from app.services.participant_session import (
    apply_work_envelope_to_task_assign,
    composer_template_from_message,
    merge_session_into_context,
    resolve_work_envelope,
    session_record_from_context,
)


# --- G1 ---


@pytest.mark.parametrize("tmpl", ["app_assessment", "redteam_deep"])
def test_g1_composer_product_graph_keeps_template_on_assign(tmpl: str):
    """G1: composer product Graph → envelope graph + applied task_assign keeps template."""
    env = resolve_work_envelope(
        expert_id="exp-pen",
        session_work_mode="free",
        composer_template=tmpl,
        case_sticky_template=None,
        conversation_status=None,
    )
    assert env["work_mode"] == "graph"
    assert env["graph_id"] == tmpl
    assert env["engagement_template"] == tmpl
    assert env["graph_execution"] == "run"
    assert env["wire_graph_execution"] is None

    out = apply_work_envelope_to_task_assign(
        {"type": "task_assign", "engagement": "pentest"},
        env,
    )
    assert out["engagement_template"] == tmpl
    assert "graph_execution" not in out or out.get("graph_execution") is None


# --- G4 matrix: this-turn enter → Hard (not C1) ---


@pytest.mark.parametrize(
    "composer,session_mode,session_gid,status,permission,expect_exec,expect_wire",
    [
        # Field e4876015: completed + composer Graph → full_restart
        (
            "app_assessment",
            "free",
            None,
            "completed",
            None,
            "full_restart",
            "full",
        ),
        (
            "redteam_deep",
            "free",
            None,
            "completed",
            None,
            "full_restart",
            "full",
        ),
        # Reselect same Graph after complete
        (
            "app_assessment",
            "graph",
            "app_assessment",
            "completed",
            None,
            "full_restart",
            "full",
        ),
        # enter_graph permission on completed
        (
            None,
            "free",
            None,
            "completed",
            {"action": "enter_graph", "graph_id": "app_assessment"},
            "full_restart",
            "full",
        ),
        # Incomplete + this-turn Graph → run (not resume, not C1)
        (
            "app_assessment",
            "graph",
            "app_assessment",
            "incomplete",
            None,
            "run",
            None,
        ),
        (
            "app_assessment",
            "graph",
            "app_assessment",
            "canceled",
            None,
            "run",
            None,
        ),
        (
            "app_assessment",
            "graph",
            "app_assessment",
            "interrupted",
            None,
            "run",
            None,
        ),
        # enter_graph on incomplete
        (
            None,
            "graph",
            "app_assessment",
            "incomplete",
            {"action": "enter_graph", "graph_id": "app_assessment"},
            "run",
            None,
        ),
    ],
)
def test_g4_this_turn_enter_is_hard_not_c1(
    composer,
    session_mode,
    session_gid,
    status,
    permission,
    expect_exec,
    expect_wire,
):
    """G4: this-turn product Graph / enter card → Hard; wire never continue."""
    env = resolve_work_envelope(
        expert_id="exp-pen",
        session_work_mode=session_mode,
        session_graph_id=session_gid,
        composer_template=composer,
        case_sticky_template="app_assessment",
        conversation_status=status,
        permission_decision=permission,
        same_mode_continue=True,
    )
    assert env["work_mode"] == "graph"
    assert env["engagement_template"]
    assert env["graph_execution"] == expect_exec
    assert env["wire_graph_execution"] == expect_wire
    assert env["wire_graph_execution"] != "continue"

    out = apply_work_envelope_to_task_assign(
        {
            "type": "task_assign",
            "engagement": "pentest",
            "engagement_template": "app_assessment",
        },
        env,
    )
    assert out.get("engagement_template") == env["engagement_template"]
    assert out.get("graph_execution") != "continue"
    if expect_wire:
        assert out.get("graph_execution") == expect_wire
    else:
        assert "graph_execution" not in out or out.get("graph_execution") is None


def test_g4_field_e4876015_completed_composer_full_not_continue():
    """Narrative field regression: completed Case + composer app_assessment → full."""
    env = resolve_work_envelope(
        expert_id="exp-pen",
        session_work_mode="free",
        composer_template="app_assessment",
        case_sticky_template="app_assessment",
        conversation_status="completed",
    )
    out = apply_work_envelope_to_task_assign(
        {"type": "task_assign", "engagement": "pentest", "engagement_template": "app_assessment"},
        env,
    )
    assert env["work_mode"] == "graph"
    assert out["engagement_template"] == "app_assessment"
    assert out["graph_execution"] == "full"
    assert out["graph_execution"] != "continue"


def test_g4_envelope_merges_session_private_with_expert_id():
    """G4 Session write contract: envelope graph + expert_id → sessions[eid]."""
    env = resolve_work_envelope(
        expert_id="exp-pen",
        session_work_mode="free",
        composer_template="app_assessment",
        conversation_status="completed",
    )
    assert env["work_mode"] == "graph"
    ctx = merge_session_into_context(
        {},
        expert_id="exp-pen",
        work_mode=env["work_mode"],
        graph_id=env["graph_id"],
    )
    row = session_record_from_context(ctx, "exp-pen")
    assert row["work_mode"] == "graph"
    assert row["graph_id"] == "app_assessment"
    ctx2 = merge_session_into_context(
        {},
        expert_id=None,
        work_mode="graph",
        graph_id="app_assessment",
    )
    assert session_record_from_context(ctx2, "exp-pen") == {}


def test_composer_template_from_message_absent_vs_present():
    """Composer field only when key present on msg (absent ≠ sticky inject)."""
    assert composer_template_from_message({}) is None
    assert composer_template_from_message({"text": "hi"}) is None
    assert composer_template_from_message({"engagement_template": "app_assessment"}) == (
        "app_assessment"
    )
    assert composer_template_from_message({"engagementTemplate": "redteam_deep"}) == (
        "redteam_deep"
    )
    assert composer_template_from_message({"engagement_template": ""}) == ""
    assert composer_template_from_message(None) is None


def test_g4_dispatch_composition_completed_graph_full_not_c1():
    """Offline G4 chain: msg composer → envelope → applied task_assign (Node payload)."""
    msg = {
        "type": "user_message",
        "text": "continue assessment",
        "engagement_template": "app_assessment",
        "expert_id": "exp-pen",
    }
    task = {
        "type": "task_assign",
        "engagement": "pentest",
        "engagement_template": "app_assessment",
        "expert_id": "exp-pen",
    }
    composer = composer_template_from_message(msg)
    env = resolve_work_envelope(
        expert_id="exp-pen",
        session_work_mode="free",
        composer_template=composer,
        case_sticky_template="app_assessment",
        conversation_status="completed",
    )
    out = apply_work_envelope_to_task_assign(task, env)
    assert env["work_mode"] == "graph"
    assert out["engagement_template"] == "app_assessment"
    assert out["graph_execution"] == "full"
    assert out["graph_execution"] != "continue"


# --- G7 / A1 ---


@pytest.mark.parametrize(
    "composer",
    [None, "", "free", "不指定", "unspecified", "none"],
)
def test_g7_unspecified_composer_does_not_force_graph_from_case_sticky(composer):
    """G7 / A1: free/不指定 never promotes Free→Graph from Case sticky alone."""
    env = resolve_work_envelope(
        expert_id="exp-pen",
        session_work_mode="free",
        session_graph_id=None,
        composer_template=composer,
        case_sticky_template="app_assessment",
        conversation_status="completed",
    )
    assert env["work_mode"] == "free"
    assert env["graph_id"] is None
    assert env["engagement_template"] is None
    out = apply_work_envelope_to_task_assign(
        {
            "type": "task_assign",
            "engagement": "pentest",
            "engagement_template": "app_assessment",
        },
        env,
    )
    assert "engagement_template" not in out
    assert "graph_execution" not in out
