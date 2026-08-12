"""Tool lifecycle status merge + interrupt settle semantics (Case e8a62c56)."""

from app.ws.router import _merge_tool_lifecycle_status, _merge_saved_message_content


def test_merge_tool_lifecycle_prefers_fail_over_done_and_running():
    assert _merge_tool_lifecycle_status("running", "error") == "error"
    assert _merge_tool_lifecycle_status("error", "done") == "error"
    assert _merge_tool_lifecycle_status("done", "running") == "done"
    assert _merge_tool_lifecycle_status("running", "canceled") == "canceled"
    assert _merge_tool_lifecycle_status("running", "interrupted") == "interrupted"
    assert _merge_tool_lifecycle_status("", "") == ""
    assert _merge_tool_lifecycle_status("running", "") == "running"
    assert _merge_tool_lifecycle_status("", "done") == "done"


def test_merge_saved_tool_call_prefers_terminal_over_stale_running():
    existing = {
        "tool_name": "shell",
        "tool_run_id": "call_1",
        "status": "running",
        "stdout": "",
        "tool_items": [
            {"tool_name": "shell", "tool_run_id": "call_1", "status": "running"},
        ],
    }
    incoming = {
        "tool_name": "shell",
        "tool_run_id": "call_1",
        "status": "error",
        "summary": "interrupted",
        "stdout": "",
    }
    merged = _merge_saved_message_content(existing, incoming, "tool_call")
    assert merged["status"] == "error"
    items = merged.get("tool_items") or []
    assert items and items[0]["status"] == "error"


def test_merge_saved_tool_call_does_not_regress_error_to_done():
    existing = {
        "tool_name": "shell",
        "tool_run_id": "call_1",
        "status": "error",
        "tool_items": [
            {"tool_name": "shell", "tool_run_id": "call_1", "status": "error"},
        ],
    }
    incoming = {
        "tool_name": "shell",
        "tool_run_id": "call_1",
        "status": "done",
        "stdout": "late",
    }
    merged = _merge_saved_message_content(existing, incoming, "tool_call")
    assert merged["status"] == "error"
