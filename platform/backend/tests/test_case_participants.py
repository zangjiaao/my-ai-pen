"""Unit tests for Case multi-role participants."""
from app.services.case_participants import (
    agents_from_participants,
    apply_checkpoint_to_participant,
    participant_key,
    participants_list,
    recompute_case_run,
    resolve_worker_display_name,
    set_worker_display_name,
    upsert_participant,
    validate_worker_display_name,
    worker_display_names_map,
)


def test_participant_key_prefers_expert_id():
    assert participant_key(expert_id="abc", pack_id="default", expert_name="助理") == "expert:abc"
    assert participant_key(pack_id="pentest", expert_name="渗透大师").startswith("pack:pentest:")


def test_upsert_two_roles_preserved():
    ctx = {}
    ctx = upsert_participant(
        ctx,
        expert_id="e1",
        expert_name="平台助理",
        pack_id="default",
        last_status="idle",
        last_detail="本轮工作已结束",
    )
    ctx = upsert_participant(
        ctx,
        expert_id="e2",
        expert_name="渗透大师",
        pack_id="pentest",
        last_status="running",
        last_detail="正在查询资产台账",
        usage_snapshot={"total_tokens": 100, "cost": 0.01, "requests": 2},
    )
    rows = participants_list(ctx)
    assert len(rows) == 2
    assert rows[0]["expert_name"] == "渗透大师"  # running first
    assert ctx["case_run"]["llm_usage"]["total_tokens"] == 100
    assert ctx["case_run"]["participant_count"] == 2


def test_checkpoint_does_not_wipe_other_role():
    ctx = upsert_participant(
        {},
        expert_id="e1",
        expert_name="平台助理",
        pack_id="default",
        last_status="idle",
    )
    ctx = apply_checkpoint_to_participant(
        ctx,
        {
            "role_pack": "pentest",
            "task_id": "t1",
            "panel_agents": [
                {
                    "id": "node4-main",
                    "name": "渗透大师",
                    "status": "running",
                    "parent_id": None,
                    "current_detail": "正在执行命令",
                    "current_tool": "shell",
                },
                {
                    "id": "sub_1",
                    "name": "Subagent",
                    "status": "running",
                    "parent_id": "node4-main",
                    "task": "probe API",
                },
            ],
            "llm_usage": {"total_tokens": 50, "cost": 0.002, "requests": 1},
        },
        expert_id="e2",
        expert_name="渗透大师",
        pack_id="pentest",
        task_id="t1",
        running=True,
    )
    keys = set(ctx["participants"].keys())
    assert len(keys) == 2
    agents = agents_from_participants(
        {**ctx, "workers": {"node-a": {"expert_id": "e2", "expert_name": "渗透大师"}}},
    )
    roots = [a for a in agents if not a.get("parent_id")]
    assert len(roots) == 2
    pentest = next(a for a in roots if a["expert_id"] == "e2")
    assert pentest["status"] == "running"
    assert "执行命令" in str(pentest.get("current_detail") or "") or pentest.get("current_tool") == "shell"
    kids = [a for a in agents if a.get("parent_id") == pentest["id"]]
    assert len(kids) == 1


def test_recompute_case_run_sums():
    ctx = {
        "participants": {
            "a": {"usage": {"total_tokens": 10, "cost": 0.1, "requests": 1}, "last_seen_at": "2026-01-01T00:00:00Z"},
            "b": {"usage": {"total_tokens": 5, "cost": 0.05, "requests": 2}, "last_seen_at": "2026-01-02T00:00:00Z"},
        }
    }
    ctx = recompute_case_run(ctx)
    assert ctx["case_run"]["llm_usage"]["total_tokens"] == 15
    assert ctx["case_run"]["started_at"] == "2026-01-01T00:00:00Z"


