"""Unit tests for Case multi-role participants."""
from app.services.case_participants import (
    agents_from_participants,
    apply_checkpoint_to_participant,
    participant_key,
    participants_list,
    recompute_case_run,
    upsert_participant,
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
