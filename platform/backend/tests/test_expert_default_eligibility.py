import asyncio
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.api.experts import ExpertUpdate, update_expert
from app.models.expert import Expert
from app.models.node import Node
from app.services.expert_instances import validate_default_expert_eligibility


def test_default_expert_requires_enabled_online_binding():
    validate_default_expert_eligibility(enabled=True, node_status="online")


@pytest.mark.parametrize(
    ("enabled", "node_status"),
    [
        (False, "online"),
        (True, "offline"),
        (True, None),
        (True, ""),
    ],
)
def test_default_expert_rejects_unschedulable_binding(enabled, node_status):
    with pytest.raises(ValueError, match="default conversation partner"):
        validate_default_expert_eligibility(
            enabled=enabled,
            node_status=node_status,
        )


class _ConcurrentExpertSession:
    def __init__(self, shared, target_id):
        self.shared = shared
        self.target_id = target_id
        self.lock_held = False

    async def execute(self, statement):
        if getattr(statement, "is_select", False) and statement._for_update_arg is not None:
            await self.shared["lock"].acquire()
            self.lock_held = True
        elif getattr(statement, "is_update", False):
            for expert_id, expert in self.shared["experts"].items():
                if expert_id != self.target_id:
                    expert.is_default = False
        await asyncio.sleep(0)
        return SimpleNamespace()

    async def get(self, model, object_id):
        await asyncio.sleep(0)
        if model is Expert:
            return self.shared["experts"].get(object_id)
        if model is Node:
            return self.shared["node"]
        return None

    def add(self, _value):
        return None

    async def commit(self):
        if self.lock_held:
            self.shared["lock"].release()
            self.lock_held = False

    async def rollback(self):
        if self.lock_held:
            self.shared["lock"].release()
            self.lock_held = False

    async def refresh(self, _value):
        return None


class _ConflictingExpertSession(_ConcurrentExpertSession):
    async def commit(self):
        await super().commit()
        raise IntegrityError(
            "UPDATE experts",
            {},
            Exception("uq_experts_single_default"),
        )


def test_concurrent_default_updates_leave_exactly_one_default():
    node_id = uuid.uuid4()
    first_id = uuid.uuid4()
    second_id = uuid.uuid4()
    shared = {
        "lock": asyncio.Lock(),
        "node": SimpleNamespace(
            id=node_id,
            name="worker",
            type="worker",
            status="online",
            config={},
        ),
        "experts": {
            first_id: SimpleNamespace(
                id=first_id,
                user_id=None,
                name="first",
                display_name="first",
                pack_id="default",
                node_id=node_id,
                description=None,
                color=None,
                enabled=True,
                is_default=False,
                created_at=None,
                updated_at=None,
            ),
            second_id: SimpleNamespace(
                id=second_id,
                user_id=None,
                name="second",
                display_name="second",
                pack_id="default",
                node_id=node_id,
                description=None,
                color=None,
                enabled=True,
                is_default=False,
                created_at=None,
                updated_at=None,
            ),
        },
    }
    current_user = {"user_id": str(uuid.uuid4())}

    async def run_updates():
        await asyncio.gather(
            update_expert(
                str(first_id),
                ExpertUpdate(is_default=True),
                current_user,
                _ConcurrentExpertSession(shared, first_id),
            ),
            update_expert(
                str(second_id),
                ExpertUpdate(is_default=True),
                current_user,
                _ConcurrentExpertSession(shared, second_id),
            ),
        )

    asyncio.run(run_updates())

    assert sum(expert.is_default for expert in shared["experts"].values()) == 1


def test_default_unique_conflict_returns_409():
    node_id = uuid.uuid4()
    expert_id = uuid.uuid4()
    shared = {
        "lock": asyncio.Lock(),
        "node": SimpleNamespace(
            id=node_id,
            name="worker",
            type="worker",
            status="online",
            config={},
        ),
        "experts": {
            expert_id: SimpleNamespace(
                id=expert_id,
                user_id=None,
                name="expert",
                display_name="expert",
                pack_id="default",
                node_id=node_id,
                description=None,
                color=None,
                enabled=True,
                is_default=False,
                created_at=None,
                updated_at=None,
            ),
        },
    }

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            update_expert(
                str(expert_id),
                ExpertUpdate(is_default=True),
                {"user_id": str(uuid.uuid4())},
                _ConflictingExpertSession(shared, expert_id),
            )
        )

    assert exc_info.value.status_code == 409


def test_expert_model_has_partial_unique_default_index():
    index = next(
        index
        for index in Expert.__table__.indexes
        if index.name == "uq_experts_single_default"
    )

    assert index.unique is True
    assert [column.name for column in index.columns] == ["is_default"]
    assert index.dialect_options["postgresql"]["where"] is not None
