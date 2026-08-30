"""Case access: JWT actor must own the conversation (no cross-user WS mutation)."""
from __future__ import annotations

import uuid

from sqlalchemy import Select, select

from app.models.conversation import Conversation


def actor_owns_case(owner_id: uuid.UUID | None, client_id: object) -> bool:
    """True only when JWT `sub` is the Case owner. Never infer from conversation_id alone."""
    if owner_id is None:
        return False
    raw = str(client_id or "").strip()
    if not raw:
        return False
    try:
        return uuid.UUID(raw) == owner_id
    except ValueError:
        return False


def conversation_for_update_stmt(cid: uuid.UUID) -> Select[tuple[Conversation]]:
    """Row lock for JSONB context RMW — serialize Workset/Scope writers."""
    return select(Conversation).where(Conversation.id == cid).with_for_update()