def test_new_burst_checkpoint_keeps_prior_subagents():
    """Re-chat starts a new work burst whose panel is main-only; prior Subagents must stay."""
    ctx = apply_checkpoint_to_participant(
        {},
        {
            "role_pack": "pentest",
            "task_id": "t1",
            "panel_agents": [
                {
                    "id": "node4-main",
                    "name": "渗透大师",
                    "status": "completed",
                    "parent_id": None,
                    "current_detail": "本轮工作已结束",
                },
                {
                    "id": "sub_1",
                    "name": "Worker 1",
                    "status": "completed",
                    "parent_id": "node4-main",
                    "task": "probe API",
                },
            ],
            "llm_usage": {"total_tokens": 50, "cost": 0.002, "requests": 1},
        },
        expert_id="e2",
        expert_name="渗透大师",
        pack_id="pentest",
        task_id="t1",
        running=False,
    )
    # New user turn → fresh PanelAgentTracker emits main-only panel.
    ctx = apply_checkpoint_to_participant(
        ctx,
        {
            "role_pack": "pentest",
            "task_id": "t2",
            "panel_agents": [
                {
                    "id": "node4-main",
                    "name": "渗透大师",
                    "status": "running",
                    "parent_id": None,
                    "current_detail": "对话中，准备回复",
                    "current_action": "chat",
                },
            ],
            "llm_usage": {"total_tokens": 10, "cost": 0.001, "requests": 1},
        },
        expert_id="e2",
        expert_name="渗透大师",
        pack_id="pentest",
        task_id="t2",
        running=True,
    )
    agents = agents_from_participants(ctx)
    root = next(a for a in agents if not a.get("parent_id") and a.get("expert_id") == "e2")
    kids = [a for a in agents if a.get("parent_id") == root["id"]]
    assert len(kids) == 1, f"prior Subagent wiped on re-chat: {kids}"
    assert kids[0]["name"] == "Worker 1"
    assert kids[0].get("task") == "probe API"
    assert kids[0]["status"] == "completed"


def test_new_burst_upserts_new_subagent_without_dropping_old():
    ctx = apply_checkpoint_to_participant(
        {},
        {
            "panel_agents": [
                {"id": "node4-main", "name": "Main", "status": "running", "parent_id": None},
                {"id": "sub_1", "name": "Worker 1", "status": "completed", "parent_id": "node4-main", "task": "old"},
            ],
        },
        expert_id="e1",
        expert_name="Main",
        pack_id="default",
        running=True,
    )
    ctx = apply_checkpoint_to_participant(
        ctx,
        {
            "panel_agents": [
                {"id": "node4-main", "name": "Main", "status": "running", "parent_id": None},
                {"id": "sub_2", "name": "Worker 2", "status": "running", "parent_id": "node4-main", "task": "new"},
            ],
        },
        expert_id="e1",
        expert_name="Main",
        pack_id="default",
        running=True,
    )
    agents = agents_from_participants(ctx)
    root = next(a for a in agents if not a.get("parent_id"))
    kids = [a for a in agents if a.get("parent_id") == root["id"]]
    assert {k["name"] for k in kids} == {"Worker 1", "Worker 2"}
    by_name = {k["name"]: k for k in kids}
    assert by_name["Worker 1"]["status"] == "completed"
    assert by_name["Worker 1"].get("task") == "old"
    assert by_name["Worker 2"]["status"] == "running"
    assert by_name["Worker 2"].get("task") == "new"


def test_orphan_running_subagent_settled_on_main_only_burst():
    from app.services.case_participants import merge_panel_agents

    prev = [
        {"id": "node4-main", "name": "Main", "status": "running", "parent_id": None},
        {"id": "sub_1", "name": "Worker 1", "status": "running", "parent_id": "node4-main", "task": "still going"},
    ]
    incoming = [
        {"id": "node4-main", "name": "Main", "status": "running", "parent_id": None, "current_action": "chat"},
    ]
    merged = merge_panel_agents(prev, incoming)
    kids = [a for a in merged if a.get("parent_id")]
    assert len(kids) == 1
    assert kids[0]["id"] == "sub_1"
    assert kids[0]["status"] == "completed"
    assert kids[0].get("current_action") == "completed"


def test_empty_incoming_panel_does_not_wipe():
    from app.services.case_participants import merge_panel_agents

    prev = [
        {"id": "node4-main", "name": "Main", "status": "idle", "parent_id": None},
        {"id": "sub_1", "name": "Worker 1", "status": "completed", "parent_id": "node4-main"},
    ]
    assert merge_panel_agents(prev, []) == prev
    # Missing panel_agents on checkpoint becomes [] at apply_checkpoint — same keep.
    ctx = apply_checkpoint_to_participant(
        {},
        {"panel_agents": prev},
        expert_id="e1",
        expert_name="Main",
        pack_id="default",
        running=False,
    )
    ctx = apply_checkpoint_to_participant(
        ctx,
        {"task_id": "t2"},  # no panel_agents key → empty list path
        expert_id="e1",
        expert_name="Main",
        pack_id="default",
        running=True,
    )
    panel = ctx["participants"]["expert:e1"]["panel_agents"]
    assert any(a.get("id") == "sub_1" for a in panel)


