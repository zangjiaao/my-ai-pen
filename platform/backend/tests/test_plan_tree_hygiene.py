"""New / unbound Cases must not invent archaeology plan-phase-* Tasks."""

from app.services.conversation_snapshot import ensure_plan_tree_shape, workflow_kind_for_checkpoint


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
