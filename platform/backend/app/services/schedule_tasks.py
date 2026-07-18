"""Scheduled engagement tasks: pure schedule logic + in-process store for API/tests.

Dispatches structured task envelopes (explicit engagement) — no NLP of free text.
"""
from __future__ import annotations

import json
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class ScheduledTask:
    id: str
    user_id: str
    target: str
    scope: str
    engagement: str
    instruction: str
    interval_seconds: int
    node_id: str | None = None
    goal_mode: bool = True
    goal_objective: str | None = None
    enabled: bool = True
    next_fire_at: str | None = None
    last_fire_at: str | None = None
    last_task_id: str | None = None
    created_at: str = field(default_factory=lambda: utcnow().isoformat())

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def parse_interval_seconds(interval: str | int) -> int:
    """Parse '5m', '2h', '1d', or integer seconds. Minimum 60s."""
    if isinstance(interval, int):
        return max(60, interval)
    s = str(interval).strip().lower()
    if s.isdigit():
        return max(60, int(s))
    if s.endswith("s") and s[:-1].isdigit():
        return max(60, int(s[:-1]))
    if s.endswith("m") and s[:-1].isdigit():
        return max(60, int(s[:-1]) * 60)
    if s.endswith("h") and s[:-1].isdigit():
        return max(60, int(s[:-1]) * 3600)
    if s.endswith("d") and s[:-1].isdigit():
        return max(60, int(s[:-1]) * 86400)
    raise ValueError(f"invalid interval: {interval!r}")


def build_task_assign_envelope(schedule: ScheduledTask, *, task_id: str | None = None, conversation_id: str | None = None) -> dict[str, Any]:
    """Build a task_assign-shaped message with structured engagement only."""
    tid = task_id or str(uuid.uuid4())
    conv = conversation_id or str(uuid.uuid4())
    eng = (schedule.engagement or "pentest").strip() or "pentest"
    out: dict[str, Any] = {
        "type": "task_assign",
        "task_id": tid,
        "conversation_id": conv,
        "target": schedule.target,
        "scope": schedule.scope or schedule.target,
        "instruction": schedule.instruction,
        "engagement": eng,
        "role": eng,
        "goal_mode": bool(schedule.goal_mode),
        "schedule_id": schedule.id,
    }
    if schedule.goal_objective:
        out["goal_objective"] = schedule.goal_objective
    if schedule.node_id:
        out["node_id"] = schedule.node_id
    return out