def test_plan_tree_per_role_does_not_wipe_other():
    from app.services.case_participants import apply_plan_tree_to_participant, plan_tree_from_participants

    ctx = apply_plan_tree_to_participant(
        {},
        [{"node_id": "t1", "title": "recon", "level": "work_item", "source": "plan", "kind": "task"}],
        expert_id="e1",
        expert_name="平台助理",
        pack_id="default",
    )
    ctx = apply_plan_tree_to_participant(
        ctx,
        [{"node_id": "t2", "title": "sqli", "level": "work_item", "source": "plan", "kind": "task"}],
        expert_id="e2",
        expert_name="渗透大师",
        pack_id="pentest",
    )
    flat = plan_tree_from_participants(ctx)
    titles = {str(n.get("title")) for n in flat}
    assert titles == {"recon", "sqli"}
    owners = {str(n.get("owner_expert_id")) for n in flat}
    assert owners == {"e1", "e2"}


# --- Spec #308 Worker display_name ---


def test_resolve_worker_display_name_priority():
    assert resolve_worker_display_name(agent_id="sub_1", override="Alice", panel_name="Worker 2") == "Alice"
    assert resolve_worker_display_name(agent_id="sub_1", panel_name="Worker 2") == "Worker 2"
    assert resolve_worker_display_name(agent_id="sub_1", worker_ordinal=3) == "Worker 3"
    assert resolve_worker_display_name(agent_id="sub_1") == "Worker"


def test_set_worker_display_name_write_clear():
    ctx = set_worker_display_name({}, agent_id="sub_1", display_name="  Recon bot  ")
    assert ctx is not None
    assert worker_display_names_map(ctx) == {"sub_1": "Recon bot"}
    ctx2 = set_worker_display_name(ctx, agent_id="sub_1", display_name="")
    assert ctx2 is not None
    assert worker_display_names_map(ctx2) == {}
    assert "worker_display_names" not in ctx2


def test_validate_worker_display_name():
    assert validate_worker_display_name("ok") == "ok"
    assert validate_worker_display_name("  ") == ""
    assert validate_worker_display_name("a" * 65) is None
    assert validate_worker_display_name("bad\nname") is None


# --- Spec #324 S1: Case metering ledger ---


def test_s1_multi_participant_sum_tokens_cost_requests():
    """Two Participants → Case total = sum once (tokens/cost/requests)."""
    from app.services.case_participants import merge_usage_lifetime

    ctx = upsert_participant(
        {},
        expert_id="e1",
        expert_name="平台助理",
        pack_id="default",
        usage_snapshot={"total_tokens": 100, "cost": 0.02, "requests": 3, "model": "gpt-test-a"},
        usage_mode="lifetime",
    )
    ctx = upsert_participant(
        ctx,
        expert_id="e2",
        expert_name="渗透大师",
        pack_id="pentest",
        usage_snapshot={"total_tokens": 50, "cost": 0.01, "requests": 2, "model": "gpt-test-b"},
        usage_mode="lifetime",
    )
    usage = ctx["case_run"]["llm_usage"]
    assert usage["total_tokens"] == 150
    assert abs(usage["cost"] - 0.03) < 1e-9
    assert usage["requests"] == 5
    # recompute is stable (no double-count on re-run)
    again = recompute_case_run(ctx)
    assert again["case_run"]["llm_usage"]["total_tokens"] == 150
    assert again["case_run"]["llm_usage"]["requests"] == 5
    # helper sanity
    life, cur = merge_usage_lifetime({}, {}, {"total_tokens": 10, "cost": 0.1, "requests": 1})
    assert life["total_tokens"] == 10
    assert cur["total_tokens"] == 10


