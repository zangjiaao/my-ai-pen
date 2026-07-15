"""Unit tests for case work-group context (thread + findings board)."""
from app.services.case_context import (
    build_case_context_payload,
    build_findings_summary,
    build_thread_from_messages,
)


def test_thread_keeps_user_and_agent_text_skips_noise_status():
    messages = [
        {
            "role": "user",
            "msg_type": "text",
            "content": {"text": "Please assess http://lab/app"},
            "created_at": "2026-01-01T00:00:00",
        },
        {
            "role": "agent",
            "msg_type": "status",
            "content": {"text": "checkpoint tick", "status": "running"},
            "created_at": "2026-01-01T00:00:01",
        },
        {
            "role": "agent",
            "msg_type": "text",
            "content": {
                "text": "RCE confirmed; source dumped under notes/source_dump. Suggest code-audit.",
                "expert_name": "app-sec",
            },
            "created_at": "2026-01-01T00:01:00",
        },
        {
            "role": "agent",
            "msg_type": "vuln_found",
            "content": {
                "title": "Command injection RCE",
                "severity": "critical",
                "location": "/upload",
                "status": "confirmed",
            },
            "created_at": "2026-01-01T00:01:05",
        },
    ]
    thread = build_thread_from_messages(messages)
    speakers = [t["speaker"] for t in thread]
    texts = " ".join(t["text"] for t in thread)
    assert "user" in speakers
    assert "app-sec" in speakers
    assert "RCE confirmed" in texts
    assert "Command injection" in texts
    assert "checkpoint tick" not in texts


def test_findings_summary_truncates():
    findings = [
        {"id": "1", "title": "SQLi", "severity": "critical", "location": "a.py:1", "status": "confirmed"},
        {"id": "2", "title": "IDOR", "severity": "high", "location": "b.py:2", "status": "confirmed"},
    ]
    summary = build_findings_summary(findings, limit=1)
    assert len(summary) == 1
    assert summary[0]["title"] == "SQLi"


def test_payload_has_version_and_hints():
    messages = [
        {
            "role": "user",
            "msg_type": "text",
            "content": {
                "text": "Source is at /mnt/d/Coding/my-ai-pen/benchmarks/collab-playbook-b/source_dump and HANDOFF_FROM_PENTEST.md"
            },
            "created_at": "t0",
        }
    ]
    payload = build_case_context_payload(
        messages=messages,
        findings=[{"title": "RCE", "severity": "critical", "location": "host", "id": "f1"}],
        conversation_id="conv-1",
    )
    assert payload["version"] == 1
    assert payload["conversation_id"] == "conv-1"
    assert payload["thread"]
    assert payload["findings_summary"][0]["title"] == "RCE"
    assert any("source_dump" in h or "HANDOFF" in h for h in payload["artifact_hints"])
