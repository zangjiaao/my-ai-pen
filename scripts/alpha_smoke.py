"""MVP Alpha smoke checks for the platform-side single-node loop.

This script intentionally avoids external services. It uses a temporary SQLite
DB and directly exercises the persistence/routing helpers that the WebSocket
path uses at runtime.
"""
from __future__ import annotations

import asyncio
import tempfile
import uuid
from pathlib import Path

from sqlalchemy import JSON, String, select
from sqlalchemy.dialects.postgresql import ARRAY, INET, JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform" / "backend"))

from app.db.base import Base  # noqa: E402
from app.models.asset import Asset  # noqa: E402
from app.models.audit import AuditLog  # noqa: E402
from app.models.conversation import Conversation  # noqa: E402
from app.models.evidence import Evidence  # noqa: E402
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
    """Use SQLite-compatible bind processors for PostgreSQL-only columns."""
    Asset.__table__.c.tags.type = JSON()
    Vulnerability.__table__.c.evidence_ids.type = JSON()
    Evidence.__table__.c.properties.type = JSON()


async def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "alpha-smoke.db"
        engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)

        _patch_sqlite_column_types()
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        # Patch router session factory so helper functions operate on this DB.
        import app.db.base as db_base
        original_session = db_base.async_session
        db_base.async_session = sessionmaker
        try:
            user_id = uuid.uuid4()
            node_id = uuid.uuid4()
            conv_id = uuid.uuid4()

            async with sessionmaker() as db:
                db.add(User(id=user_id, email="alpha@example.local", role="admin"))
                db.add(Node(id=node_id, name="alpha-node", type="pentest", status="offline"))
                db.add(Conversation(id=conv_id, user_id=user_id, node_id=node_id, status="created"))
                await db.commit()

            await ws_router._bind_conversation_to_node(str(conv_id), str(node_id))
            owner, bound_node = await ws_router._conversation_owner(str(conv_id))
            assert owner == user_id
            assert bound_node == node_id

            await ws_router._persist_asset({
                "type": "asset_discovered",
                "conversation_id": str(conv_id),
                "address": "127.0.0.1",
                "asset_type": "host",
                "open_ports": [80],
                "services": [{"port": 80, "name": "http"}],
            }, str(node_id))

            await ws_router._persist_vulnerability({
                "type": "vuln_found",
                "conversation_id": str(conv_id),
                "title": "Alpha test finding",
                "severity": "medium",
                "confidence": 0.8,
                "affected_asset": "127.0.0.1",
                "location": "/alpha",
            }, str(node_id))

            await ws_router._persist_evidence({
                "type": "tool_output",
                "conversation_id": str(conv_id),
                "tool_name": "curl",
                "tool_run_id": "tool-alpha",
                "line": "HTTP/1.1 200 OK",
                "status": "done",
            }, str(node_id))

            await ws_router._save_message({
                "type": "request_decision",
                "conversation_id": str(conv_id),
                "request_id": "req-alpha",
                "risk_level": "destructive",
                "question": "Allow alpha command?",
                "proposed_action": "sqlmap --dump",
            }, "agent")

            async with sessionmaker() as db:
                conv = (await db.execute(select(Conversation).where(Conversation.id == conv_id))).scalar_one()
                assert conv.status == "running"
                asset = (await db.execute(select(Asset).where(Asset.user_id == user_id))).scalar_one()
                assert asset.address == "127.0.0.1"
                vuln = (await db.execute(select(Vulnerability).where(Vulnerability.user_id == user_id))).scalar_one()
                assert vuln.title == "Alpha test finding"
                assert vuln.asset_id == asset.id
                evidence = (await db.execute(select(Evidence).where(Evidence.user_id == user_id))).scalar_one()
                assert evidence.source_tool == "curl"
                audits = (await db.execute(select(AuditLog))).scalars().all()
                assert {a.action for a in audits} >= {"task.assign", "asset.discover", "finding.create", "evidence.create"}

            print("alpha smoke ok")
        finally:
            db_base.async_session = original_session
            await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
