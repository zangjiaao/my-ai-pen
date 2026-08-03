"""Unit tests for Participant Session work envelope resolver (Spec #277)."""
from app.services.participant_session import (
    apply_work_envelope_to_task_assign,
    is_free_composer_value,
    merge_session_into_context,
    resolve_work_envelope,
    session_record_from_context,
)


def test_is_free_composer_values():
    assert is_free_composer_value(None) is True
    assert is_free_composer_value("") is True
    assert is_free_composer_value("free") is True
    assert is_free_composer_value("none") is True
    assert is_free_composer_value("不指定") is True
    assert is_free_composer_value("unspecified") is True
    assert is_free_composer_value("app_assessment") is False
    assert is_free_composer_value("redteam_deep") is False


def test_empty_unspecified_template_is_free():
    """A3 / A2: empty or 不指定 → Free; do not pre-fill graph_id."""
    for composer in (None, "", "free", "none", "不指定", "unspecified"):
        env = resolve_work_envelope(
            expert_id="e1",
            composer_template=composer,
            case_sticky_template="app_assessment",
        )
        assert env["work_mode"] == "free", composer
        assert env["graph_id"] is None
        assert env["engagement_template"] is None


def test_explicit_app_assessment_this_turn_is_graph():
    """A2: explicit product graph id this turn → work_mode graph."""
    env = resolve_work_envelope(
        expert_id="e1",
        composer_template="app_assessment",
        session_work_mode="free",
        case_sticky_template=None,
    )
    assert env["work_mode"] == "graph"
    assert env["graph_id"] == "app_assessment"
    assert env["engagement_template"] == "app_assessment"
    assert env["graph_execution"] == "run"


def test_explicit_redteam_deep_this_turn_is_graph():
    env = resolve_work_envelope(composer_template="redteam_deep")
    assert env["work_mode"] == "graph"
    assert env["graph_id"] == "redteam_deep"


def test_free_session_continue_ignores_sticky_app_assessment():
    """A1/A9: Free fail + 继续 + Case sticky app_assessment → still Free."""
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="free",
        session_graph_id=None,
        composer_template="app_assessment",  # UI sticky / Case default noise
        case_sticky_template="app_assessment",
        conversation_status="failed",
        same_mode_continue=True,
    )
    assert env["work_mode"] == "free"
    assert env["graph_id"] is None
    assert env["engagement_template"] is None
    assert env["graph_execution"] is None


def test_free_session_continue_without_composer_stays_free():
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="free",
        composer_template=None,
        case_sticky_template="app_assessment",
        conversation_status="incomplete",
        same_mode_continue=True,
    )
    assert env["work_mode"] == "free"
    assert env["engagement_template"] is None


def test_case_sticky_alone_never_forces_graph():
    """First / unspecified turn: Case sticky must not invent Graph mode."""
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode=None,
        composer_template=None,
        case_sticky_template="app_assessment",
    )
    assert env["work_mode"] == "free"
    assert env["graph_id"] is None


def test_no_nlp_invent_from_free_text_fields_only():
    """A7: free-text instruction is not an input; mode from structured fields only."""
    # Resolver has no instruction parameter — only structured composer/session.
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="free",
        composer_template=None,
        case_sticky_template=None,
    )
    assert env["work_mode"] == "free"
    # Even if someone wrongly put NLP-looking junk as template, non-product → free
    env2 = resolve_work_envelope(
        composer_template="please continue penetration test and use hard graph",
    )
    assert env2["work_mode"] == "free"
    assert env2["graph_id"] is None


def test_graph_session_continue_stays_graph():
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="graph",
        session_graph_id="app_assessment",
        composer_template=None,
        conversation_status="failed",
        same_mode_continue=True,
    )
    assert env["work_mode"] == "graph"
    assert env["graph_id"] == "app_assessment"
    assert env["graph_execution"] == "continue_session"
    assert env["wire_graph_execution"] == "continue"


def test_graph_completed_c1_continue():
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="graph",
        session_graph_id="app_assessment",
        composer_template="app_assessment",
        conversation_status="completed",
    )
    assert env["work_mode"] == "graph"
    assert env["graph_execution"] == "continue_session"
    assert env["wire_graph_execution"] == "continue"


