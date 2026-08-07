"""Spec #312 S1–S3 pure choice card contracts."""
from app.services.choice_card import (
    SOFT_GATE_NOTE,
    apply_soft_gate_note,
    expand_selected_options,
    format_selected_summary,
    is_next_steps_choice,
    messages_have_legal_next_steps_choice,
    should_soft_gate_next_steps,
    validate_choice_card_payload,
)


def test_s1_authorize_without_options():
    r = validate_choice_card_payload(
        {
            "request_id": "r1",
            "kind": "handoff",
            "question": "移交？",
            "proposed_action": "plan",
        }
    )
    assert r["ok"] is True
    assert r["mode"] == "authorize"


def test_s1_next_steps_count_and_body():
    bad = validate_choice_card_payload(
        {"kind": "next_steps", "options": [{"id": "a", "title": "A", "body": "x"}]}
    )
    assert bad["ok"] is False

    missing = validate_choice_card_payload(
        {
            "kind": "next_steps",
            "options": [
                {"id": "a", "title": "A", "body": "ok"},
                {"id": "b", "title": "B", "body": ""},
            ],
        }
    )
    assert missing["ok"] is False

    dup = validate_choice_card_payload(
        {
            "kind": "next_steps",
            "options": [
                {"id": "a", "title": "A", "body": "ok"},
                {"id": "a", "title": "A2", "body": "ok2"},
            ],
        }
    )
    assert dup["ok"] is False

    good = validate_choice_card_payload(
        {
            "kind": "next_steps",
            "options": [
                {"id": "a", "title": "A", "body": "why A", "workset_item_ids": ["w1"]},
                {"id": "b", "title": "B", "body": "why B"},
            ],
        }
    )
    assert good["ok"] is True
    assert good["mode"] == "next_steps"
    assert good["value"]["selection"] == "multi"


def test_s2_expand_selected_options():
    card = {
        "kind": "next_steps",
        "options": [
            {"id": "deepen", "title": "加深", "body": "b", "workset_item_ids": ["w1", "w2"]},
            {"id": "oos", "title": "主机", "body": "b", "workset_item_ids": ["h1", "w1"]},
            {"id": "report", "title": "报告", "body": "b"},
        ],
    }
    exp = expand_selected_options(card, ["deepen", "report"])
    assert exp["workset_item_ids"] == ["w1", "w2"]
    assert exp["summary_titles"] == ["加深", "报告"]
    assert format_selected_summary(exp["summary_titles"]) == "已选择：加深、报告"


def test_s3_soft_gate_predicate():
    assert (
        should_soft_gate_next_steps(
            boundary="stoppable",
            open_workset_count=2,
            has_legal_choice_card=False,
            turn_had_tools=False,
        )
        is True
    )
    assert (
        should_soft_gate_next_steps(
            boundary="continue_empty",
            open_workset_count=0,
            open_priors=True,
            has_legal_choice_card=False,
            turn_had_tools=False,
        )
        is True
    )
    assert (
        should_soft_gate_next_steps(
            boundary="stoppable",
            open_workset_count=2,
            has_legal_choice_card=True,
            turn_had_tools=False,
        )
        is False
    )
    assert (
        should_soft_gate_next_steps(
            boundary="stoppable",
            open_workset_count=2,
            has_legal_choice_card=False,
            turn_had_tools=True,
        )
        is False
    )


def test_messages_have_legal_next_steps():
    messages = [
        {
            "msg_type": "confirm_card",
            "content": {
                "request_id": "r1",
                "kind": "next_steps",
                "options": [
                    {"id": "a", "title": "A", "body": "ba"},
                    {"id": "b", "title": "B", "body": "bb"},
                ],
            },
        }
    ]
    assert messages_have_legal_next_steps_choice(messages) is True
    assert messages_have_legal_next_steps_choice(messages, answered_request_ids={"r1"}) is False
    assert is_next_steps_choice({"options": ["authorize", "cancel"]}) is False


def test_apply_soft_gate_note_once():
    ctx = {
        "note": "base",
        "next_work": {"workset_open_count": 3, "workset_open": [{"id": "w1"}]},
    }
    out, injected = apply_soft_gate_note(
        ctx,
        boundary="case_assign",
        already_injected=False,
        has_legal_choice_card=False,
        turn_had_tools=False,
    )
    assert injected is True
    assert SOFT_GATE_NOTE in out["note"]

    out2, injected2 = apply_soft_gate_note(
        out,
        boundary="case_assign",
        already_injected=True,
        has_legal_choice_card=False,
    )
    assert injected2 is False
