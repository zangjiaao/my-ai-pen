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
    """A1/A9: Free fail + 继续 + Case sticky app_assessment, composer omitted → Free."""
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="free",
        session_graph_id=None,
        composer_template=None,  # continue path: no this-turn Workflow field
        case_sticky_template="app_assessment",
        conversation_status="failed",
        same_mode_continue=True,
    )
    assert env["work_mode"] == "free"
    assert env["graph_id"] is None
    assert env["engagement_template"] is None
    assert env["graph_execution"] is None


def test_same_mode_continue_explicit_composer_graph_wins():
    """D7/A2: user selects Graph Workflow on 继续 → Graph (composer before same-mode)."""
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="free",
        composer_template="app_assessment",
        case_sticky_template="app_assessment",
        conversation_status="failed",
        same_mode_continue=True,
    )
    assert env["work_mode"] == "graph"
    assert env["graph_id"] == "app_assessment"


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
    """Spec #282 S1: incomplete Graph continue keeps Graph mode; wire resume (not C1)."""
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
    assert env["graph_execution"] == "resume"
    assert env["wire_graph_execution"] == "resume"


def test_graph_completed_c1_continue():
    """Spec #282 S5: post-complete C1 still wires continue (free-in-envelope)."""
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
    """Critical: Case RoE merge injected sticky onto task; Free envelope strips it."""
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
        composer_template=None,  # this-turn message did not select Workflow
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


def test_permission_switch_graph():
    env = resolve_work_envelope(
        session_work_mode="graph",
        session_graph_id="app_assessment",
        permission_decision={"action": "switch_graph", "graph_id": "redteam_deep"},
    )
    assert env["work_mode"] == "graph"
    assert env["graph_id"] == "redteam_deep"
    assert env["graph_execution"] == "full_restart"


def test_permission_exit_graph():
    env = resolve_work_envelope(
        session_work_mode="graph",
        session_graph_id="app_assessment",
        permission_decision={"action": "exit_graph"},
    )
    assert env["work_mode"] == "free"
    assert env["graph_id"] is None


def test_spec278_a1_unspecified_does_not_kick_graph_session():
    """Spec #278 A1: composer 不指定 / free / empty while Session is Graph → stay Graph.

    不指定 is not exit Graph; exit needs permission card. FE omits field (absent)
    or may send free aliases — both must preserve Session Graph.
    """
    for composer in ("不指定", "free", "none", "unspecified", ""):
        env = resolve_work_envelope(
            expert_id="e1",
            session_work_mode="graph",
            session_graph_id="app_assessment",
            composer_template=composer,
            case_sticky_template="app_assessment",
        )
        assert env["work_mode"] == "graph", composer
        assert env["graph_id"] == "app_assessment", composer
        assert env["engagement_template"] == "app_assessment", composer

    # Absent field (FE omit when 不指定) also keeps Graph via Session.
    env_absent = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="graph",
        session_graph_id="redteam_deep",
        composer_template=None,
    )
    assert env_absent["work_mode"] == "graph"
    assert env_absent["graph_id"] == "redteam_deep"


def test_spec278_a1_unspecified_on_free_session_stays_free():
    """First / Free Session + 不指定 stays Free (no silent Graph)."""
    env = resolve_work_envelope(
        session_work_mode="free",
        composer_template="不指定",
        case_sticky_template="app_assessment",
    )
    assert env["work_mode"] == "free"
    assert env["graph_id"] is None


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

    # Case RoE merge injects sticky onto task_assign; message composer field is absent.
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
        composer_template=None,  # 继续 message did not send engagement_template
        case_sticky_template=sticky.get("engagement_template"),
        conversation_status="failed",
        same_mode_continue=True,
    )
    out = apply_work_envelope_to_task_assign(task, env)
    assert env["work_mode"] == "free"
    assert "engagement_template" not in out
    assert out.get("engagement") == "pentest"


# --- Spec #282: Participant Session continue after interrupt (S1–S8) ---


def test_s1_graph_interrupt_continue_stays_graph_not_c1():
    """S1: Graph mid-work → interrupt →「继续」(composer 不指定) stays graph; not Free cold OMP."""
    for status in ("incomplete", "canceled", "failed", "paused"):
        for composer in (None, "不指定", "free", ""):
            env = resolve_work_envelope(
                expert_id="e1",
                session_work_mode="graph",
                session_graph_id="app_assessment",
                composer_template=composer,
                case_sticky_template="app_assessment",
                conversation_status=status,
                same_mode_continue=True,
            )
            assert env["work_mode"] == "graph", (status, composer)
            assert env["graph_id"] == "app_assessment", (status, composer)
            assert env["engagement_template"] == "app_assessment", (status, composer)
            assert env["graph_execution"] == "resume", (status, composer)
            assert env["wire_graph_execution"] == "resume", (status, composer)
            # Must not wire C1 free-in-envelope synonym
            assert env["wire_graph_execution"] != "continue", (status, composer)


def test_s2_incomplete_graph_continue_keeps_graph_envelope_not_stripped():
    """S2: continue under Graph keeps plan-bearing Graph envelope (not Free strip).

    Full todo projection lives in Node; at platform seam we lock that continue does not
    strip engagement_template (which forced Free empty Todo cold-start).
    """
    task = {
        "type": "task_assign",
        "engagement": "pentest",
        "engagement_template": "app_assessment",
        "accounts": [{"username": "admin", "password": "password"}],
    }
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="graph",
        session_graph_id="app_assessment",
        composer_template=None,
        conversation_status="canceled",
        same_mode_continue=True,
    )
    out = apply_work_envelope_to_task_assign(task, env)
    assert env["work_mode"] == "graph"
    assert out.get("engagement_template") == "app_assessment"
    assert out.get("graph_execution") == "resume"
    # Accounts on task_assign are not stripped by Free demotion path
    assert out.get("accounts") == [{"username": "admin", "password": "password"}]


