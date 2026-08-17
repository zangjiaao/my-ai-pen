"""Handoff dialogue channel (utterance-only user turn).

Cross-expert authorize must not promote Default's `proposed_action` into the
destination Expert's user turn. Spec #455 / prompt-layers: user = operator
utterance; authorized card body is a This-turn Handoff note.
"""

from __future__ import annotations

_DECISION_TYPES = frozenset({"user_decision", "request_decision", "decision"})


def is_operator_utterance(text: str, *, msg_type: str = "") -> bool:
    """True when `text` is human chat, not a ChoiceCard / authorize placeholder."""
    t = str(text or "").strip()
    if not t:
        return False
    mt = str(msg_type or "").strip().lower()
    if mt in _DECISION_TYPES:
        return False
    if t.lower().startswith("authorization decision:"):
        return False
    return True


def resolve_handoff_dialogue(
    *,
    sticky_instruction: str = "",
    last_user_text: str = "",
    proposed_action: str = "",
    question: str = "",
    pack: str = "pentest",
) -> dict[str, str | None]:
    """Pick Expert user-turn text vs Case-visible handoff summary.

    Never uses `proposed_action` as `instruction`.
    """
    utterance = ""
    if is_operator_utterance(sticky_instruction):
        utterance = sticky_instruction.strip()
    elif is_operator_utterance(last_user_text):
        utterance = last_user_text.strip()
    elif is_operator_utterance(question):
        utterance = question.strip()
    else:
        pack_id = str(pack or "pentest").strip() or "pentest"
        utterance = f"Continue authorized {pack_id} assessment."

    summary = str(proposed_action or "").strip()
    if summary and summary == utterance:
        summary = ""
    return {
        "instruction": utterance,
        "handoff_summary": summary or None,
    }