def test_s1_sub_usage_included_once_in_parent_and_case():
    """Sub spend folds into parent Participant and Case once (no double-count)."""
    ctx = apply_checkpoint_to_participant(
        {},
        {
            "role_pack": "pentest",
            "panel_agents": [
                {"id": "node4-main", "name": "渗透大师", "status": "running", "parent_id": None},
                {
                    "id": "sub_1",
                    "name": "Worker 1",
                    "status": "running",
                    "parent_id": "node4-main",
                    "usage": {"total_tokens": 30, "cost": 0.003, "requests": 1},
                },
            ],
            "llm_usage": {"total_tokens": 70, "cost": 0.007, "requests": 2, "model": "gpt-main"},
        },
        expert_id="e2",
        expert_name="渗透大师",
        pack_id="pentest",
        running=True,
    )
    row = ctx["participants"]["expert:e2"]
    # own 70 + sub 30
    assert row["usage"]["total_tokens"] == 100
    assert row["usage_own"]["total_tokens"] == 70
    assert abs(row["usage"]["cost"] - 0.01) < 1e-9
    assert row["usage"]["requests"] == 3
    assert ctx["case_run"]["llm_usage"]["total_tokens"] == 100
    assert ctx["case_run"]["llm_usage"]["requests"] == 3

    agents = agents_from_participants(ctx)
    root = next(a for a in agents if not a.get("parent_id"))
    assert root["usage"]["total_tokens"] == 100
    assert root.get("model") == "gpt-main"
    kids = [a for a in agents if a.get("parent_id") == root["id"]]
    assert len(kids) == 1
    assert kids[0]["usage"]["total_tokens"] == 30
    # Case still 100 — Sub shown on row does not add a second Case line
    assert recompute_case_run(ctx)["case_run"]["llm_usage"]["total_tokens"] == 100


def test_s1_double_count_refusal_recompute_stable():
    """Rolling Sub into parent must not inflate Case when recomputed repeatedly."""
    ctx = {
        "participants": {
            "expert:e1": {
                "key": "expert:e1",
                "expert_id": "e1",
                "expert_name": "Main",
                "pack_id": "default",
                "usage_own": {"total_tokens": 40, "cost": 0.004, "requests": 1},
                "usage": {"total_tokens": 40, "cost": 0.004, "requests": 1},
                "panel_agents": [
                    {"id": "m", "name": "Main", "parent_id": None, "status": "idle"},
                    {
                        "id": "sub_1",
                        "name": "Worker 1",
                        "parent_id": "m",
                        "status": "completed",
                        "usage": {"total_tokens": 25, "cost": 0.002, "requests": 2},
                    },
                ],
                "last_seen_at": "2026-01-01T00:00:00Z",
            }
        }
    }
    ctx = recompute_case_run(ctx)
    assert ctx["case_run"]["llm_usage"]["total_tokens"] == 65
    ctx = recompute_case_run(ctx)
    ctx = recompute_case_run(ctx)
    assert ctx["case_run"]["llm_usage"]["total_tokens"] == 65
    assert ctx["participants"]["expert:e1"]["usage"]["total_tokens"] == 65
    assert ctx["participants"]["expert:e1"]["usage_own"]["total_tokens"] == 40


def test_s1_non_reset_across_bursts_and_handoff():
    """Z1: new burst (lower snap) accumulates; handoff to another expert does not zero prior."""
    ctx = apply_checkpoint_to_participant(
        {},
        {
            "panel_agents": [
                {"id": "node4-main", "name": "渗透大师", "status": "completed", "parent_id": None},
            ],
            "llm_usage": {"total_tokens": 50, "cost": 0.005, "requests": 2, "model": "m1"},
        },
        expert_id="e2",
        expert_name="渗透大师",
        pack_id="pentest",
        running=False,
    )
    # New work-burst resets Node burst meters to a smaller cumulative snap.
    ctx = apply_checkpoint_to_participant(
        ctx,
        {
            "panel_agents": [
                {"id": "node4-main", "name": "渗透大师", "status": "running", "parent_id": None},
            ],
            "llm_usage": {"total_tokens": 10, "cost": 0.001, "requests": 1, "model": "m1"},
        },
        expert_id="e2",
        expert_name="渗透大师",
        pack_id="pentest",
        running=True,
    )
    e2 = ctx["participants"]["expert:e2"]
    assert e2["usage_own"]["total_tokens"] == 60, f"burst under-count: {e2.get('usage_own')}"
    assert e2["usage"]["total_tokens"] == 60
    assert ctx["case_run"]["llm_usage"]["total_tokens"] == 60

    # Handoff / @ another expert — prior meters stay; Case sums both.
    ctx = apply_checkpoint_to_participant(
        ctx,
        {
            "panel_agents": [
                {"id": "node4-main", "name": "平台助理", "status": "running", "parent_id": None},
            ],
            "llm_usage": {"total_tokens": 20, "cost": 0.002, "requests": 1, "model": "m2"},
        },
        expert_id="e1",
        expert_name="平台助理",
        pack_id="default",
        running=True,
    )
    assert ctx["participants"]["expert:e2"]["usage"]["total_tokens"] == 60
    assert ctx["participants"]["expert:e1"]["usage"]["total_tokens"] == 20
    assert ctx["case_run"]["llm_usage"]["total_tokens"] == 80
    assert ctx["case_run"]["llm_usage"]["requests"] == 4  # 2+1 + 1


