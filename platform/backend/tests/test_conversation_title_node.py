"""Node ledger: agent may set Case/session title (auto-name + rename)."""
from __future__ import annotations

from app.api.node_ledger import _DEFAULT_CONVERSATION_TITLES


def test_default_title_placeholders():
    assert "新会话" in _DEFAULT_CONVERSATION_TITLES
    assert "New session" in _DEFAULT_CONVERSATION_TITLES
    assert "DVWA 渗透" not in _DEFAULT_CONVERSATION_TITLES


def test_only_if_default_logic():
    """Mirror server skip rule used by only_if_default=true."""

    def would_skip(current: str) -> bool:
        cur = (current or "").strip()
        return bool(cur) and cur not in _DEFAULT_CONVERSATION_TITLES

    assert would_skip("用户已改的标题") is True
    assert would_skip("新会话") is False
    assert would_skip("") is False
    assert would_skip("New session") is False
