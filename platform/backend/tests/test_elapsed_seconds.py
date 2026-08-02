"""Elapsed wall-clock for right-panel TimeSummary."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.services.conversation_snapshot import elapsed_seconds_for_conversation
from app.services.conversation_state import ConversationStatusError, transition_conversation


def _conv(**kwargs):
    base = {
        "created_at": datetime(2026, 7, 16, 19, 38, 31, tzinfo=timezone.utc),
        "last_active_at": datetime(2026, 7, 16, 19, 38, 31, tzinfo=timezone.utc),
        "status": "created",
    }
    base.update(kwargs)
    return SimpleNamespace(**base)


def test_elapsed_uses_checkpoint_start_and_end_when_conversation_row_stuck():
    """Mirrors 4cbc7209…: status stayed created, but checkpoint has real run window."""
    c = _conv()
    checkpoint = {
        "started_at": "2026-07-16T19:38:32.486Z",
        "end_time": "2026-07-16T19:43:25.867Z",
        "status": "completed",
    }
    elapsed = elapsed_seconds_for_conversation(c, checkpoint)
    # ~4m 53s
    assert 290 <= elapsed <= 295


def test_elapsed_falls_back_to_conversation_timestamps():
    start = datetime(2026, 7, 16, 10, 0, 0, tzinfo=timezone.utc)
    end = start + timedelta(minutes=12, seconds=30)
    c = _conv(created_at=start, last_active_at=end, status="completed")
    assert elapsed_seconds_for_conversation(c, None) == 12 * 60 + 30


def test_elapsed_running_without_end_uses_now():
    start = datetime.now(timezone.utc) - timedelta(seconds=45)
    c = _conv(created_at=start, last_active_at=start, status="running")
    elapsed = elapsed_seconds_for_conversation(c, {"started_at": start.isoformat()})
    assert 40 <= elapsed <= 50


def test_transition_bridges_created_to_completed():
    c = _conv(status="created")
    transition_conversation(c, "completed")
    assert c.status == "completed"
    assert c.last_active_at is not None


def test_transition_still_rejects_invalid_paths():
    # canceled cannot go to completed without running first
    c = _conv(status="canceled")
    try:
        transition_conversation(c, "completed")
        raise AssertionError("expected ConversationStatusError")
    except ConversationStatusError:
        pass


def test_paused_normalizes_to_incomplete():
    """Product convergence: paused is not a product terminal — maps to incomplete."""
    from app.services.conversation_state import normalize_conversation_status

    assert normalize_conversation_status("paused") == "incomplete"
    assert normalize_conversation_status("blocked") == "incomplete"
    # Stored legacy paused row can still settle to completed via incomplete path
    c = _conv(status="paused")
    transition_conversation(c, "completed")
    assert c.status == "completed"


def test_reconcile_heals_created_row_from_terminal_checkpoint():
    from app.services.conversation_state import (
        effective_conversation_status,
        reconcile_conversation_status_from_checkpoint,
    )

    c = _conv(
        status="created",
        context={
            "checkpoint": {
                "status": "completed",
                "started_at": "2026-07-16T19:38:32.486Z",
                "end_time": "2026-07-16T19:43:25.867Z",
            }
        },
    )
    assert effective_conversation_status(c) == "completed"
    assert reconcile_conversation_status_from_checkpoint(c) is True
    assert c.status == "completed"
    assert c.last_active_at.year == 2026


def test_normalize_terminal_plan_keeps_graph_stage_pending():
    from app.services.conversation_snapshot import normalize_terminal_pentest_plan_tree

    tree = [
        {
            "node_id": "graph-stage-init",
            "title": "init",
            "status": "done",
            "level": "phase",
            "kind": "phase",
            "source": "plan",
        },
        {
            "node_id": "graph-stage-surface",
            "title": "surface",
            "status": "blocked",
            "level": "phase",
            "kind": "phase",
            "source": "plan",
        },
        {
            "node_id": "graph-stage-class_probe",
            "title": "class_probe",
            "status": "pending",
            "level": "phase",
            "kind": "phase",
            "source": "plan",
        },
        {
            "node_id": "agent-todo",
            "title": "manual todo",
            "status": "pending",
            "level": "work_item",
            "kind": "task",
            "source": "agent",
        },
    ]
    out = normalize_terminal_pentest_plan_tree(tree, "completed")
    by = {n["node_id"]: n["status"] for n in out}
    assert by["graph-stage-class_probe"] == "pending"
    assert by["graph-stage-surface"] == "blocked"
    assert by["agent-todo"] == "done"
