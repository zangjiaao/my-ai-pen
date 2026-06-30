"""Conversation status helpers shared by REST and WebSocket paths."""
from __future__ import annotations

from datetime import datetime, timezone

from app.models.conversation import Conversation

CONVERSATION_STATUSES = {"created", "running", "paused", "completed", "failed", "canceled"}

CONVERSATION_TRANSITIONS: dict[str, set[str]] = {
    "created": {"running", "canceled"},
    "running": {"paused", "completed", "failed", "canceled"},
    "paused": {"running", "canceled"},
    "completed": {"running"},
    "failed": {"running", "canceled"},
    "canceled": {"running"},
}


class ConversationStatusError(ValueError):
    pass


def normalize_conversation_status(status: str) -> str:
    normalized = status.strip().lower()
    if normalized == "resumed":
        return "running"
    if normalized == "cancelled":
        return "canceled"
    return normalized


def transition_conversation(conv: Conversation, next_status: str) -> None:
    target = normalize_conversation_status(next_status)
    if target not in CONVERSATION_STATUSES:
        raise ConversationStatusError(f"Invalid conversation status: {next_status}")

    current = normalize_conversation_status(conv.status or "created")
    if current == target:
        return

    allowed = CONVERSATION_TRANSITIONS.get(current, set())
    if target not in allowed:
        raise ConversationStatusError(f"Invalid conversation status transition: {current} -> {target}")

    conv.status = target
    conv.last_active_at = datetime.now(timezone.utc)
