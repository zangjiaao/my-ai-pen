"""Spec #280 Wave1: conversation snapshot findings/evidence purity.

Panel Findings SoT = vulnerabilities ledger for this conversation only.
Panel Evidence SoT = evidence table only (no tool_call message fallback).
Chat/message/checkpoint shadows must not inflate panel lists.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from app.services.conversation_snapshot import (
    evidence_for_panel,
    findings_for_panel,
    message_evidence,
    message_findings,
)


def _msg(
    msg_type: str,
    content: dict,
    *,
    conversation_id: uuid.UUID | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        conversation_id=conversation_id or uuid.uuid4(),
        role="agent",
        msg_type=msg_type,
        content=content,
        created_at=datetime.now(timezone.utc),
    )


def _vuln(**kwargs) -> SimpleNamespace:
    base = {
        "id": uuid.uuid4(),
        "title": "SQL Injection",
        "severity": "high",
        "confidence": "high",
        "status": "pending",
        "asset_id": None,
        "port": None,
        "description": "desc",
        "poc": "http://target/vuln",
        "remediation": None,
        "evidence_ids": [],
        "first_seen_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "discovered_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "history": [],
    }
    base.update(kwargs)
    return SimpleNamespace(**base)


def _evidence_row(**kwargs) -> SimpleNamespace:
    base = {
        "id": uuid.uuid4(),
        "evidence_id": f"ev-{uuid.uuid4().hex[:8]}",
        "conversation_id": uuid.uuid4(),
        "node_id": None,
        "type": "http_request",
        "source_tool": "http",
        "tool_run_id": None,
        "raw_ref": None,
        "summary": "booked evidence",
        "hash": None,
        "properties": {},
        "created_at": datetime.now(timezone.utc),
    }
    base.update(kwargs)
    return SimpleNamespace(**base)


def test_findings_empty_when_db_empty_despite_vuln_like_messages():
    """DB 0 vulns + messages with vuln-like content → panel findings length 0."""
    messages = [
        _msg(
            "vuln_card",
            {
                "title": "Chat-only SQLi",
                "severity": "critical",
                "id": "shadow-1",
            },
        ),
        _msg(
            "vuln_found",
            {
                "title": "Unbooked claim",
                "severity": "high",
                "vulnerability_id": "not-in-db",
            },
        ),
    ]
    # Message archaeology still sees cards (chat render path), but panel projection must not.
    assert len(message_findings(messages)) == 2

    panel = findings_for_panel([], messages=messages, checkpoint={
        "candidate_findings": [{"id": "cand-1", "title": "Checkpoint shadow"}],
        "node3_strix": {
            "vulnerabilities": [{"id": "strix-1", "title": "Strix shadow", "severity": "high"}],
        },
    })
    assert panel == []
    assert len(panel) == 0


def test_findings_length_matches_db_ledger_only():
    """DB N vulns → panel findings length N; ids match DB (not message titles)."""
    v1 = _vuln(title="Ledger A")
    v2 = _vuln(title="Ledger B")
    messages = [
        _msg("vuln_card", {"title": "Extra chat card", "id": "chat-x"}),
        _msg("vuln_found", {"title": "Ledger ghost", "id": "ghost"}),
    ]
    panel = findings_for_panel([v1, v2], messages=messages, checkpoint={
        "confirmed_findings": [{"id": "cand-9", "title": "More shadow"}],
    })
    assert len(panel) == 2
    ids = {row["id"] for row in panel}
    assert ids == {str(v1.id), str(v2.id)}
    titles = {row["title"] for row in panel}
    assert titles == {"Ledger A", "Ledger B"}
    assert "Extra chat card" not in titles
    assert "More shadow" not in titles


def test_evidence_empty_when_only_tool_messages():
    """Evidence only in tool messages, none in evidence table → panel evidence length 0."""
    messages = [
        _msg(
            "tool_call",
            {
                "tool_name": "execute",
                "tool_run_id": "run-1",
                "stdout": "nmap scan noise that used to become panel evidence",
                "status": "done",
            },
        ),
        _msg(
            "tool_call",
            {
                "tool_name": "http_request",
                "tool_run_id": "run-2",
                "stdout": "GET / HTTP/1.1",
                "status": "done",
            },
        ),
    ]
    # Old message_evidence(include_tool_calls=True) would invent rows.
    assert len(message_evidence(messages, include_tool_calls=True)) == 2

    panel = evidence_for_panel([], messages=messages)
    assert panel == []
    assert len(panel) == 0


def test_evidence_length_matches_table_only():
    """Persisted evidence rows are the only panel evidence source."""
    e1 = _evidence_row(evidence_id="ev-booked-1", summary="from book path")
    e2 = _evidence_row(evidence_id="ev-booked-2", summary="second row")
    messages = [
        _msg(
            "tool_call",
            {"tool_name": "shell", "tool_run_id": "noise", "stdout": "noise", "status": "done"},
        ),
        _msg(
            "evidence_created",
            {"evidence_id": "ev-from-message", "summary": "should not replace table"},
        ),
    ]
    panel = evidence_for_panel([e1, e2], messages=messages)
    assert len(panel) == 2
    eids = {row["evidence_id"] for row in panel}
    assert eids == {"ev-booked-1", "ev-booked-2"}
    assert "ev-from-message" not in eids
    assert "noise" not in eids
