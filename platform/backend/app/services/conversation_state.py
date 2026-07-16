"""Conversation status helpers shared by REST and WebSocket paths."""
from __future__ import annotations

from datetime import datetime, timezone

from app.models.conversation import Conversation

CONVERSATION_STATUSES = {"created", "running", "paused", "completed", "incomplete", "failed", "canceled"}

CONVERSATION_TRANSITIONS: dict[str, set[str]] = {
    "created": {"running", "canceled"},
    "running": {"paused", "completed", "incomplete", "failed", "canceled"},
    "paused": {"running", "canceled"},
    "completed": {"running"},
    "incomplete": {"running", "canceled"},
    "failed": {"running", "canceled"},
    "canceled": {"running"},
}

# Node checkpoint status → conversation lifecycle status (sidebar / list source of truth).
CHECKPOINT_TERMINAL_STATUS = {
    "completed": "completed",
    "incomplete": "incomplete",
    "blocked": "incomplete",
    "failed": "failed",
    "error": "failed",
    "canceled": "canceled",
    "cancelled": "canceled",
}

# Pre-terminal rows that may be healed from a terminal checkpoint.
HEALABLE_STATUSES = {"created", "running", "paused"}


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

    # task_complete can arrive even if bind never flipped created→running
    # (bind race / missing node_id). Bridge through running so settlement sticks.
    if current == "created" and target in {"completed", "incomplete", "failed"}:
        conv.status = "running"
        conv.last_active_at = datetime.now(timezone.utc)
        current = "running"

    allowed = CONVERSATION_TRANSITIONS.get(current, set())
    if target not in allowed:
        raise ConversationStatusError(f"Invalid conversation status transition: {current} -> {target}")

    conv.status = target
    conv.last_active_at = datetime.now(timezone.utc)


def checkpoint_terminal_status(checkpoint: dict | None) -> str | None:
    """Map a durable checkpoint status to a terminal conversation status, if any."""
    if not isinstance(checkpoint, dict):
        return None
    raw = str(checkpoint.get("status") or "").strip().lower()
    return CHECKPOINT_TERMINAL_STATUS.get(raw)


def _parse_checkpoint_end_time(checkpoint: dict) -> datetime | None:
    text = str(checkpoint.get("end_time") or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def effective_conversation_status(conv: Conversation) -> str:
    """Status for API/UI: prefer terminal checkpoint when the row never settled."""
    current = normalize_conversation_status(conv.status or "created")
    context = conv.context if isinstance(conv.context, dict) else {}
    checkpoint = context.get("checkpoint") if isinstance(context.get("checkpoint"), dict) else {}
    terminal = checkpoint_terminal_status(checkpoint)
    if terminal and current in HEALABLE_STATUSES:
        return terminal
    return current


def reconcile_conversation_status_from_checkpoint(conv: Conversation) -> bool:
    """Persist terminal checkpoint status onto the conversation row when it lagged.

    Returns True when the row was updated.
    """
    context = conv.context if isinstance(conv.context, dict) else {}
    checkpoint = context.get("checkpoint") if isinstance(context.get("checkpoint"), dict) else {}
    terminal = checkpoint_terminal_status(checkpoint)
    if not terminal:
        return False
    current = normalize_conversation_status(conv.status or "created")
    if current == terminal or current not in HEALABLE_STATUSES:
        return False
    try:
        transition_conversation(conv, terminal)
    except ConversationStatusError:
        return False
    end_at = _parse_checkpoint_end_time(checkpoint)
    if end_at is not None:
        conv.last_active_at = end_at
    return True
