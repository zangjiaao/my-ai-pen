"""Regression smoke for long conversation recovery.

Verifies that a conversation with findings after the first 200 messages can be
recovered from `/messages` pagination and `/state` message-derived read models.
"""
from __future__ import annotations

import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform" / "backend"))

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import JSON, String  # noqa: E402
from sqlalchemy.dialects.postgresql import ARRAY, INET, JSONB, UUID  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.ext.compiler import compiles  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from app.api.auth import _create_token  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.main import app  # noqa: E402
from app.models.asset import Asset  # noqa: E402
from app.models.conversation import Conversation  # noqa: E402
from app.models.evidence import Evidence  # noqa: E402
from app.models.message import Message  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.vulnerability import Vulnerability  # noqa: E402
from app.services.conversation_snapshot import build_conversation_snapshot  # noqa: E402


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

    user = User(id=uuid.uuid4(), email="session-recovery@example.local", role="admin")
    conv = Conversation(id=uuid.uuid4(), user_id=user.id, status="completed")
    base_time = datetime(2026, 1, 1, tzinfo=timezone.utc)
    order_index = 0

    def msg(*, role: str, msg_type: str, content: dict) -> Message:
        nonlocal order_index
        item = Message(
            id=uuid.uuid4(),
            conversation_id=conv.id,
            role=role,
            msg_type=msg_type,
            content=content,
            created_at=base_time + timedelta(seconds=order_index),
        )
        order_index += 1
        return item

    messages = [
        msg(role="user", msg_type="text", content={"text": "test https://example.com"}),
        msg(role="agent", msg_type="status", content={"text": "Phase: scan (iter 1)", "phase": "scan"}),
    ]
    for index in range(1200):
        messages.append(msg(
            role="agent",
            msg_type="tool_call",
            content={"tool_name": "curl", "tool_run_id": f"tool-{index}", "status": "done", "stdout": f"line {index}"},
        ))
    messages.extend([
        msg(role="agent", msg_type="asset_discovered", content={
            "type": "asset_discovered",
            "conversation_id": str(conv.id),
            "address": "https://example.com",
            "asset_type": "web",
            "open_ports": [443],
        }),
        msg(role="agent", msg_type="vuln_found", content={
            "type": "vuln_found",
            "conversation_id": str(conv.id),
            "title": "Late recovered finding",
            "severity": "high",
            "affected_asset": "https://example.com",
            "location": "/late",
            "evidence_ids": ["ev-late"],
        }),
        msg(role="agent", msg_type="evidence_created", content={
            "type": "evidence_created",
            "conversation_id": str(conv.id),
            "evidence_id": "ev-late",
            "source_tool": "curl",
            "summary": "late evidence",
        }),
        Message(id=uuid.uuid4(), conversation_id=conv.id, role="agent", msg_type="text", content={"text": "## Final report\n\nLate recovered finding"}),
        Message(id=uuid.uuid4(), conversation_id=conv.id, role="agent", msg_type="status", content={"text": "任务完成", "summary": {"ok": True}}),
    ])

    async with sessionmaker() as db:
        db.add(user)
        db.add(conv)
        db.add_all(messages)
        db.add(Asset(
            id=uuid.uuid4(),
            user_id=user.id,
            conversation_id=conv.id,
            name="example.com",
            address="https://example.com",
            type="web",
            source="agent_discovered",
            properties={"open_ports": [443]},
        ))
        db.add(Vulnerability(
            id=uuid.uuid4(),
            user_id=user.id,
            title="Late recovered finding",
            severity="high",
            asset_id=None,
            conversation_id=conv.id,
            description="from read model",
            poc="/late",
            confidence="high",
            status="confirmed",
            evidence_ids=["ev-late"],
        ))
        db.add(Evidence(
            id=uuid.uuid4(),
            evidence_id="ev-late",
            user_id=user.id,
            conversation_id=conv.id,
            type="tool_output",
            source_tool="curl",
            summary="late evidence from read model",
            properties={},
        ))
        await db.commit()
    return engine, sessionmaker, user, conv


def main() -> None:
    import app.db.base as db_base

    original_session = db_base.async_session
    with tempfile.TemporaryDirectory() as tmp:
        with TestClient(app) as client:
            engine, sessionmaker, user, conv = client.portal.call(_setup_db, Path(tmp) / "session-recovery.db")
            db_base.async_session = sessionmaker
            try:
                token = _create_token(user, 3600)
                headers = {"Authorization": f"Bearer {token}"}
                first = client.get(f"/api/conversations/{conv.id}/messages?limit=1000&offset=0&order=desc", headers=headers)
                assert first.status_code == 200, first.text
                latest_payload = first.json()
                assert len(latest_payload) == 1000
                assert any(m["msg_type"] == "vuln_found" and m["content"]["title"] == "Late recovered finding" for m in latest_payload)
                assert any(m["msg_type"] == "text" and "Final report" in m["content"]["text"] for m in latest_payload)
                second = client.get(f"/api/conversations/{conv.id}/messages?limit=1000&offset=1000&order=desc", headers=headers)
                assert second.status_code == 200, second.text
                older_payload = second.json()
                assert 200 < len(older_payload) < 1000
                assert not any(m["msg_type"] == "vuln_found" and m["content"]["title"] == "Late recovered finding" for m in older_payload)

                state = client.get(f"/api/conversations/{conv.id}/state", headers=headers)
                assert state.status_code == 200, state.text
                state_data = state.json()
                assert state_data["counts"]["findings"] == 1, state_data
                assert state_data["counts"]["assets"] == 1, state_data
                assert state_data["counts"]["evidence"] >= 1, state_data
                assert state_data["findings"][0]["status"] == "confirmed", state_data
                assert any(e["evidence_id"] == "ev-late" for e in state_data["evidence"]), state_data
                assert state_data["progress"] == {"current": 6, "total": 6, "percent": 100}
                assert state_data["progress"]["current"] <= state_data["progress"]["total"], state_data

                async def snapshot_direct():
                    async with sessionmaker() as db:
                        fresh = await db.get(Conversation, conv.id)
                        return await build_conversation_snapshot(db, fresh, user.id)

                direct_state = client.portal.call(snapshot_direct)
                assert direct_state["counts"] == state_data["counts"]
                assert direct_state["findings"] == state_data["findings"]

                delete_response = client.delete(f"/api/conversations/{conv.id}", headers=headers)
                assert delete_response.status_code == 200, delete_response.text
                listed = client.get("/api/conversations", headers=headers)
                assert listed.status_code == 200, listed.text
                assert all(item["id"] != str(conv.id) for item in listed.json()), listed.json()
                deleted_state = client.get(f"/api/conversations/{conv.id}/state", headers=headers)
                assert deleted_state.status_code == 404, deleted_state.text
                print("session recovery smoke ok")
            finally:
                db_base.async_session = original_session
                client.portal.call(engine.dispose)


if __name__ == "__main__":
    main()
