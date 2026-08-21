"""New / unbound Cases must not invent archaeology plan-phase-* Tasks."""

from app.services.conversation_snapshot import (
    ensure_plan_tree_shape,
    kanban_for_snapshot,
    normalize_kanban_buckets,
    progress_for_checkpoint,
    progress_for_phase,
    todos_for_checkpoint,
    todos_for_phase,
    workflow_kind_for_checkpoint,
)


def test_empty_checkpoint_has_no_workflow_kind():
    assert workflow_kind_for_checkpoint({}) == ""
    assert workflow_kind_for_checkpoint(None) == ""  # type: ignore[arg-type]


def test_empty_workflow_does_not_invent_plan_phase_shells():
    """Brand-new Case snapshot: no checkpoint yet → empty plan_tree.

    The old default branch synthesized six plan-phase-* rows (intake…complete)
    which flashed in Tasks then vanished once Node4 stamped workflow_kind=pentest.
    """
    out = ensure_plan_tree_shape([], None, set(), "created", "")
    assert out == []
    out_none = ensure_plan_tree_shape([], None, set(), "created", None)
    assert out_none == []


def test_empty_workflow_strips_legacy_plan_phase_rows():
    leftover = [
        {
            "node_id": "plan-phase-intake",
            "title": "目标与授权范围检查",
            "kind": "phase",
            "level": "phase",
            "status": "pending",
            "source": "runtime",
        }
    ]
    out = ensure_plan_tree_shape(leftover, None, set(), "created", "")
    assert out == []


def test_phase_helpers_do_not_invent_six_item_checklists():
    assert todos_for_phase("intake", "running") == []
    assert todos_for_checkpoint({"state": {"phase": "analysis"}}, "running") == []
    assert progress_for_phase("recon", "running") == {"current": 0, "total": 0, "percent": 0}
    assert progress_for_checkpoint({"state": {"phase": "analysis"}}, "running") == {
        "current": 0,
        "total": 0,
        "percent": 0,
    }


def test_empty_pentest_kanban_has_no_padded_buckets():
    kanban = kanban_for_snapshot({}, [], None, "created", 0)
    assert kanban["buckets"] == []
    assert kanban["current_stage"] == "idle"
    assert kanban["totals"]["discovered"] == 0

    padded = normalize_kanban_buckets([], "pentest")
    assert padded == []
    kept = normalize_kanban_buckets(
        [{"id": "attack-surface", "title": "攻击面识别", "done": 1, "total": 2, "status": "running"}],
        "pentest",
    )
    assert [b["id"] for b in kept] == ["attack-surface"]
