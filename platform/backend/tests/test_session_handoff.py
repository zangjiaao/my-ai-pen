"""Spec #354 S4: pending hold + same-expert auto-handoff isolation."""
from app.services.session_handoff import (
    has_pending_handoff,
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
