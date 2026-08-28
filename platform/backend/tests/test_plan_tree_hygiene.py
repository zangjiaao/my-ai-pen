"""New / unbound Cases must not invent archaeology plan-phase-* Tasks."""

from app.services.conversation_snapshot import (
    agent_state_from_checkpoint,
    agent_state_from_messages,
    current_kanban_stage,
    ensure_plan_tree_shape,
    kanban_for_snapshot,
    merge_snapshot_plan_tree,
    normalize_kanban_buckets,
    todos_for_plan_tree,
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


def test_legacy_checkpoint_phase_is_unknown_not_mapped():
    """Historical Task-era phase / phases_completed: read as unknown — do not map or invent."""
    checkpoint = {
        "state": {
            "phase": "analysis",
            "phases_completed": ["intake", "recon", "analysis"],
        }
    }
    running = agent_state_from_checkpoint(checkpoint, "running")
    assert running["phase"] is None
    completed = agent_state_from_checkpoint(checkpoint, "completed")
    assert completed["phase"] is None
    missing = agent_state_from_checkpoint(None, "completed")  # type: ignore[arg-type]
    assert missing["phase"] is None


def test_message_archaeology_does_not_invent_intake_or_complete():
    assert agent_state_from_messages([], [], "running")["phase"] is None
    assert agent_state_from_messages([], [], "completed")["phase"] is None


def test_status_heartbeat_is_not_agent_phase_ledger():
    """Persisted status rows (settlement leftovers / old Graph ticks) must not
    become snapshot phase — Graph stages live on plan_tree."""
    from types import SimpleNamespace

    msgs = [
        SimpleNamespace(
            msg_type="status",
            content={
                "phase": "class_probe",
                "text": "hard_graph stage_start graph=app_assessment stage=class_probe",
                "active_tool": "shell",
                "status": "running",
            },
        ),
        SimpleNamespace(msg_type="tool_call", content={"tool_name": "http"}),
    ]
    st = agent_state_from_messages(msgs, [], "running")
    assert st["phase"] is None
    assert st["intakeStatus"] is None
    assert st["activeTool"] == "http"


def test_kanban_does_not_map_intake_report_to_stages():
    assert current_kanban_stage("running", "executing") == "executing"
    assert current_kanban_stage("running", None) == "executing"
    assert current_kanban_stage("created", None) == "idle"
    work = [{
        "node_id": "s1",
        "kind": "surface",
        "level": "work_item",
        "status": "pending",
        "title": "login form",
    }]
    kanban = kanban_for_snapshot({}, work, "intake", "running", 0)
    confirm = next(b for b in kanban["buckets"] if b["id"] == "task-confirmation")
    assert confirm["status"] == "pending"
    assert kanban["current_stage"] != "confirming"
    report = kanban_for_snapshot({}, work, "report", "running", 0)
    assert report["current_stage"] != "summarizing"


def test_todos_for_plan_tree_are_not_keyed_on_six_phase_ids():
    tree = [
        {
            "node_id": "plan-phase-recon",
            "kind": "phase",
            "level": "phase",
            "title": "攻击面发现",
            "status": "running",
            "phase": "recon",
        },
        {
            "node_id": "graph-stage-surface",
            "kind": "phase",
            "level": "phase",
            "title": "Surface",
            "status": "running",
            "source": "plan",
        },
    ]
    todos = todos_for_plan_tree(tree)
    ids = {item["id"] for item in todos}
    assert "recon" not in ids
    assert "intake" not in ids
    assert "plan-phase-recon" not in ids
    assert ids == {"graph-stage-surface"}


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


def test_snapshot_reload_does_not_resurrect_cleared_owner():
    """Participant [] is SoT on reload — checkpoint / unowned archaeology stay out."""
    from app.services.case_participants import (
        apply_plan_tree_to_participant,
        participant_plan_tree_owners,
        plan_tree_from_participants,
    )

    ctx = apply_plan_tree_to_participant(
        {},
        [{"node_id": "t1", "title": "recon", "status": "running"}],
        expert_id="e1",
        expert_name="平台助理",
    )
    ctx = apply_plan_tree_to_participant(
        ctx,
        [{"node_id": "t2", "title": "sqli", "status": "pending"}],
        expert_id="e2",
        expert_name="渗透大师",
    )
    ctx = apply_plan_tree_to_participant(ctx, [], expert_id="e1", expert_name="平台助理")

    secondary = [
        {"node_id": "t1", "title": "recon", "owner_expert_id": "e1"},
        {"node_id": "ghost", "title": "unowned checkpoint"},
        {"node_id": "t2", "title": "sqli stale", "owner_expert_id": "e2"},
        {"node_id": "t3", "title": "other role", "owner_expert_id": "e3"},
    ]
    out = merge_snapshot_plan_tree(
        plan_tree_from_participants(ctx),
        secondary,
        participant_plan_tree_owners(ctx),
    )
    titles = {str(n.get("title")) for n in out}
    assert titles == {"sqli", "other role"}
    assert all(str(n.get("owner_expert_id") or "") != "e1" for n in out)


def test_snapshot_full_clear_drops_checkpoint_fallback():
    from app.services.case_participants import (
        apply_plan_tree_to_participant,
        participant_plan_tree_owners,
        plan_tree_from_participants,
    )

    ctx = apply_plan_tree_to_participant(
        {},
        [{"node_id": "t1", "title": "recon"}],
        expert_id="e1",
        expert_name="平台助理",
    )
    ctx = apply_plan_tree_to_participant(ctx, [], expert_id="e1", expert_name="平台助理")
    out = merge_snapshot_plan_tree(
        plan_tree_from_participants(ctx),
        [
            {"node_id": "t1", "title": "recon", "owner_expert_id": "e1"},
            {"node_id": "legacy", "title": "message archaeology"},
        ],
        participant_plan_tree_owners(ctx),
    )
    assert out == []


def test_snapshot_without_declared_plan_keeps_checkpoint():
    secondary = [{"node_id": "legacy", "title": "from checkpoint"}]
    out = merge_snapshot_plan_tree([], secondary, set())
    assert [n.get("title") for n in out] == ["from checkpoint"]
