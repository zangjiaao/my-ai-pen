"""Unit tests for case work-group context (thread + findings + evidence snippets)."""
from app.services.case_context import (
    build_case_context_payload,
    build_evidence_snippets,
    build_findings_summary,
    build_thread_from_messages,
    excerpt_from_properties,
    evidence_role,
    path_or_url_from_properties,
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


def test_findings_summary_includes_evidence_ids_and_proof():
    findings = [
        {
            "id": "1",
            "title": "Source code leak",
            "severity": "high",
            "location": "/backup/app.tar.gz",
            "status": "confirmed",
            "evidence_ids": ["ev_src_1", "ev_src_2"],
            "description": "Archive downloadable.\n\n[Proof]\nGET /backup/app.tar.gz → 200\npath=notes/source_dump/app",
        },
        {"id": "2", "title": "IDOR", "severity": "high", "location": "b.py:2", "status": "confirmed"},
    ]
    summary = build_findings_summary(findings, limit=2)
    assert len(summary) == 2
    assert summary[0]["title"] == "Source code leak"
    assert summary[0]["evidence_ids"] == ["ev_src_1", "ev_src_2"]
    assert "notes/source_dump" in summary[0].get("proof_excerpt", "")


def test_evidence_snippets_prefer_linked_proof():
    rows = [
        {
            "evidence_id": "ev_noise",
            "summary": "ls",
            "source_tool": "shell",
            "properties": {"kind": "shell", "role": "trace", "stdout": "total 0", "excerpt": "total 0"},
        },
        {
            "evidence_id": "ev_src",
            "summary": "source dump",
            "source_tool": "write",
            "properties": {
                "kind": "source_excerpt",
                "role": "proof",
                "path": "notes/source_dump/app/Main.java",
                "path_or_url": "notes/source_dump/app/Main.java",
                "preview": "class Main { void login() { ... } }",
                "excerpt": "class Main { void login() { ... } }",
            },
        },
        {
            "evidence_id": "ev_http",
            "summary": "GET leak",
            "source_tool": "http",
            "properties": {
                "kind": "http",
                "role": "proof",
                "url": "http://lab/backup/app.tar.gz",
                "path_or_url": "http://lab/backup/app.tar.gz",
                "status": 200,
                "response_body": "PK\x03\x04...",
                "excerpt": "PK archive bytes",
            },
        },
    ]
    snippets = build_evidence_snippets(rows, referenced_ids={"ev_src"}, limit=5)
    ids = [s["id"] for s in snippets]
    assert "ev_src" in ids
    # Linked source should be first
    assert snippets[0]["id"] == "ev_src"
    assert "Main.java" in (snippets[0].get("path_or_url") or "")
    assert snippets[0].get("excerpt")
    # pure noise not preferred when better material exists
    assert "ev_noise" not in ids or ids.index("ev_src") < ids.index("ev_noise")


def test_payload_has_version_and_evidence_snippets():
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
        findings=[
            {
                "title": "RCE",
                "severity": "critical",
                "location": "host",
                "id": "f1",
                "evidence_ids": ["ev_src"],
                "description": "RCE\n\n[Proof]\nuid=0 root",
            }
        ],
        evidence_rows=[
            {
                "evidence_id": "ev_src",
                "summary": "dumped source",
                "source_tool": "shell",
                "properties": {
                    "role": "proof",
                    "kind": "shell",
                    "command": "cat notes/source_dump/app.py",
                    "path": "notes/source_dump/app.py",
                    "path_or_url": "notes/source_dump/app.py",
                    "stdout": "def vuln():\n  eval(request)",
                    "excerpt": "def vuln():\n  eval(request)",
                },
            }
        ],
        conversation_id="conv-1",
    )
    assert payload["version"] == 2
    assert payload["conversation_id"] == "conv-1"
    assert payload["thread"]
    assert payload["findings_summary"][0]["title"] == "RCE"
    assert payload["findings_summary"][0]["evidence_ids"] == ["ev_src"]
    assert payload["evidence_snippets"]
    assert payload["evidence_snippets"][0]["id"] == "ev_src"
    assert "source_dump" in (payload["evidence_snippets"][0].get("path_or_url") or "")
    assert any("source_dump" in h or "HANDOFF" in h for h in payload["artifact_hints"])


def test_excerpt_and_role_helpers():
    assert excerpt_from_properties({"stdout": "hello world proof"}) == "hello world proof"
    assert evidence_role({"role": "trace"}) == "trace"
    assert evidence_role({"excerpt": "x" * 40}, "shell") == "proof"
    assert evidence_role({}, "todo") == "trace"
    # Book-time Case evidence (source_tool=finding) is product proof, not meta noise.
    assert evidence_role({"role": "proof", "observation": "SQL syntax error near ''1'''"}, "finding") == "proof"
    assert "SQL syntax" in excerpt_from_properties({"observation": "SQL syntax error near ''1'''"})
    assert path_or_url_from_properties({"location": "/vulnerabilities/sqli/"}) == "/vulnerabilities/sqli/"


def test_evidence_snippets_include_book_time_finding_proof():
    rows = [
        {
            "evidence_id": "ev_book_1",
            "summary": "SQLi @ /vulnerabilities/sqli/",
            "source_tool": "finding",
            "properties": {
                "role": "proof",
                "kind": "proof",
                "path_or_url": "http://t/vulnerabilities/sqli/",
                "observation": "You have an error in your SQL syntax near ''1'''",
                "excerpt": "You have an error in your SQL syntax near ''1'''",
            },
        }
    ]
    snippets = build_evidence_snippets(rows, referenced_ids=["ev_book_1"], limit=5)
    assert len(snippets) == 1
    assert snippets[0]["id"] == "ev_book_1"
    assert snippets[0]["role"] == "proof"
    assert "SQL syntax" in (snippets[0].get("excerpt") or "")
    assert "sqli" in (snippets[0].get("path_or_url") or "").lower()