def test_s3_credential_accounts_available_on_graph_continue():
    """S3: structured accounts remain on continue task envelope under Graph Session."""
    from app.services.case_engagement import merge_case_into_context, roe_payload_for_task_assign

    accounts = [{"username": "admin", "password": "password"}]
    ctx = merge_case_into_context(
        {},
        engagement_template="app_assessment",
        accounts=accounts,
    )
    ctx = merge_session_into_context(
        ctx, expert_id="e1", work_mode="graph", graph_id="app_assessment"
    )
    roe = roe_payload_for_task_assign(ctx)
    assert roe.get("accounts") == accounts

    task = {
        "type": "task_assign",
        "engagement": "pentest",
        **{k: v for k, v in roe.items()},
    }
    sess = session_record_from_context(ctx, "e1")
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode=sess.get("work_mode"),
        session_graph_id=sess.get("graph_id"),
        composer_template=None,
        conversation_status="incomplete",
        same_mode_continue=True,
    )
    out = apply_work_envelope_to_task_assign(task, env)
    assert env["work_mode"] == "graph"
    assert out.get("engagement_template") == "app_assessment"
    assert out.get("graph_execution") == "resume"
    assert out.get("accounts") == accounts


def test_s4_free_continue_sticky_graph_stays_free():
    """S4: Free + incomplete +「继续」+ Case sticky Graph stays Free (#277 A1)."""
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="free",
        session_graph_id=None,
        composer_template=None,
        case_sticky_template="app_assessment",
        conversation_status="incomplete",
        same_mode_continue=True,
    )
    assert env["work_mode"] == "free"
    assert env["graph_id"] is None
    assert env["engagement_template"] is None
    assert env["graph_execution"] is None
    out = apply_work_envelope_to_task_assign(
        {"engagement_template": "app_assessment", "engagement": "pentest"},
        env,
    )
    assert "engagement_template" not in out


def test_s5_graph_completed_c1_not_resume():
    """S5: Graph completed + follow-up → C1 continue (free-in-envelope), not resume."""
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="graph",
        session_graph_id="app_assessment",
        composer_template="app_assessment",
        conversation_status="completed",
        same_mode_continue=False,
    )
    assert env["work_mode"] == "graph"
    assert env["graph_execution"] == "continue_session"
    assert env["wire_graph_execution"] == "continue"


def test_s6_incomplete_must_not_take_c1_path():
    """S6: Graph incomplete + wire that previously meant C1 continue → resume, not continue."""
    # Even if client sends explicit continue synonym, incomplete Graph Session stays resume.
    for explicit in ("continue", "continue_chat", "envelope", None):
        env = resolve_work_envelope(
            expert_id="e1",
            session_work_mode="graph",
            session_graph_id="app_assessment",
            composer_template=None,
            conversation_status="incomplete",
            same_mode_continue=True,
            explicit_execution=explicit,
        )
        assert env["work_mode"] == "graph", explicit
        assert env["graph_execution"] == "resume", explicit
        assert env["wire_graph_execution"] == "resume", explicit


def test_s7_canceled_after_idle_interrupt_continue_by_session_mode():
    """S7: after idle interrupt settles to canceled, continue follows Session mode (S1/S4)."""
    # Graph Session
    env_g = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="graph",
        session_graph_id="app_assessment",
        composer_template="不指定",
        conversation_status="canceled",
        same_mode_continue=True,
    )
    assert env_g["work_mode"] == "graph"
    assert env_g["wire_graph_execution"] == "resume"

    # Free Session
    env_f = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="free",
        composer_template="不指定",
        case_sticky_template="app_assessment",
        conversation_status="canceled",
        same_mode_continue=True,
    )
    assert env_f["work_mode"] == "free"
    assert env_f["engagement_template"] is None


def test_s8_explicit_composer_graph_after_free_enters_graph():
    """S8: Explicit composer graph id this turn after Free may enter Graph."""
    env = resolve_work_envelope(
        expert_id="e1",
        session_work_mode="free",
        composer_template="app_assessment",
        conversation_status="canceled",
        same_mode_continue=True,
    )
    assert env["work_mode"] == "graph"
    assert env["graph_id"] == "app_assessment"
    # Enter Graph via Workflow this turn → run (not incomplete Graph resume of prior Free)
    assert env["graph_execution"] == "run"
    assert env["wire_graph_execution"] is None


def test_f758_field_scenario_graph_interrupt_continue_not_free():
    """Field repro pattern f758d7f5: Graph app_assessment → interrupt →「继续」≠ Free."""
    env = resolve_work_envelope(
        expert_id="exp-pen",
        session_work_mode="graph",
        session_graph_id="app_assessment",
        composer_template=None,
        case_sticky_template="app_assessment",
        conversation_status="canceled",
        same_mode_continue=True,
    )
    task = {
        "type": "task_assign",
        "engagement": "pentest",
        "engagement_template": "app_assessment",
        "target": {"type": "url", "value": "http://lab.example/"},
    }
    out = apply_work_envelope_to_task_assign(task, env)
    assert env["work_mode"] == "graph"
    assert out["engagement_template"] == "app_assessment"
    assert out["graph_execution"] == "resume"
    assert out["graph_execution"] != "continue"
