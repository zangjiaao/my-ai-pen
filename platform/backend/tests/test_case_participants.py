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
