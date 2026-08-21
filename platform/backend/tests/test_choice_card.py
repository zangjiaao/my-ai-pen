"""Spec #312 / #313 pure choice card contracts (S1–S3)."""
from app.services.choice_card import (
    PROJECTED_NEXT_STEPS_QUESTION_ID,
    SOFT_GATE_NOTE,
    apply_soft_gate_note,
    build_confirm_continue_message,
    build_confirm_options_text,
    expand_selected_options,
    format_selected_summary,
    is_next_steps_choice,
    is_question_answer_valid,
    messages_have_legal_next_steps_choice,
    parse_wizard_questions,
    reduce_choice_decision,
    resolve_confirm_options_delivery,
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
    # Spec #313 L8: product default single-select
    assert good["value"]["selection"] == "single"

    multi = validate_choice_card_payload(
        {
            "kind": "next_steps",
            "selection": "multi",
            "options": [
                {"id": "a", "title": "A", "body": "why A"},
                {"id": "b", "title": "B", "body": "why B"},
            ],
        }
    )
    assert multi["ok"] is True
    assert multi["value"]["selection"] == "multi"


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


def test_s3_confirm_text_custom_is_peer_option():
    """Spec #450: confirm text carries title/body + 自定义, never 补充."""
    card = {
        "kind": "next_steps",
        "options": [
            {
                "id": "continue_deep",
                "title": "继续深入探测",
                "body": "对已发现 surface 做二次验证",
                "workset_item_ids": ["w1"],
            },
            {"id": "report", "title": "出报告", "body": "汇总已确认发现"},
        ],
    }
    text = build_confirm_options_text(card, ["continue_deep"], custom_text="优先 login")
    assert "继续深入探测" in text
    assert "对已发现 surface 做二次验证" in text
    assert "自定义：优先 login" in text
    assert "补充" not in text
    text2 = build_confirm_options_text(card, ["report"])
    assert "出报告" in text2
    assert "汇总已确认发现" in text2
    assert "补充" not in text2
    custom_only = build_confirm_options_text(card, [], custom_text="先做登录口")
    assert "自定义：先做登录口" in custom_only
    assert "补充" not in custom_only

    questions = parse_wizard_questions(card)
    assert len(questions) == 1
    assert questions[0]["id"] == PROJECTED_NEXT_STEPS_QUESTION_ID
    assert questions[0]["allow_custom"] is True

    assert is_question_answer_valid(
        selection="single", allow_custom=True, selected_option_ids=[], custom_text="先做登录口"
    )
    assert not is_question_answer_valid(
        selection="single",
        allow_custom=True,
        selected_option_ids=["continue_deep"],
        custom_text="note",
    )

    reduced = reduce_choice_decision(card, custom_text="先做登录口")
    assert reduced["ok"] is True
    assert reduced["selected_option_ids"] == []
    assert reduced["custom_text"] == "先做登录口"
    assert reduce_choice_decision(card, selected_option_ids=[])["ok"] is False

    # custom-alone expands no workset
    exp = expand_selected_options(card, [])
    assert exp["workset_item_ids"] == []


def test_s1_wizard_questions_payload():
    good = validate_choice_card_payload(
        {
            "presentation": "approval_wizard",
            "questions": [
                {
                    "id": "q1",
                    "prompt": "How many?",
                    "selection": "single",
                    "options": [
                        {"id": "three", "title": "Three"},
                        {"id": "five", "title": "Five"},
                    ],
                }
            ],
        }
    )
    assert good["ok"] is True
    assert good["mode"] == "next_steps"
    assert good["value"]["presentation"] == "approval_wizard"

    custom_only = validate_choice_card_payload(
        {
            "presentation": "approval_wizard",
            "questions": [{"id": "only", "prompt": "Anything?", "options": [], "allow_custom": True}],
        }
    )
    assert custom_only["ok"] is True

    blocked = validate_choice_card_payload(
        {
            "presentation": "approval_wizard",
            "questions": [{"id": "only", "prompt": "Pick", "options": [], "allow_custom": False}],
        }
    )
    assert blocked["ok"] is False


def test_s1_confirm_continue_retains_sticky_target():
    """Spec #313 L10: continue demand rehydrates sticky target/scope — no empty chat-only."""
    msg = build_confirm_continue_message(
        text="已选择：\n- 继续深入探测：对 surface 二次验证\n补充：优先 login",
        selected_option_ids=["continue_deep"],
        workset_item_ids=["w1"],
        task_context={
            "target": {"type": "url", "value": "https://app.example/"},
            "scope": {"allow": ["https://app.example/"], "deny": []},
            "instruction": "pentest app.example",
        },
        expert_id="exp-1",
        expert_name="渗透专家",
        engagement="pentest",
    )
    assert msg["type"] == "user_message"
    assert msg["target"]["value"] == "https://app.example/"
    assert "app.example" in str(msg["scope"]["allow"])
    assert msg["expert_id"] == "exp-1"
    assert msg["engagement"] == "pentest"
    assert "继续深入探测" in msg["text"]
    assert msg["workset_item_id"] == "w1"

    # No prior target → still builds text demand (conversation-only only when no engagement target).
    bare = build_confirm_continue_message(text="已选择：出报告")
    assert bare.get("target") is None
    assert "出报告" in bare["text"]


def test_s1_confirm_delivery_modes():
    """Spec #313 S1/L9: busy → enqueue (not steer); live wait → forward; idle → continue."""
    assert (
        resolve_confirm_options_delivery(
            had_live_pending=True,
            conversation_status="running",
            working=True,
            worker_count=1,
        )
        == "forward_live"
    )
    assert (
        resolve_confirm_options_delivery(
            had_live_pending=False,
            conversation_status="running",
            working=True,
            worker_count=1,
        )
        == "enqueue"
    )
    assert (
        resolve_confirm_options_delivery(
            had_live_pending=False,
            conversation_status="completed",
            working=False,
            worker_count=0,
        )
        == "continue_dispatch"
    )
    assert (
        resolve_confirm_options_delivery(
            had_live_pending=True,
            conversation_status="running",
            working=False,
            worker_count=0,
        )
        == "continue_dispatch"
    )
    assert (
        resolve_confirm_options_delivery(
            had_live_pending=True,
            conversation_status="running",
            working=True,
            worker_count=1,
            force_interrupt=True,
        )
        == "continue_dispatch"
    )


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
