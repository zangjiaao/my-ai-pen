"""Temporary backend runner for MVP Alpha browser smoke.

It starts the real FastAPI app with a seeded SQLite database so the frontend can
exercise login, REST, and WebSocket flows without local Postgres.
"""
from __future__ import annotations

import asyncio
import bcrypt
import hashlib
import os
import sys
import uuid
from pathlib import Path

from sqlalchemy import JSON, String
from sqlalchemy.dialects.postgresql import ARRAY, INET, JSONB, UUID
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.pool import NullPool

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform" / "backend"))

from app.db.base import Base  # noqa: E402
from app.models.asset import Asset  # noqa: E402
from app.models.evidence import Evidence  # noqa: E402
from app.models.node import Node  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.vulnerability import Vulnerability  # noqa: E402


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


async def prepare_db(db_path: Path) -> None:
    _patch_sqlite_column_types()
    engine = create_async_engine(URL.create("sqlite+aiosqlite", database=str(db_path)), poolclass=NullPool)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    password_hash = bcrypt.hashpw(b"alpha-password", bcrypt.gensalt()).decode()
    node_token = "alpha-node-token"
    async with sessionmaker() as db:
        db.add(User(
            id=uuid.UUID("11111111-1111-4111-8111-111111111111"),
            email="alpha@example.local",
            password_hash=password_hash,
            role="admin",
        ))
        db.add(Node(
            id=uuid.UUID("22222222-2222-4222-8222-222222222222"),
            name="alpha-node",
            type="pentest",
            status="offline",
            token_hash=hashlib.sha256(node_token.encode()).hexdigest(),
        ))
        await db.commit()
    await engine.dispose()


async def main() -> None:
    db_path = Path(os.environ.get("ALPHA_BROWSER_DB", str(ROOT / ".alpha" / "alpha-browser.db")))
    db_path.parent.mkdir(parents=True, exist_ok=True)
    await prepare_db(db_path)

    import app.db.base as db_base
    from app.ws import router as ws_router

    engine = create_async_engine(URL.create("sqlite+aiosqlite", database=str(db_path)), poolclass=NullPool)
    db_base.engine = engine
    db_base.async_session = async_sessionmaker(engine, expire_on_commit=False)
    ws_router.node_connections.clear()
    ws_router.conversation_subscribers.clear()
    ws_router.conversation_node.clear()
    ws_router.pending_approvals.clear()

    import uvicorn

    port = int(os.environ.get("ALPHA_BROWSER_PORT", "8010"))
    config = uvicorn.Config("app.main:app", host="127.0.0.1", port=port, log_level="warning", reload=False)
    server = uvicorn.Server(config)
    try:
        await server.serve()
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())