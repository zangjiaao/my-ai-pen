"""Compatibility guard for accidental direct browser CLI tool calls."""

from __future__ import annotations

import json
from typing import Any

from agents import RunContextWrapper, function_tool


def _recovery_payload(
    *,
    tool_name: str,
    command: str | None = None,
    args: list[Any] | str | None = None,
) -> str:
    payload: dict[str, Any] = {
        "success": False,
        "error": f"{tool_name} is a CLI command, not an SDK function tool.",
        "next_step": "Call exec_command with a shell command that starts with 'agent-browser'.",
    }
    if command:
        payload["received_command"] = command
    if args:
        payload["received_args"] = args
    return json.dumps(payload, ensure_ascii=False, default=str)


@function_tool(timeout=5, strict_mode=False)
async def agent_browser(
    ctx: RunContextWrapper,
    command: str | None = None,
    args: list[Any] | str | None = None,
) -> str:
    """Do not use directly; run the agent-browser CLI through ``exec_command``.

    The browser automation surface is a sandbox command named
    ``agent-browser``. This function exists only so an accidental direct
    tool call returns a recoverable instruction instead of crashing the
    agent loop with "tool not found".
    """
    del ctx
    return _recovery_payload(tool_name="agent_browser", command=command, args=args)


@function_tool(name_override="agent-browser", timeout=5, strict_mode=False)
async def agent_browser_cli(
    ctx: RunContextWrapper,
    command: str | None = None,
    args: list[Any] | str | None = None,
) -> str:
    """Do not use directly; run the agent-browser CLI through ``exec_command``."""
    del ctx
    return _recovery_payload(tool_name="agent-browser", command=command, args=args)
