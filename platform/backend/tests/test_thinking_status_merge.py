"""Spec #305: thinking content.status merge + persist shape (S1 platform seam)."""

from app.ws.router import _merge_saved_message_content, _merge_thinking_status


def test_merge_thinking_status_prefers_done():
    assert _merge_thinking_status("running", "done") == "done"
    assert _merge_thinking_status("done", "running") == "done"
    assert _merge_thinking_status("done", None) == "done"
    assert _merge_thinking_status(None, "running") == "running"
    assert _merge_thinking_status(None, None) is None
    # FE normalizeExecutionStatus synonym lockstep
    assert _merge_thinking_status("running", "completed") == "done"
    assert _merge_thinking_status("ok", "running") == "done"
    assert _merge_thinking_status("running", "success") == "done"
    assert _merge_thinking_status("saved", "running") == "done"


def test_merge_saved_thinking_keeps_longer_body_and_done_status():
    existing = {
        "text": "partial reasoning",
        "reasoning": "partial reasoning",
        "stream_id": "n4-thinking-t1-1",
        "status": "running",
    }
    incoming = {
        "text": "partial",
        "reasoning": "partial",
        "stream_id": "n4-thinking-t1-1",
        "status": "done",
    }
    merged = _merge_saved_message_content(existing, incoming, "thinking")
    assert merged["text"] == "partial reasoning"
    assert merged["reasoning"] == "partial reasoning"
    assert merged["status"] == "done"


def test_merge_saved_thinking_late_running_does_not_drop_done():
    existing = {
        "text": "full body",
        "reasoning": "full body",
        "stream_id": "n4-thinking-t1-1",
        "status": "done",
    }
    incoming = {
        "text": "full body",
        "reasoning": "full body",
        "stream_id": "n4-thinking-t1-1",
        "status": "running",
    }
    merged = _merge_saved_message_content(existing, incoming, "thinking")
    assert merged["status"] == "done"


def test_merge_saved_thinking_empty_running_preserves_status():
    existing = {}
    incoming = {
        "text": "",
        "reasoning": "",
        "stream_id": "n4-thinking-t1-2",
        "status": "running",
    }
    merged = _merge_saved_message_content(existing, incoming, "thinking")
    assert merged["status"] == "running"
    assert merged.get("stream_id") == "n4-thinking-t1-2"
