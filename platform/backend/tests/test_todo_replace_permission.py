"""Spec #313 L3 — platform-issued Free todo replace grant (structured confirm only)."""
from app.ws import router as ws_router


def setup_function():
    ws_router.todo_replace_grants.clear()
    ws_router.choice_card_snapshots.clear()
    ws_router.pending_approvals.clear()


def test_replace_permission_structured_option_id():
    assert (
        ws_router._is_todo_replace_user_permission(
            {"decision": "confirm_options"},
            ["replace_todo_map"],
        )
        is True
    )
    assert (
        ws_router._is_todo_replace_user_permission(
            {"decision": "confirm_options"},
            ["continue_deep"],
        )
        is False
    )


def test_replace_permission_explicit_fe_field():
    assert (
        ws_router._is_todo_replace_user_permission(
            {"todo_replace_permission": True},
            None,
        )
        is True
    )
    # Free-text alone must never grant (no NLP)
    assert (
        ws_router._is_todo_replace_user_permission(
            {"text": "请替换任务清单", "decision": "confirm_options"},
            ["continue_deep"],
        )
        is False
    )


def test_grant_is_one_shot_consume():
    ws_router._grant_todo_replace("conv-1")
    assert ws_router._consume_todo_replace_grant("conv-1") is True
    assert ws_router._consume_todo_replace_grant("conv-1") is False


def test_orphaned_choice_card_snapshot_survives_pending_pop():
    """Spec #313 L10: options snapshot remains after pending_approvals consumed."""
    rid = "req-orphan-1"
    ws_router.pending_approvals[rid] = {
        "conversation_id": "c1",
        "kind": "next_steps",
        "options": [
            {"id": "deepen", "title": "加深", "body": "b", "workset_item_ids": ["w1", "w2"]},
            {"id": "report", "title": "报告", "body": "b2"},
        ],
    }
    ws_router.choice_card_snapshots[rid] = {
        "conversation_id": "c1",
        "kind": "next_steps",
        "options": ws_router.pending_approvals[rid]["options"],
    }
    # Simulate confirm consuming pending
    ws_router.pending_approvals.pop(rid)
    snap = ws_router._choice_card_snap_for_request(rid)
    assert snap is not None
    assert snap["options"][0]["workset_item_ids"] == ["w1", "w2"]

    from app.services.choice_card import expand_selected_options

    expanded = expand_selected_options(
        {"kind": snap["kind"], "options": snap["options"]},
        ["deepen"],
    )
    assert expanded["workset_item_ids"] == ["w1", "w2"]
