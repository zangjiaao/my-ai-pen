"""Spec #163 NC-Closeout productization helpers."""

from app.services.engagement_closeout import (
    extract_closeout_payload,
    merge_closeout_into_context,
    message_content_from_closeout,
    required_fields_present,
)


def _sample_closeout(**overrides):
    base = {
        "scope": {"allow": ["http://t"]},
        "target": {"value": "http://t"},
        "graphId": "app_assessment",
        "terminal": "blocked",
        "stages": [{"stageId": "authz_logic", "outcome": "blocked", "attempts": 2}],
        "surfaces": {"total": 3},
        "findings": {
            "by_severity": {"high": 1},
            "booked_titles": ["IDOR"],
            "feedback_ok_unbooked": [],
            "unbookable": [],
        },
        "priors": {"prior_n": 0, "re_verified": 0, "still_open": 0, "empty_prior": True},
        "feedback": [{"stageId": "authz_logic", "l0": "blocked", "l1": "skipped_l0_fail"}],
        "residual_risk": "Graph process incomplete",
        "process_complete": False,
        "booking_tail_ran": True,
        "blocked_reasons": ["authz_logic:illegal_l2_done:x"],
    }
    base.update(overrides)
    return base


def test_required_fields_present():
    assert required_fields_present(_sample_closeout()) is True
    assert required_fields_present({"terminal": "completed"}) is False
    assert required_fields_present(None) is False


def test_extract_from_node_frame():
    co = _sample_closeout()
    msg = {
        "type": "engagement_closeout",
        "conversation_id": "c1",
        "task_id": "t1",
        "message": "engagement_closeout terminal=blocked",
        "engagement_closeout": co,
        "status": "blocked",
    }
    assert extract_closeout_payload(msg)["graphId"] == "app_assessment"
    assert extract_closeout_payload({"content": {"engagement_closeout": co}})["terminal"] == "blocked"
    assert extract_closeout_payload({"type": "text"}) is None


def test_message_content_preserves_json_semantics():
    co = _sample_closeout()
    content = message_content_from_closeout(
        {"message": "engagement_closeout terminal=blocked graph=app_assessment"},
        co,
    )
    assert content["type"] == "engagement_closeout"
    assert content["engagement_closeout"]["graphId"] == "app_assessment"
    assert content["process_complete"] is False
    assert content["booking_tail_ran"] is True
    assert content["booked_titles_n"] == 1
    assert "process incomplete" in content["text"]


def test_merge_into_context_latest_and_history():
    co1 = _sample_closeout(terminal="blocked")
    co2 = _sample_closeout(terminal="completed", process_complete=True, booking_tail_ran=None)
    ctx = merge_closeout_into_context({}, co1, task_id="t1")
    assert ctx["engagement_closeout"]["terminal"] == "blocked"
    assert len(ctx["engagement_closeout_history"]) == 1
    ctx = merge_closeout_into_context(ctx, co2, task_id="t1")
    assert ctx["engagement_closeout"]["terminal"] == "completed"
    assert len(ctx["engagement_closeout_history"]) == 2


def test_merge_ignores_superseded_task():
    co = _sample_closeout()
    ctx = {"active_task_id": "active-1"}
    out = merge_closeout_into_context(ctx, co, task_id="old-task")
    assert "engagement_closeout" not in out
