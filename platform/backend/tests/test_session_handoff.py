"""Spec #354 S4: pending hold + same-expert auto-handoff isolation."""
from app.services.session_handoff import (
    has_pending_handoff,
    open_todo_phases_for_expert,
    open_todo_phases_from_plan_tree,
    peek_pending_handoff,
    pending_handoff_expert_ids,
    put_pending_handoff,
    take_pending_handoff,
)


def test_put_and_take_same_expert():
    ctx = {}
    todos = [{"name": "P", "tasks": [{"title": "open", "status": "pending"}]}]
    ctx = put_pending_handoff(ctx, expert_id="pentest", open_todos=todos)
    assert has_pending_handoff(ctx, "pentest")
    assert not has_pending_handoff(ctx, "other")
    assert pending_handoff_expert_ids(ctx) == ["pentest"]

    held = peek_pending_handoff(ctx, "pentest")
    assert held is not None
    assert held["open_todos"] == todos

    ctx2, taken = take_pending_handoff(ctx, "pentest")
    assert taken is not None
    assert taken["open_todos"] == todos
    assert not has_pending_handoff(ctx2, "pentest")


def test_cross_expert_isolation():
    ctx = put_pending_handoff(
        {},
        expert_id="expert_x",
        open_todos=[{"name": "X", "tasks": [{"title": "x-only"}]}],
    )
    assert peek_pending_handoff(ctx, "expert_y") is None
    ctx2, taken = take_pending_handoff(ctx, "expert_y")
    assert taken is None
    assert has_pending_handoff(ctx2, "expert_x")


def test_empty_todos_not_held():
    ctx = put_pending_handoff({}, expert_id="e", open_todos=[])
    assert not has_pending_handoff(ctx)


def test_open_todo_phases_from_plan_tree_preserves_phases_and_progress():
    tree = [
        {
            "level": "phase",
            "kind": "phase",
            "node_id": "todo-phase-recon",
            "title": "侦察",
            "status": "running",
        },
        {
            "level": "work_item",
            "kind": "task",
            "node_id": "todo-task-1",
            "parent_id": "todo-phase-recon",
            "title": "目标可达性与指纹识别",
            "status": "running",
        },
        {
            "level": "work_item",
            "kind": "task",
            "node_id": "todo-task-2",
            "parent_id": "todo-phase-recon",
            "title": "端口服务与Web技术栈",
            "status": "pending",
        },
        {
            "level": "phase",
            "kind": "phase",
            "node_id": "todo-phase-auth",
            "title": "认证与会话",
            "status": "pending",
        },
        {
            "level": "work_item",
            "kind": "task",
            "node_id": "todo-task-3",
            "parent_id": "todo-phase-auth",
            "title": "登录认证机制测试",
            "status": "pending",
        },
    ]
    phases = open_todo_phases_from_plan_tree(tree)
    assert len(phases) == 2
    assert phases[0]["name"] == "侦察"
    titles = [t["title"] for t in phases[0]["tasks"]]
    assert titles == ["目标可达性与指纹识别", "端口服务与Web技术栈"]
    assert phases[0]["tasks"][0]["status"] == "running"
    assert phases[1]["name"] == "认证与会话"


def test_open_todo_phases_sealed_returns_empty():
    tree = [
        {
            "level": "work_item",
            "title": "done item",
            "status": "done",
        }
    ]
    assert open_todo_phases_from_plan_tree(tree) == []


def test_open_todo_phases_for_expert_uses_participant_plan():
    ctx = {
        "participants": {
            "expert:e1": {
                "expert_id": "e1",
                "plan_tree": [
                    {
                        "level": "phase",
                        "kind": "phase",
                        "node_id": "p1",
                        "title": "Recon",
                    },
                    {
                        "level": "work_item",
                        "parent_id": "p1",
                        "title": "finger",
                        "status": "pending",
                    },
                ],
            },
            "expert:e2": {
                "expert_id": "e2",
                "plan_tree": [
                    {
                        "level": "work_item",
                        "title": "other-expert-only",
                        "status": "pending",
                    },
                ],
            },
        }
    }
    phases = open_todo_phases_for_expert(ctx, "e1")
    assert len(phases) == 1
    assert phases[0]["name"] == "Recon"
    assert phases[0]["tasks"][0]["title"] == "finger"
    # Cross-expert: e2 map is not returned for e1
    assert all(
        t.get("title") != "other-expert-only"
        for p in phases
        for t in p.get("tasks") or []
    )


def test_open_todo_phases_for_expert_skips_live_sealed():
    ctx = {
        "participants": {
            "expert:e1": {
                "expert_id": "e1",
                "live_sealed": True,
                "plan_tree": [
                    {"level": "work_item", "title": "still-listed", "status": "pending"},
                ],
            }
        }
    }
    assert open_todo_phases_for_expert(ctx, "e1") == []
