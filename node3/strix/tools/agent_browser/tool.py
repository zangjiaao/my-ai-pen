"""Compatibility guard for accidental direct ``agent_browser`` tool calls."""

from __future__ import annotations

import json
from typing import Any

from agents import RunContextWrapper, function_tool


@function_tool(timeout=5, strict_mode=False)
async def agent_browser(
    ctx: RunContextWrapper,
    command: str | None = None,
    args: list[Any] | str | None = None,
) -> str:
    """Do not use directly; run the agent-browser CLI through ``exec_command``.

    The browser automation surface is a sandbox command named
    ``agent-browser``. This function exists only so an accidental tool call
    named ``agent_browser`` returns a recoverable instruction instead of
    crashing the agent loop with "tool not found".
    """
    del ctx
    payload: dict[str, Any] = {
        "success": False,
        "error": "agent_browser is a CLI, not the browser automation tool surface.",
        "next_step": "Call exec_command with a shell command that starts with 'agent-browser'.",
    }
    if command:
        payload["received_command"] = command
    if args:
        payload["received_args"] = args
    return json.dumps(payload, ensure_ascii=False, default=str)
