"""Spec #321 S3 — Task Map revision projection on participants + snapshot fields."""

from __future__ import annotations

from app.services.case_participants import (
    apply_plan_tree_to_participant,
    task_map_projection_from_participants,
)


def test_task_map_persisted_per_participant_and_immutable_archive():
    plan_live = [
        {
            "node_id": "todo-1",
            "title": "Live item",
            "level": "work_item",
            "status": "pending",
            "kind": "task",
            "source": "plan",
        }
    ]
    archived = {
        "id": "tm-1",
        "label": "Free · 2/2",
        "work_mode": "free",
        "is_live": False,
        "sealed": True,
        "sealed_at": "2026-01-01T00:00:00Z",
        "archived_at": "2026-01-01T01:00:00Z",
        "title": None,
        "graph_id": None,
        "done": 2,
        "total": 2,
        "open": 0,
        "plan_tree": [
            {
                "node_id": "old-1",
                "title": "Archived A",
                "level": "work_item",
                "status": "done",
                "kind": "task",
                "source": "plan",
            }
        ],
    }
    live_rev = {
        "id": "tm-2",
        "label": "Free · 0/1",
        "work_mode": "free",
        "is_live": True,
        "sealed": False,
        "sealed_at": None,
        "archived_at": None,
        "title": None,
        "graph_id": None,
        "done": 0,
        "total": 1,
        "open": 1,
        "plan_tree": plan_live,
    }
    ctx = apply_plan_tree_to_participant(
        {},
        plan_live,
        expert_id="exp-a",
        expert_name="Alice",
        pack_id="pentest",
        task_map_revisions=[archived, live_rev],
        live_revision_id="tm-2",
        live_sealed=False,
    )
    proj = task_map_projection_from_participants(ctx)
    assert proj["live_revision_id"] == "tm-2"
    assert proj["live_sealed"] is False
    assert len(proj["task_map_revisions"]) == 2
    hist = next(r for r in proj["task_map_revisions"] if r["id"] == "tm-1")
    assert hist["is_live"] is False
    assert hist["plan_tree"][0]["title"] == "Archived A"

    # Mutating returned list must not corrupt participant store (deep copy).
    hist["plan_tree"][0]["title"] = "MUTATED"
    proj2 = task_map_projection_from_participants(ctx)
    hist2 = next(r for r in proj2["task_map_revisions"] if r["id"] == "tm-1")
    assert hist2["plan_tree"][0]["title"] == "Archived A"


def test_multi_role_maps_stay_session_scoped():
    plan_a = [{"node_id": "a1", "title": "A", "level": "work_item", "status": "done", "kind": "task", "source": "plan"}]
    plan_b = [{"node_id": "b1", "title": "B", "level": "work_item", "status": "pending", "kind": "task", "source": "plan"}]
    ctx = apply_plan_tree_to_participant(
        {},
        plan_a,
        expert_id="exp-a",
        expert_name="Alice",
        pack_id="pentest",
        task_map_revisions=[
            {
                "id": "tm-a",
                "label": "Alice map",
                "work_mode": "free",
                "is_live": True,
                "sealed": True,
                "plan_tree": plan_a,
                "done": 1,
                "total": 1,
                "open": 0,
            }
        ],
        live_revision_id="tm-a",
        live_sealed=True,
    )
    ctx = apply_plan_tree_to_participant(
        ctx,
        plan_b,
        expert_id="exp-b",
        expert_name="Bob",
        pack_id="pentest",
        task_map_revisions=[
            {
                "id": "tm-b",
                "label": "Bob map",
                "work_mode": "free",
                "is_live": True,
                "sealed": False,
                "plan_tree": plan_b,
                "done": 0,
                "total": 1,
                "open": 1,
            }
        ],
        live_revision_id="tm-b",
        live_sealed=False,
    )
    proj = task_map_projection_from_participants(ctx)
    ids = {r["id"] for r in proj["task_map_revisions"]}
    assert "tm-a" in ids and "tm-b" in ids
    # Live follows the most recently updated participant with a live id (Bob).
    assert proj["live_revision_id"] == "tm-b"
    owners = {r.get("owner_expert_id") for r in proj["task_map_revisions"]}
    assert "exp-a" in owners and "exp-b" in owners
