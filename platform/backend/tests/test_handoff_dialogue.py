"""Handoff user turn stays the operator utterance (not proposed_action)."""

from app.services.handoff_dialogue import is_operator_utterance, resolve_handoff_dialogue

UTTERANCE = "对目标：http://host.docker.internal:3000 再次进行渗透测试，这次主要找找看有没有什么新的供给面之前没测试过的。"
PROPOSED = """**目标**: http://host.docker.internal:3000

**任务**: 再次渗透测试，不重复验证已有台账项（共 196 条，可作索引避免撞车）。

**方法**:
1. 在既有路径之外做目录/端点发现
"""


def test_proposed_action_is_not_instruction():
    out = resolve_handoff_dialogue(
        sticky_instruction=UTTERANCE,
        proposed_action=PROPOSED,
        question="将渗透测试任务移交给「渗透大师」执行？",
        pack="pentest",
    )
    assert out["instruction"] == UTTERANCE
    assert out["handoff_summary"] == PROPOSED.strip()
    assert "196" not in out["instruction"]
    assert "可作索引" not in out["instruction"]


def test_last_user_text_used_when_sticky_missing():
    out = resolve_handoff_dialogue(
        last_user_text=UTTERANCE,
        proposed_action=PROPOSED,
        question="handoff?",
    )
    assert out["instruction"] == UTTERANCE
    assert out["handoff_summary"] == PROPOSED.strip()


def test_authorization_placeholder_is_not_utterance():
    assert is_operator_utterance("Authorization decision: authorize") is False
    assert is_operator_utterance("ok", msg_type="user_decision") is False
    out = resolve_handoff_dialogue(
        last_user_text="Authorization decision: authorize",
        proposed_action=PROPOSED,
        question="将任务移交？",
    )
    assert out["instruction"] == "将任务移交？"
    assert out["handoff_summary"] == PROPOSED.strip()


def test_proposed_never_becomes_instruction_even_as_only_text():
    out = resolve_handoff_dialogue(proposed_action=PROPOSED, pack="pentest")
    assert out["instruction"] == "Continue authorized pentest assessment."
    assert out["handoff_summary"] == PROPOSED.strip()


def test_identical_proposed_does_not_dual_home():
    out = resolve_handoff_dialogue(
        sticky_instruction=UTTERANCE,
        proposed_action=UTTERANCE,
    )
    assert out["instruction"] == UTTERANCE
    assert out["handoff_summary"] is None
