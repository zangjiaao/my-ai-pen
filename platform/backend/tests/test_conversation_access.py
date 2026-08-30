"""JWT actor must own the Case — no cross-user Workset/Scope mutation."""
import asyncio
import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import WebSocketDisconnect

from app.services.conversation_access import actor_owns_case, conversation_for_update_stmt
from app.ws.router import (
    _maybe_persist_authorized_host_scope,
    _remember_conversation_task,
    _remembered_task_scope,
    conversation_subscribers,
    websocket_endpoint,
)


def test_owner_jwt_owns_case():
    owner = uuid.uuid4()
    assert actor_owns_case(owner, str(owner)) is True


def test_other_jwt_does_not_own_case():
    owner = uuid.uuid4()
    assert actor_owns_case(owner, str(uuid.uuid4())) is False


def test_missing_owner_or_client_is_denied():
    owner = uuid.uuid4()
    assert actor_owns_case(None, str(owner)) is False
    assert actor_owns_case(owner, "") is False
    assert actor_owns_case(owner, "not-a-uuid") is False


def test_conversation_context_write_takes_row_lock():
    from sqlalchemy.dialects import postgresql

    cid = uuid.uuid4()
    sql = str(
        conversation_for_update_stmt(cid).compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    ).upper()
    assert "FOR UPDATE" in sql
    assert "CONVERSATIONS" in sql


def test_ws_user_decision_persist_rejects_non_owner_without_mutating_workset():
    """WS user_decision persist must not admit another user's Case Workset."""
    owner = uuid.uuid4()
    other = uuid.uuid4()
    conv_id = uuid.uuid4()
    host_id = str(uuid.uuid4())
    conv = SimpleNamespace(
        id=conv_id,
        user_id=owner,
        context={
            "task": {"scope": {}},
            "workset": {"items": [{"id": "ws_www", "status": "proposed", "host": "www.example.com"}]},
        },
    )

    class _Result:
        def scalar_one_or_none(self):
            return conv

        def scalars(self):
            class _Rows:
                def all(self):
                    return []

            return _Rows()

    class _Db:
        async def execute(self, *_a, **_k):
            return _Result()

        async def commit(self):
            raise AssertionError("non-owner must not commit Case context")

    class _Session:
        async def __aenter__(self):
            return _Db()

        async def __aexit__(self, *_a):
            return False

    async def _fake_admit(*_a, **_k):
        conv.context["workset"]["items"][0]["status"] = "adopted"
        return {
            "context": conv.context,
            "adopted_t_host_ids": ["ws_www"],
            "admission_ambiguous": [],
        }

    with (
        patch("app.ws.router._conversation_owner", new=AsyncMock(return_value=(owner, None))),
        patch("app.db.base.async_session", lambda: _Session()),
        patch("app.services.case_workset.resolve_and_admit_workset_hosts", new=AsyncMock(side_effect=_fake_admit)),
    ):
        out = asyncio.run(
            _maybe_persist_authorized_host_scope(
                str(conv_id),
                actor_user_id=str(other),
                decision="authorize",
                card={"kind": "confirm", "asset_ids": [host_id]},
                selected_option_ids=["authorize"],
                workset_item_ids=["ws_www"],
            )
        )

    assert out["adopted_t_host_ids"] == []
    assert out["scope"] == {}
    assert out["admission_ambiguous"] == []
    assert conv.context["workset"]["items"][0]["status"] == "proposed"


class _FakeWs:
    def __init__(self, frames: list[str]):
        self._frames = list(frames)
        self.client = None

    async def accept(self):
        return None

    async def receive_text(self):
        if not self._frames:
            raise WebSocketDisconnect()
        return self._frames.pop(0)


def test_ws_endpoint_drops_non_owner_user_decision():
    """websocket_endpoint must skip user frames when JWT is not the Case owner."""
    owner = uuid.uuid4()
    other = uuid.uuid4()
    conv_id = str(uuid.uuid4())
    ws = _FakeWs(
        [
            json.dumps(
                {
                    "type": "user_decision",
                    "conversation_id": conv_id,
                    "request_id": "r-foreign",
                    "decision": "authorize",
                    "selected_option_ids": ["authorize"],
                }
            )
        ]
    )
    save = AsyncMock()
    persist = AsyncMock()
    with (
        patch("jwt.decode", return_value={"sub": str(other)}),
        patch("app.ws.router._conversation_owner", new=AsyncMock(return_value=(owner, None))),
        patch("app.ws.router._save_message", new=save),
        patch("app.ws.router._maybe_persist_authorized_host_scope", new=persist),
    ):
        asyncio.run(websocket_endpoint(ws, token="user-jwt"))

    save.assert_not_called()
    persist.assert_not_called()
    assert conv_id not in conversation_subscribers or ws not in conversation_subscribers.get(conv_id, set())


def test_remembered_task_scope_persisted_wins_over_stale_incoming():
    persisted = {"allow": ["example.com", "www.example.com"], "asset_ids": ["aid-www"]}
    incoming = {"allow": ["example.com"]}
    got = _remembered_task_scope(persisted, incoming)
    assert got["allow"] == ["example.com", "www.example.com"]
    assert got["asset_ids"] == ["aid-www"]
    assert _remembered_task_scope(None, incoming) == incoming
    assert _remembered_task_scope(persisted, {})["allow"] == ["example.com", "www.example.com"]


def test_remember_conversation_task_row_lock_does_not_clobber_admitted_scope():
    """Dispatch remember must FOR UPDATE and keep live Workset/Scope over stale envelope."""
    conv_id = uuid.uuid4()
    conv = SimpleNamespace(
        id=conv_id,
        context={
            "task": {
                "instruction": "recon",
                "scope": {
                    "allow": ["example.com", "www.example.com"],
                    "asset_ids": ["aid-www"],
                },
            },
            "workset": {
                "items": [{"id": "ws_www", "status": "adopted", "host": "www.example.com"}]
            },
        },
    )
    executed = []

    class _Result:
        def scalar_one_or_none(self):
            return conv

    class _Db:
        async def execute(self, stmt):
            executed.append(stmt)
            return _Result()

        async def commit(self):
            return None

    class _Session:
        async def __aenter__(self):
            return _Db()

        async def __aexit__(self, *_a):
            return False

    with patch("app.db.base.async_session", lambda: _Session()):
        asyncio.run(
            _remember_conversation_task(
                str(conv_id),
                target={},
                scope={"allow": ["example.com"]},
                instruction="继续",
            )
        )

    from sqlalchemy.dialects import postgresql

    sql = str(
        executed[0].compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
    ).upper()
    assert "FOR UPDATE" in sql
    assert conv.context["task"]["scope"]["allow"] == ["example.com", "www.example.com"]
    assert conv.context["task"]["scope"]["asset_ids"] == ["aid-www"]
    assert conv.context["workset"]["items"][0]["status"] == "adopted"
    assert conv.context["task"]["instruction"] == "继续"
