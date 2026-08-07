"""Spec #313 S1 / #277 — Session demand queue (FIFO).

While a Participant Session is in-flight, user demands (text or ChoiceCard confirm)
enqueue unless force_interrupt. Pure in-memory queue keyed by conversation_id.
FE may list/delete later; BE tests assert FIFO order.
"""
from __future__ import annotations

import uuid
from typing import Any

# conv_id -> FIFO list of demand dicts (each has id + payload fields)
_queues: dict[str, list[dict[str, Any]]] = {}


def _cid(conv_id: object) -> str:
    return str(conv_id or "").strip()


def clear_all() -> None:
    """Test helper — empty every queue."""
    _queues.clear()


def clear(conv_id: object) -> None:
    cid = _cid(conv_id)
    if cid:
        _queues.pop(cid, None)


def enqueue(conv_id: object, demand: dict | None = None, **fields: Any) -> dict[str, Any]:
    """Append a demand; returns the stored item (with id)."""
    cid = _cid(conv_id)
    if not cid:
        raise ValueError("conv_id required")
    item: dict[str, Any] = {}
    if isinstance(demand, dict):
        item.update(demand)
    item.update({k: v for k, v in fields.items() if v is not None})
    if not str(item.get("id") or "").strip():
        item["id"] = str(uuid.uuid4())
    item["conversation_id"] = cid
    _queues.setdefault(cid, []).append(item)
    return dict(item)


def peek(conv_id: object) -> dict[str, Any] | None:
    q = _queues.get(_cid(conv_id)) or []
    return dict(q[0]) if q else None


def pop(conv_id: object) -> dict[str, Any] | None:
    """Remove and return head (FIFO)."""
    cid = _cid(conv_id)
    q = _queues.get(cid) or []
    if not q:
        return None
    item = q.pop(0)
    if not q:
        _queues.pop(cid, None)
    return dict(item)


def delete(conv_id: object, demand_id: object) -> bool:
    """Remove demand by id. Returns True if found."""
    cid = _cid(conv_id)
    did = str(demand_id or "").strip()
    if not cid or not did:
        return False
    q = _queues.get(cid) or []
    for i, row in enumerate(q):
        if str(row.get("id") or "") == did:
            q.pop(i)
            if not q:
                _queues.pop(cid, None)
            return True
    return False


def list_demands(conv_id: object) -> list[dict[str, Any]]:
    return [dict(x) for x in (_queues.get(_cid(conv_id)) or [])]


def size(conv_id: object) -> int:
    return len(_queues.get(_cid(conv_id)) or [])
