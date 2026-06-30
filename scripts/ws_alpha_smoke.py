"""MVP Alpha WebSocket smoke for the real platform routing endpoint.

This uses FastAPI TestClient against app.main, a temporary SQLite database, and
real JWT/node-token authentication. It verifies the single-node loop at the
WebSocket protocol level without starting Docker or an external server.
"""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform" / "backend"))

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import JSON, String, select  # noqa: E402
from sqlalchemy.dialects.postgresql import ARRAY, INET, JSONB, UUID  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402
from sqlalchemy.ext.compiler import compiles  # noqa: E402

from app.api.auth import _create_token  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.main import app  # noqa: E402
from app.models.asset import Asset  # noqa: E402
from app.models.audit import AuditLog  # noqa: E402
from app.models.conversation import Conversation  # noqa: E402
from app.models.evidence import Evidence  # noqa: E402
from app.models.message import Message  # noqa: E402
from app.models.node import Node  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.vulnerability import Vulnerability  # noqa: E402
from app.ws import router as ws_router  # noqa: E402


@compiles(INET, "sqlite")
def _compile_inet_sqlite(type_, compiler, **kw):
    return "TEXT"


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(type_, compiler, **kw):
    return compiler.visit_JSON(JSON(), **kw)


@compiles(ARRAY, "sqlite")
def _compile_array_sqlite(type_, compiler, **kw):
    return compiler.visit_JSON(JSON(), **kw)


@compiles(UUID, "sqlite")
def _compile_uuid_sqlite(type_, compiler, **kw):
    return compiler.visit_string(String(36), **kw)


def _patch_sqlite_column_types() -> None:
    Asset.__table__.c.tags.type = JSON()
    Vulnerability.__table__.c.evidence_ids.type = JSON()
    Evidence.__table__.c.properties.type = JSON()


async def _setup_db(db_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}", poolclass=NullPool)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    _patch_sqlite_column_types()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    user = User(id=uuid.uuid4(), email="ws-alpha@example.local", role="admin")
    conv = Conversation(id=uuid.uuid4(), user_id=user.id, status="created")
    async with sessionmaker() as db:
        db.add_all([user, conv])
        await db.commit()
    return engine, sessionmaker, user, conv


async def _assert_db_state(sessionmaker, user_id: uuid.UUID, node_id: uuid.UUID, conv_id: uuid.UUID) -> None:
    async with sessionmaker() as db:
        conv = (await db.execute(select(Conversation).where(Conversation.id == conv_id))).scalar_one()
        assert conv.node_id == node_id
        assert conv.status == "completed"

        messages = (await db.execute(select(Message).where(Message.conversation_id == conv_id))).scalars().all()
        assert {m.msg_type for m in messages} >= {"text", "tool_call", "confirm_card", "decision", "status"}
        status_messages = [m for m in messages if m.msg_type == "status" and isinstance(m.content, dict)]
        assert any((m.content.get("intake_result") or {}).get("target") == "https://example.com/" for m in status_messages)

        asset = (await db.execute(select(Asset).where(Asset.user_id == user_id))).scalar_one()
        assert asset.conversation_id == conv_id
        assert asset.node_id == node_id

        vuln = (await db.execute(select(Vulnerability).where(Vulnerability.user_id == user_id))).scalar_one()
        assert vuln.conversation_id == conv_id
        assert vuln.node_id == node_id
        assert vuln.asset_id == asset.id

        evidence_rows = (await db.execute(select(Evidence).where(Evidence.user_id == user_id))).scalars().all()
        assert any(e.conversation_id == conv_id and e.node_id == node_id and e.source_tool == "curl" for e in evidence_rows)
        placeholder = next(e for e in evidence_rows if e.evidence_id == "ev-ws-alpha")
        assert placeholder.source_tool == "finding_reference"
        assert placeholder.properties.get("placeholder") is True

        audits = (await db.execute(select(AuditLog))).scalars().all()
        audit_actions = {a.action for a in audits}
        assert audit_actions >= {
            "node.online",
            "task.assign",
            "asset.discover",
            "finding.create",
            "evidence.create",
            "tool.execute",
            "approval.request",
            "approval.authorize",
        }, audit_actions
        tool_audits = [a for a in audits if a.action == "tool.execute"]
        assert any(a.status == "success" and a.detail["tool_name"] == "curl" for a in tool_audits)
        assert any(a.status == "failed" and a.detail["tool_name"] == "curl" for a in tool_audits)


def _recv_until(ws, expected_type: str, limit: int = 12) -> dict:
    for _ in range(limit):
        msg = json.loads(ws.receive_text())
        if msg.get("type") == expected_type:
            return msg
    raise AssertionError(f"did not receive {expected_type}")


def _clear_ws_state() -> None:
    ws_router.node_connections.clear()
    ws_router.conversation_subscribers.clear()
    ws_router.conversation_node.clear()
    ws_router.pending_approvals.clear()


