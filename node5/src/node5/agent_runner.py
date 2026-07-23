"""Nested ADK Agent runner (single Loop) used by Task and Agent Graph nodes."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from node5.config import load_config, resolve_adk_model
from node5.state import PenState
from node5.tools_act import CookieJar, make_tools


def escape_adk_braces(text: str) -> str:
    """Legacy no-op helper.

    ADK inject_session_state matches ``{+[^{}]*}+`` and strips *all* outer braces,
    so doubling braces does **not** escape path params like ``{id}`` / ``{filename}``.
    Prefer ``static_instruction`` (see ``run_agent``) which skips injection entirely.
    """
    return text or ""


def parse_json_blob(text: str) -> dict[str, Any] | None:
    text = (text or "").strip()
    if not text:
        return None
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL | re.IGNORECASE)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    return None


@dataclass
class AgentRunResult:
    raw: str
    payload: dict[str, Any] | None
    tool_calls: int
    cookies: dict[str, str] = field(default_factory=dict)
    actor_cookies: dict[str, dict[str, str]] = field(default_factory=dict)


async def run_agent(
    *,
    state: PenState,
    agent_name: str,
    instruction: str,
    user_message: str,
    jar: CookieJar | None = None,
    max_events: int | None = None,
) -> AgentRunResult:
    from google.adk import Agent, Runner
    from google.adk.sessions import InMemorySessionService
    from google.genai import types

    cfg = load_config()
    # Honor CLI/PenState model override (env default is deepseek-v4-flash)
    model = resolve_adk_model(cfg, model_id=state.model or None)
    jar = jar or CookieJar(state.cookies, actor_cookies=state.actor_cookies)
    counter = [0]
    tools = make_tools(
        state.target,
        jar=jar,
        max_chars=state.max_shell_chars,
        tool_counter=counter,
        pack_root=state.pack_root or None,
    )

    # ADK requires a valid Python identifier for Agent.name
    safe = "".join(ch if (ch.isalnum() or ch == "_") else "_" for ch in (agent_name or "agent"))
    if not safe or safe[0].isdigit():
        safe = "agent_" + safe
    safe = safe[:48]

    # Use static_instruction so Juice/OpenAPI path templates like /api/{id}
    # and skill JSON examples are NOT fed through inject_session_state
    # (which raises KeyError on missing identifiers such as `id`).
    agent = Agent(
        name=safe,
        model=model,
        static_instruction=instruction or "",
        tools=tools,
    )

    ss = InMemorySessionService()
    session = await ss.create_session(app_name=f"node5_{safe}"[:64], user_id="operator")
    runner = Runner(app_name=f"node5_{safe}"[:64], agent=agent, session_service=ss)
    user_msg = types.Content(role="user", parts=[types.Part(text=user_message)])

    texts: list[str] = []
    events = 0
    limit = max_events if max_events is not None else max(20, cfg.stage_max_llm_calls * 4)
    truncated = False
    async for event in runner.run_async(
        user_id="operator",
        session_id=session.id,
        new_message=user_msg,
    ):
        events += 1
        if event.content and event.content.parts:
            for p in event.content.parts:
                if p.text:
                    texts.append(p.text)
                fc = getattr(p, "function_call", None)
                if fc and getattr(fc, "name", None):
                    texts.append(f"[tool_call:{fc.name}]")
        if event.output is not None and isinstance(event.output, str):
            texts.append(event.output)
        if events >= limit:
            texts.append(f"[truncated_after_{events}_events]")
            truncated = True
            break

    raw = "\n".join(texts).strip()
    # Observability footer for Feedback / notes (not for model)
    raw = (
        raw
        + f"\n[worker_events={events} limit={limit} truncated={str(truncated).lower()} "
        f"tool_calls={counter[0]}]"
    )
    return AgentRunResult(
        raw=raw,
        payload=parse_json_blob(raw),
        tool_calls=counter[0],
        cookies=jar.snapshot(),
        actor_cookies=jar.snapshot_actors(),
    )