def test_explicit_full_restart():
    env = resolve_work_envelope(
        composer_template="app_assessment",
        conversation_status="completed",
        explicit_execution="full",
    )
    assert env["work_mode"] == "graph"
    assert env["graph_execution"] == "full_restart"
    assert env["wire_graph_execution"] == "full"


def test_session_record_round_trip():
    ctx = merge_session_into_context(
        {},
        expert_id="exp-1",
        work_mode="free",
    )
    row = session_record_from_context(ctx, "exp-1")
    assert row["work_mode"] == "free"
    assert row.get("graph_id") is None

    ctx = merge_session_into_context(
        ctx,
        expert_id="exp-1",
        work_mode="graph",
        graph_id="app_assessment",
    )
    row = session_record_from_context(ctx, "exp-1")
    assert row["work_mode"] == "graph"
    assert row["graph_id"] == "app_assessment"

    # Free clear graph_id
    ctx = merge_session_into_context(ctx, expert_id="exp-1", work_mode="free")
    row = session_record_from_context(ctx, "exp-1")
    assert row["work_mode"] == "free"
    assert row.get("graph_id") is None


def test_apply_envelope_strips_sticky_template_when_free():
    """Critical: after Case RoE merge injected sticky, Free envelope strips it."""
    task = {
        "type": "task_assign",
        "engagement": "pentest",
        "engagement_template": "app_assessment",
        "allow_postex": False,
    }
    env = resolve_work_envelope(
        session_work_mode="free",
        same_mode_continue=True,
        conversation_status="failed",
        case_sticky_template="app_assessment",
        composer_template="app_assessment",
    )
    out = apply_work_envelope_to_task_assign(task, env)
    assert "engagement_template" not in out
    assert "graph_execution" not in out
    assert out["engagement"] == "pentest"  # pack seat unchanged


def test_apply_envelope_sets_graph_template():
    task = {"type": "task_assign", "engagement": "pentest"}
    env = resolve_work_envelope(composer_template="redteam_deep")
    out = apply_work_envelope_to_task_assign(task, env)
    assert out["engagement_template"] == "redteam_deep"


def test_queue_enqueue_when_running_without_force():
    env = resolve_work_envelope(
        composer_template="free",
        session_running=True,
        force_interrupt=False,
    )
    assert env["queue"] == "enqueue"
    env2 = resolve_work_envelope(
        composer_template="free",
        session_running=True,
        force_interrupt=True,
    )
    assert env2["queue"] == "run_now"


def test_permission_enter_graph():
    env = resolve_work_envelope(
        session_work_mode="free",
        permission_decision={"action": "enter_graph", "graph_id": "app_assessment"},
    )
    assert env["work_mode"] == "graph"
    assert env["graph_id"] == "app_assessment"


def test_alias_assess_resolves_to_app_assessment():
    env = resolve_work_envelope(composer_template="assess")
    assert env["work_mode"] == "graph"
    assert env["graph_id"] == "app_assessment"


def test_scenario_0ab49d25_free_fail_continue_with_sticky():
    """Regression: Free fail → 继续 while Case sticky is app_assessment stays Free.

    Simulates platform path: Case RoE merge injects sticky template, then envelope strips it.
    """
    from app.services.case_engagement import merge_case_into_context, roe_payload_for_task_assign

    # Prior Graph left Case sticky; Session last ran Free.
    ctx = merge_case_into_context({}, engagement_template="app_assessment")
    ctx = merge_session_into_context(ctx, expert_id="exp-pen", work_mode="free")
    sticky = roe_payload_for_task_assign(ctx)
    assert sticky.get("engagement_template") == "app_assessment"

    # task_assign after merge would look like:
    task = {
        "type": "task_assign",
        "engagement": "pentest",
        "engagement_template": sticky["engagement_template"],
    }
    sess = session_record_from_context(ctx, "exp-pen")
    env = resolve_work_envelope(
        expert_id="exp-pen",
        session_work_mode=sess.get("work_mode"),
        session_graph_id=sess.get("graph_id"),
        composer_template="app_assessment",  # UI sticky noise on 继续
        case_sticky_template=sticky.get("engagement_template"),
        conversation_status="failed",
        same_mode_continue=True,
    )
    out = apply_work_envelope_to_task_assign(task, env)
    assert env["work_mode"] == "free"
    assert "engagement_template" not in out
    assert out.get("engagement") == "pentest"
