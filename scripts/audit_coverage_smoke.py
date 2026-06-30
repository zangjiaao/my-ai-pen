"""P1 audit coverage smoke.

Uses a temporary SQLite DB and FastAPI TestClient to verify audit events for
login, conversation CRUD, asset CRUD, vulnerability status/retest, and audit
list permission filtering.
"""
from __future__ import annotations

import sys
import tempfile
import uuid
from pathlib import Path

import bcrypt
from fastapi.testclient import TestClient
from sqlalchemy import JSON, String
from sqlalchemy.dialects.postgresql import ARRAY, INET, JSONB, UUID
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.pool import NullPool

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform" / "backend"))

from app.db.base import Base  # noqa: E402
from app.main import app  # noqa: E402
from app.models.asset import Asset  # noqa: E402
from app.models.audit import AuditLog  # noqa: E402
from app.models.conversation import Conversation  # noqa: E402
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
    AuditLog.__table__.c.detail.type = JSON()


async def _setup_db(db_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}", poolclass=NullPool)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    _patch_sqlite_column_types()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    password_hash = bcrypt.hashpw(b"alpha-password", bcrypt.gensalt()).decode()
    user = User(id=uuid.uuid4(), email="audit@example.local", role="user", password_hash=password_hash)
    other = User(id=uuid.uuid4(), email="other-audit@example.local", role="user", password_hash=password_hash)
    admin = User(id=uuid.uuid4(), email="admin-audit@example.local", role="admin", password_hash=password_hash)
    async with sessionmaker() as db:
        db.add_all([user, other, admin])
        await db.commit()
    return engine, sessionmaker, user, other, admin


def _auth(client: TestClient, email: str) -> dict[str, str]:
    res = client.post("/api/auth/login", json={"email": email, "password": "alpha-password"})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def _actions(client: TestClient, headers: dict[str, str]) -> set[str]:
    res = client.get("/api/audit?limit=200", headers=headers)
    assert res.status_code == 200, res.text
    return {row["action"] for row in res.json()}


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        import app.db.base as db_base

        original_session = db_base.async_session
        with TestClient(app) as client:
            engine, sessionmaker, user, other, admin = client.portal.call(_setup_db, Path(tmp) / "audit.db")
            db_base.async_session = sessionmaker
            try:
                user_headers = _auth(client, user.email)
                other_headers = _auth(client, other.email)
                admin_headers = _auth(client, admin.email)

                bad = client.post("/api/auth/login", json={"email": user.email, "password": "bad"})
                assert bad.status_code == 401

                conv = client.post("/api/conversations", headers=user_headers)
                assert conv.status_code == 200, conv.text
                conv_id = conv.json()["id"]
                patch = client.patch(f"/api/conversations/{conv_id}", headers=user_headers, json={"title": "Audit smoke"})
                assert patch.status_code == 200, patch.text

                asset = client.post("/api/assets", headers=user_headers, json={"name": "Audit asset", "address": "https://audit.example", "type": "web", "tags": [], "properties": {}})
                assert asset.status_code == 200, asset.text
                asset_id = asset.json()["id"]
                update_asset = client.patch(f"/api/assets/{asset_id}", headers=user_headers, json={"tags": ["audit"]})
                assert update_asset.status_code == 200, update_asset.text

                async def create_vuln():
                    async with sessionmaker() as db:
                        vuln = Vulnerability(
                            id=uuid.uuid4(),
                            user_id=user.id,
                            conversation_id=uuid.UUID(conv_id),
                            asset_id=uuid.UUID(asset_id),
                            title="Audit vuln",
                            severity="low",
                            confidence="medium",
                            status="pending",
                            evidence_ids=[],
                        )
                        db.add(vuln)
                        await db.commit()
                        return vuln.id

                vuln_id = client.portal.call(create_vuln)
                vuln_patch = client.patch(f"/api/vulnerabilities/{vuln_id}", headers=user_headers, json={"status": "confirmed"})
                assert vuln_patch.status_code == 200, vuln_patch.text
                retest = client.post(f"/api/vulnerabilities/{vuln_id}/retest", headers=user_headers)
                assert retest.status_code == 200, retest.text

                delete_asset = client.delete(f"/api/assets/{asset_id}", headers=user_headers)
                assert delete_asset.status_code == 200, delete_asset.text
                delete_conv = client.delete(f"/api/conversations/{conv_id}", headers=user_headers)
                assert delete_conv.status_code == 200, delete_conv.text

                user_actions = _actions(client, user_headers)
                expected = {
                    "auth.login",
                    "conversation.create",
                    "conversation.update",
                    "conversation.delete",
                    "asset.create",
                    "asset.update",
                    "asset.delete",
                    "vulnerability.update",
                    "vuln.retest",
                }
                assert expected <= user_actions, user_actions

                other_actions = _actions(client, other_headers)
                assert "asset.create" not in other_actions
                assert "conversation.create" not in other_actions

                admin_actions = _actions(client, admin_headers)
                assert expected <= admin_actions, admin_actions
                failed_login = client.get("/api/audit?action=auth.login&limit=200", headers=admin_headers)
                assert failed_login.status_code == 200, failed_login.text
                assert any(row["status"] == "failed" for row in failed_login.json())

                print("audit coverage smoke ok")
            finally:
                db_base.async_session = original_session
                client.portal.call(engine.dispose)


if __name__ == "__main__":
    main()