def main() -> None:
    _clear_ws_state()
    with tempfile.TemporaryDirectory() as tmp:
        import app.db.base as db_base

        original_session = db_base.async_session
        with TestClient(app) as client:
            engine, sessionmaker, user, conv = client.portal.call(_setup_db, Path(tmp) / "ws-alpha.db")
            db_base.async_session = sessionmaker
            try:
                user_token = _create_token(user, 3600)
                register_res = client.post(
                    "/api/nodes",
                    json={"name": "ws-alpha-node", "type": "pentest"},
                    headers={"Authorization": f"Bearer {user_token}"},
                )
                assert register_res.status_code == 200, register_res.text
                registered_node = register_res.json()
                node_id = uuid.UUID(registered_node["id"])
                node_token = registered_node["token"]
                with client.websocket_connect(f"/ws?token={node_token}") as node_ws:
                    with client.websocket_connect(f"/ws?token={user_token}") as user_ws:
                        user_ws.send_text(json.dumps({
                            "type": "user_message",
                            "conversation_id": str(conv.id),
                            "text": "test https://example.com",
                            "target": {"type": "url", "value": "https://example.com"},
                            "scope": {"allow": ["example.com"], "deny": []},
                        }))

                        task_assign = _recv_until(node_ws, "task_assign")
                        assert task_assign["conversation_id"] == str(conv.id)
                        assert task_assign["scope"]["allow"] == ["example.com"]

                        steer_res = client.post(
                            f"/api/conversations/{conv.id}/steer",
                            json={"text": "focus on response headers"},
                            headers={"Authorization": f"Bearer {user_token}"},
                        )
                        assert steer_res.status_code == 200, steer_res.text
                        steer_msg = _recv_until(node_ws, "user_steer")
                        assert steer_msg["conversation_id"] == str(conv.id)
                        assert steer_msg["text"] == "focus on response headers"

                        node_ws.send_text(json.dumps({
                            "type": "status_update",
                            "conversation_id": str(conv.id),
                            "phase": "recon",
                            "iteration": 1,
                            "active_tool": "intake",
                            "status": "done",
                            "intake_result": {"ok": True, "target": "https://example.com/", "dns_addresses": ["93.184.216.34"], "connectivity": {"checked": True, "ok": True, "host": "example.com", "port": 443}},
                        }))
                        status_update = _recv_until(user_ws, "status_update")
                        assert status_update["phase"] == "recon"
                        assert status_update["intake_result"]["connectivity"]["ok"] is True

                        node_ws.send_text(json.dumps({
                            "type": "tool_output",
                            "conversation_id": str(conv.id),
                            "tool_name": "curl",
                            "tool_run_id": "tool-ws-alpha",
                            "line": "HTTP/1.1 200 OK",
                            "status": "done",
                        }))
                        assert _recv_until(user_ws, "tool_output")["tool_name"] == "curl"

                        node_ws.send_text(json.dumps({
                            "type": "tool_output",
                            "conversation_id": str(conv.id),
                            "tool_name": "curl",
                            "tool_run_id": "tool-ws-failed",
                            "line": "curl: connection failed",
                            "status": "failed",
                        }))
                        assert _recv_until(user_ws, "tool_output")["status"] == "failed"

                        node_ws.send_text(json.dumps({
                            "type": "asset_discovered",
                            "conversation_id": str(conv.id),
                            "address": "https://example.com",
                            "asset_type": "web",
                            "open_ports": [443],
                            "services": [{"port": 443, "name": "https"}],
                        }))
                        assert _recv_until(user_ws, "asset_discovered")["address"] == "https://example.com"

                        node_ws.send_text(json.dumps({
                            "type": "vuln_found",
                            "conversation_id": str(conv.id),
                            "title": "WS Alpha finding",
                            "severity": "low",
                            "confidence": 0.7,
                            "affected_asset": "https://example.com",
                            "location": "/headers",
                            "evidence_ids": ["ev-ws-alpha"],
                        }))
                        assert _recv_until(user_ws, "vuln_found")["title"] == "WS Alpha finding"

                        node_ws.send_text(json.dumps({
                            "type": "request_decision",
                            "conversation_id": str(conv.id),
                            "request_id": "req-ws-alpha",
                            "risk_level": "destructive",
                            "question": "Allow dump?",
                            "proposed_action": "sqlmap --dump",
                        }))
                        decision = _recv_until(user_ws, "request_decision")
                        assert decision["request_id"] == "req-ws-alpha"

                        user_ws.send_text(json.dumps({
                            "type": "user_decision",
                            "conversation_id": str(conv.id),
                            "request_id": "req-ws-alpha",
                            "decision": "authorize",
                        }))
                        user_input = _recv_until(node_ws, "user_input")
                        assert user_input["response"] == "authorize"

                        node_ws.send_text(json.dumps({
                            "type": "task_complete",
                            "conversation_id": str(conv.id),
                            "status": "completed",
                            "summary": {"ok": True},
                        }))
                        assert _recv_until(user_ws, "task_complete")["status"] == "completed"

                time.sleep(0.1)
                client.portal.call(_assert_db_state, sessionmaker, user.id, node_id, conv.id)
                print("ws alpha smoke ok")
            finally:
                db_base.async_session = original_session
                client.portal.call(engine.dispose)
                _clear_ws_state()


if __name__ == "__main__":
    main()