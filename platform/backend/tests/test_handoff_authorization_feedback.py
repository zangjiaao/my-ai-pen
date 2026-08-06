"""Unit tests for handoff authorization feedback (Spec #277 §3.3 14a)."""
from app.ws.router import (
    _pending_approvals_for_conversation,
    _sanitize_requesting_speaker,
    pending_approvals,
)


def setup_function():
    pending_approvals.clear()


def test_sanitize_strips_handoff_destination_as_speaker_on_request_decision():
    msg = {
        "type": "request_decision",
        "expert_id": "dest-1",
        "expert_name": "渗透大师",
        "handoff_expert_id": "dest-1",
        "handoff_expert_name": "渗透大师",
        "kind": "handoff",
    }
    _sanitize_requesting_speaker(msg)
    assert "expert_id" not in msg
    assert "expert_name" not in msg
    assert msg["handoff_expert_name"] == "渗透大师"


def test_sanitize_keeps_requesting_speaker_when_different_from_handoff():
    msg = {
        "type": "request_decision",
        "expert_id": "src-1",
        "expert_name": "平台助理",
        "handoff_expert_id": "dest-1",
        "handoff_expert_name": "渗透大师",
        "kind": "handoff",
    }
    _sanitize_requesting_speaker(msg)
    assert msg["expert_id"] == "src-1"
    assert msg["expert_name"] == "平台助理"
    assert msg["handoff_expert_name"] == "渗透大师"


def test_sanitize_tool_output_request_user_decision_args():
    msg = {
        "type": "tool_output",
        "tool_name": "request_user_decision",
        "expert_name": "渗透大师",
        "args": {
            "handoff_expert_name": "渗透大师",
            "handoff_expert_id": "dest-1",
            "kind": "handoff",
        },
    }
    _sanitize_requesting_speaker(msg)
    assert "expert_name" not in msg
    assert msg["args"]["handoff_expert_name"] == "渗透大师"


def test_pending_approvals_for_conversation():
    pending_approvals["r1"] = {"conversation_id": "c1", "kind": "handoff"}
    pending_approvals["r2"] = {"conversation_id": "c2", "kind": "confirm"}
    pending_approvals["r3"] = {"conversation_id": "c1", "kind": "confirm"}
    found = _pending_approvals_for_conversation("c1")
    ids = {rid for rid, _ in found}
    assert ids == {"r1", "r3"}
    assert _pending_approvals_for_conversation("missing") == []