def should_fire(schedule: ScheduledTask, now: datetime | None = None) -> bool:
    if not schedule.enabled:
        return False
    now = now or utcnow()
    if not schedule.next_fire_at:
        return True
    try:
        nxt = datetime.fromisoformat(schedule.next_fire_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    if nxt.tzinfo is None:
        nxt = nxt.replace(tzinfo=timezone.utc)
    return now >= nxt


def advance_next_fire(schedule: ScheduledTask, now: datetime | None = None) -> str:
    now = now or utcnow()
    nxt = now.timestamp() + max(60, int(schedule.interval_seconds))
    return datetime.fromtimestamp(nxt, tz=timezone.utc).isoformat()


class ScheduleStore:
    """Thread-safe JSON-file or memory store (tests use memory path)."""

    def __init__(self, path: Path | None = None):
        self._path = path
        self._lock = threading.Lock()
        self._items: dict[str, ScheduledTask] = {}
        if path and path.exists():
            self._load()

    def _load(self) -> None:
        assert self._path is not None
        data = json.loads(self._path.read_text(encoding="utf-8"))
        for row in data.get("schedules") or []:
            st = ScheduledTask(**{k: row[k] for k in ScheduledTask.__dataclass_fields__ if k in row})
            self._items[st.id] = st

    def _save(self) -> None:
        if not self._path:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"schedules": [s.to_dict() for s in self._items.values()]}
        self._path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def create(
        self,
        *,
        user_id: str,
        target: str,
        scope: str | None,
        engagement: str,
        instruction: str,
        interval: str | int,
        node_id: str | None = None,
        goal_mode: bool = True,
        goal_objective: str | None = None,
        fire_immediately: bool = False,
    ) -> ScheduledTask:
        sid = str(uuid.uuid4())
        interval_seconds = parse_interval_seconds(interval)
        now = utcnow()
        next_fire = now.isoformat() if fire_immediately else advance_next_fire(
            ScheduledTask(
                id=sid,
                user_id=user_id,
                target=target,
                scope=scope or target,
                engagement=engagement or "pentest",
                instruction=instruction,
                interval_seconds=interval_seconds,
            ),
            now,
        )
        # if not fire_immediately, advance_next_fire already adds interval from now
        if not fire_immediately:
            next_fire = advance_next_fire(
                ScheduledTask(
                    id=sid,
                    user_id=user_id,
                    target=target,
                    scope=scope or target,
                    engagement=engagement or "pentest",
                    instruction=instruction,
                    interval_seconds=interval_seconds,
                ),
                now,
            )
        st = ScheduledTask(
            id=sid,
            user_id=user_id,
            target=target,
            scope=scope or target,
            engagement=(engagement or "pentest").strip() or "pentest",
            instruction=instruction,
            interval_seconds=interval_seconds,
            node_id=node_id,
            goal_mode=goal_mode,
            goal_objective=goal_objective,
            next_fire_at=next_fire if not fire_immediately else now.isoformat(),
        )
        with self._lock:
            self._items[sid] = st
            self._save()
        return st

    def list_for_user(self, user_id: str) -> list[ScheduledTask]:
        with self._lock:
            return [s for s in self._items.values() if s.user_id == user_id]

    def get(self, schedule_id: str) -> ScheduledTask | None:
        with self._lock:
            return self._items.get(schedule_id)

    def delete(self, schedule_id: str, user_id: str | None = None) -> bool:
        with self._lock:
            st = self._items.get(schedule_id)
            if not st:
                return False
            if user_id is not None and st.user_id != user_id:
                return False
            del self._items[schedule_id]
            self._save()
            return True

    def set_enabled(
        self,
        schedule_id: str,
        *,
        user_id: str,
        enabled: bool,
    ) -> ScheduledTask | None:
        with self._lock:
            st = self._items.get(schedule_id)
            if not st or st.user_id != user_id:
                return None
            st.enabled = bool(enabled)
            self._items[schedule_id] = st
            self._save()
            return st

    def tick(
        self,
        now: datetime | None = None,
        *,
        user_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fire due schedules owned by user_id (or all if None); return task_assign envelopes.

        When user_id is set, only that user's due schedules advance next_fire_at —
        never advance other users' schedules as a side effect of a filtered response.
        """
        now = now or utcnow()
        fired: list[dict[str, Any]] = []
        with self._lock:
            for st in list(self._items.values()):
                if user_id is not None and st.user_id != user_id:
                    continue
                if not should_fire(st, now):
                    continue
                env = build_task_assign_envelope(st)
                st.last_fire_at = now.isoformat()
                st.last_task_id = env["task_id"]
                st.next_fire_at = advance_next_fire(st, now)
                self._items[st.id] = st
                fired.append(env)
            if fired:
                self._save()
        return fired


def materialize_schedule_fire(
    envelope: dict[str, Any],
    *,
    user_id: str,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    """Turn a task_assign envelope into a durable dispatch record (conversation-shaped).

    Pure helper for API/tests: returns the record that should be persisted (conversation
    context + audit detail + node message). Caller writes DB / WS.
    """
    conv_id = conversation_id or str(envelope.get("conversation_id") or uuid.uuid4())
    task_id = str(envelope.get("task_id") or uuid.uuid4())
    eng = str(envelope.get("engagement") or envelope.get("role") or "pentest")
    task_blob = {
        "task_id": task_id,
        "target": envelope.get("target"),
        "scope": envelope.get("scope") or envelope.get("target"),
        "instruction": envelope.get("instruction"),
        "engagement": eng,
        "role": eng,
        "goal_mode": bool(envelope.get("goal_mode", True)),
        "schedule_id": envelope.get("schedule_id"),
    }
    if envelope.get("goal_objective"):
        task_blob["goal_objective"] = envelope["goal_objective"]
    if envelope.get("node_id"):
        task_blob["node_id"] = envelope["node_id"]

    assign_msg = {
        "type": "task_assign",
        "task_id": task_id,
        "conversation_id": conv_id,
        "target": task_blob["target"],
        "scope": task_blob["scope"],
        "instruction": task_blob["instruction"],
        "engagement": eng,
        "role": eng,
        "goal_mode": task_blob["goal_mode"],
        "schedule_id": envelope.get("schedule_id"),
    }
    if task_blob.get("goal_objective"):
        assign_msg["goal_objective"] = task_blob["goal_objective"]

    return {
        "user_id": user_id,
        "conversation_id": conv_id,
        "conversation_title": f"Scheduled: {eng} @ {task_blob.get('target') or 'target'}",
        "conversation_context": {"task": task_blob, "source": "schedule"},
        "node_id": envelope.get("node_id"),
        "task_assign": assign_msg,
        "audit": {
            "action": "schedule.fire",
            "resource_type": "schedule",
            "resource_id": envelope.get("schedule_id"),
            "detail": {
                "schedule_id": envelope.get("schedule_id"),
                "task_id": task_id,
                "conversation_id": conv_id,
                "engagement": eng,
                "target": task_blob.get("target"),
                "task_assign": assign_msg,
            },
            "status": "success",
        },
    }


# Process-wide default store (path optional via env in API module)
_default_store: ScheduleStore | None = None


def get_schedule_store(path: Path | None = None) -> ScheduleStore:
    global _default_store
    if path is not None:
        return ScheduleStore(path)
    if _default_store is None:
        _default_store = ScheduleStore()
    return _default_store