def test_s1_task_map_plan_tree_does_not_reset_meters():
    """#321 decoupling: plan_tree archive/replace path must not clear Case meters."""
    from app.services.case_participants import apply_plan_tree_to_participant

    ctx = upsert_participant(
        {},
        expert_id="e1",
        expert_name="Main",
        pack_id="default",
        usage_snapshot={"total_tokens": 99, "cost": 0.09, "requests": 4, "model": "m"},
        usage_mode="lifetime",
    )
    before = dict(ctx["case_run"]["llm_usage"])
    ctx = apply_plan_tree_to_participant(
        ctx,
        [{"node_id": "t1", "title": "recon", "level": "work_item", "source": "plan", "kind": "task"}],
        expert_id="e1",
        expert_name="Main",
        pack_id="default",
    )
    # Simulate a second full map replace (archive-then-switch class write).
    ctx = apply_plan_tree_to_participant(
        ctx,
        [{"node_id": "t2", "title": "probe", "level": "work_item", "source": "plan", "kind": "task"}],
        expert_id="e1",
        expert_name="Main",
        pack_id="default",
    )
    assert ctx["case_run"]["llm_usage"]["total_tokens"] == before["total_tokens"] == 99
    assert ctx["case_run"]["llm_usage"]["requests"] == before["requests"] == 4
    assert abs(ctx["case_run"]["llm_usage"]["cost"] - before["cost"]) < 1e-9
    assert ctx["participants"]["expert:e1"]["usage"]["total_tokens"] == 99


def test_s1_agents_expose_model_requests_tokens():
    ctx = upsert_participant(
        {},
        expert_id="e1",
        expert_name="Main",
        pack_id="default",
        usage_snapshot={"total_tokens": 12, "cost": 0.0, "requests": 3, "model": "configured-model-x"},
        usage_mode="lifetime",
        last_status="idle",
    )
    agents = agents_from_participants(ctx)
    root = next(a for a in agents if not a.get("parent_id"))
    assert root["usage"]["total_tokens"] == 12
    assert root["usage"]["requests"] == 3
    assert root.get("model") == "configured-model-x"


def test_s1_pre_upgrade_usage_cursor_no_double_count():
    """Pre-S1 roster has usage but no usage_own/cursor; first lifetime merge must not 2x."""
    from app.services.case_participants import apply_checkpoint_to_participant, recompute_case_run

    ctx = {
        "participants": {
            "expert:e1": {
                "expert_id": "e1",
                "expert_name": "Main",
                "pack_id": "default",
                "usage": {"total_tokens": 100, "cost": 0.01, "requests": 5},
                "last_seen_at": "2026-01-01T00:00:00Z",
            }
        }
    }
    # recompute migrates via ensure_usage_own
    ctx = recompute_case_run(ctx)
    assert ctx["participants"]["expert:e1"]["usage_own"]["total_tokens"] == 100
    assert ctx["participants"]["expert:e1"]["usage_cursor"]["total_tokens"] == 100

    # Same cumulative checkpoint snap should not re-add 100
    ctx = apply_checkpoint_to_participant(
        ctx,
        {
            "role_pack": "default",
            "task_id": "t-new",
            "panel_agents": [{"id": "main", "name": "Main", "status": "running", "parent_id": None}],
            "llm_usage": {"total_tokens": 100, "cost": 0.01, "requests": 5},
        },
        expert_id="e1",
        expert_name="Main",
        pack_id="default",
        task_id="t-new",
        running=True,
    )
    assert ctx["case_run"]["llm_usage"]["total_tokens"] == 100
    assert ctx["participants"]["expert:e1"]["usage"]["total_tokens"] == 100
