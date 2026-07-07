"""Build SandboxAgents for root + child Strix runs."""

from __future__ import annotations

import inspect
import json
import logging
import re
from copy import deepcopy
from typing import TYPE_CHECKING, Any

from agents.agent import ToolsToFinalOutputResult
from agents.sandbox import SandboxAgent
from agents.sandbox.capabilities import Filesystem, Shell
from agents.sandbox.errors import InvalidManifestPathError
from agents.tool import CustomTool, FunctionTool, Tool
from pydantic import ValidationError

from strix.agents.prompt import render_system_prompt
from strix.tools.agents_graph.tools import (
    agent_finish,
    create_agent,
    send_message_to_agent,
    stop_agent,
    view_agent_graph,
    wait_for_message,
)
from strix.tools.finish.tool import finish_scan
from strix.tools.load_skill.tool import load_skill
from strix.tools.notes.tools import (
    create_note,
    delete_note,
    get_note,
    list_notes,
    update_note,
)
from strix.tools.proxy.tools import (
    list_requests,
    list_sitemap,
    repeat_request,
    scope_rules,
    view_request,
    view_sitemap_entry,
)
from strix.tools.reporting.node3_tool import create_vulnerability_report
from strix.tools.thinking.tool import think
from strix.tools.todo.tools import (
    create_todo,
    delete_todo,
    list_todos,
    mark_todo_done,
    mark_todo_pending,
    update_todo,
)
from strix.tools.web_search.tool import web_search


if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from agents import RunContextWrapper
    from agents.tool import FunctionToolResult


logger = logging.getLogger(__name__)


_CUSTOM_TOOL_INPUT_FIELD_BY_NAME = {
    "apply_patch": "patch",
}
_DEFAULT_CUSTOM_TOOL_INPUT_FIELD = "input"
_JSON_SCHEMA_TYPE_MARKERS = {"type", "anyOf", "$ref", "oneOf", "allOf", "enum", "const"}
_ANY_JSON_SCHEMA: dict[str, Any] = {
    "anyOf": [
        {"type": "string"},
        {"type": "number"},
        {"type": "integer"},
        {"type": "boolean"},
        {
            "type": "object",
            "properties": {
                "_json": {
                    "type": "string",
                    "description": "Optional JSON object payload for providers that reject free-form objects.",
                },
            },
            "additionalProperties": False,
        },
        {
            "type": "array",
            "items": {
                "anyOf": [
                    {"type": "string"},
                    {"type": "number"},
                    {"type": "integer"},
                    {"type": "boolean"},
                    {
                        "type": "object",
                        "properties": {
                            "_json": {
                                "type": "string",
                                "description": "Optional JSON object payload for providers that reject free-form objects.",
                            },
                        },
                        "additionalProperties": False,
                    },
                    {"type": "null"},
                ],
            },
        },
        {"type": "null"},
    ],
}
_NOOP_SCHEMA_PROPERTY: dict[str, Any] = {
    "type": "string",
    "description": "Optional ignored placeholder for providers that reject empty parameter objects.",
}
_NOOP_ARGUMENT_KEYS = {"_noop"}


def _custom_tool_input_field(tool: CustomTool) -> str:
    return _CUSTOM_TOOL_INPUT_FIELD_BY_NAME.get(tool.name, _DEFAULT_CUSTOM_TOOL_INPUT_FIELD)


def _raw_input_schema(tool: CustomTool) -> dict[str, Any]:
    input_field = _custom_tool_input_field(tool)
    return {
        "type": "object",
        "properties": {
            input_field: {
                "type": "string",
                "description": (
                    f"Complete `{tool.name}` payload. Follow the tool description exactly."
                ),
            },
        },
        "required": [input_field],
        "additionalProperties": False,
    }


def _extract_custom_input(tool: CustomTool, raw_input: str | dict[str, Any]) -> str:
    if isinstance(raw_input, str):
        try:
            parsed = json.loads(raw_input)
        except json.JSONDecodeError:
            return ""
    else:
        parsed = raw_input
    value = parsed.get(_custom_tool_input_field(tool))
    return value if isinstance(value, str) else ""


def _format_tool_error(exc: Exception) -> str:
    return str(exc) or exc.__class__.__name__


def _normalize_chat_completions_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Ensure permissive SDK schemas are valid for strict Chat Completions APIs.

    Pydantic emits fields typed as ``Any`` as ``{"title": ...}``. OpenAI accepts
    that, but providers such as Deepseek reject every schema node without a
    ``type`` / ``anyOf`` / ``$ref`` marker. Keep runtime behavior permissive by
    turning those untyped leaves into a broad JSON value union.
    """
    normalized = deepcopy(schema)
    if not any(marker in normalized for marker in _JSON_SCHEMA_TYPE_MARKERS):
        normalized["type"] = "object"
    _normalize_schema_node(normalized)
    return normalized


def _normalize_schema_node(node: dict[str, Any]) -> None:
    for key, value in list(node.items()):
        if key == "properties" and isinstance(value, dict):
            for child in value.values():
                if isinstance(child, dict):
                    _normalize_schema_node(child)
            continue
        if key in {"$defs", "definitions"} and isinstance(value, dict):
            for child in value.values():
                if isinstance(child, dict):
                    _normalize_schema_node(child)
            continue
        if key in {"items", "additionalProperties", "contains", "propertyNames", "not"}:
            if isinstance(value, dict):
                _normalize_schema_node(value)
            continue
        if key in {"anyOf", "oneOf", "allOf"} and isinstance(value, list):
            for child in value:
                if isinstance(child, dict):
                    _normalize_schema_node(child)

    if "properties" in node:
        node["type"] = "object"
        if isinstance(node["properties"], dict) and not node["properties"]:
            node["properties"] = {"_noop": deepcopy(_NOOP_SCHEMA_PROPERTY)}
        if isinstance(node["properties"], dict):
            node["required"] = list(node["properties"].keys())
        node["additionalProperties"] = False
        return
    if node.get("type") == "object":
        node["properties"] = {"_json": deepcopy(_NOOP_SCHEMA_PROPERTY)}
        node["required"] = ["_json"]
        node["additionalProperties"] = False
        return
    if any(marker in node for marker in _JSON_SCHEMA_TYPE_MARKERS):
        return
    if "items" in node:
        node["type"] = "array"
        return
    if any(key in node for key in {"title", "description", "default", "examples"}):
        node.update(deepcopy(_ANY_JSON_SCHEMA))
        return


def _ensure_chat_completions_tool_schema(tool: FunctionTool) -> FunctionTool:
    schema = tool.params_json_schema
    if isinstance(schema, dict):
        normalized = _normalize_chat_completions_schema(schema)
        if _is_empty_object_schema(normalized):
            normalized["properties"] = {"_noop": deepcopy(_NOOP_SCHEMA_PROPERTY)}
            normalized["required"] = ["_noop"]
            normalized["additionalProperties"] = False
            _wrap_noop_arguments(tool)
        tool.params_json_schema = normalized
    return tool


def _is_empty_object_schema(schema: dict[str, Any]) -> bool:
    return schema.get("type") == "object" and isinstance(schema.get("properties"), dict) and not schema["properties"]


def _wrap_noop_arguments(tool: FunctionTool) -> None:
    if getattr(tool, "_strix_noop_argument_wrapper", False):
        return
    invoke_tool = tool.on_invoke_tool

    async def invoke(ctx: Any, raw_input: str) -> Any:
        try:
            parsed = json.loads(raw_input) if isinstance(raw_input, str) else raw_input
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict) and set(parsed).issubset(_NOOP_ARGUMENT_KEYS):
            return await invoke_tool(ctx, "{}")
        return await invoke_tool(ctx, raw_input)

    tool.on_invoke_tool = invoke
    setattr(tool, "_strix_noop_argument_wrapper", True)


def _function_tool_with_error_result(tool: FunctionTool) -> FunctionTool:
    _ensure_chat_completions_tool_schema(tool)
    invoke_tool = tool.on_invoke_tool

    async def invoke(ctx: Any, raw_input: str) -> Any:
        try:
            return await invoke_tool(ctx, raw_input)
        except Exception as exc:  # noqa: BLE001 - tool errors should be model-visible results.
            logger.debug("Tool %s failed; returning error as result", tool.name, exc_info=True)
            return _format_tool_error(exc)

    tool.on_invoke_tool = invoke
    return tool


def _custom_tool_as_function_tool(tool: CustomTool) -> FunctionTool:
    async def invoke(ctx: Any, raw_input: str) -> Any:
        custom_input = _extract_custom_input(tool, raw_input)
        if not custom_input:
            return f"`{_custom_tool_input_field(tool)}` must be a non-empty string."
        try:
            return await tool.on_invoke_tool(ctx, custom_input)
        except Exception as exc:  # noqa: BLE001 - matches SDK CustomTool error-as-result behavior.
            logger.debug("Tool %s failed; returning error as result", tool.name, exc_info=True)
            return _format_tool_error(exc)

    needs_approval = tool.runtime_needs_approval()
    function_needs_approval: bool | Callable[[Any, dict[str, Any], str], Awaitable[bool]]
    if callable(needs_approval):

        async def approve(ctx: Any, args: dict[str, Any], call_id: str) -> bool:
            result = needs_approval(ctx, _extract_custom_input(tool, args), call_id)
            if inspect.isawaitable(result):
                result = await result
            return bool(result)

        function_needs_approval = approve
    else:
        function_needs_approval = needs_approval

    return FunctionTool(
        name=tool.name,
        description=(
            f"{tool.description}\n\n"
            f"Pass the complete `{tool.name}` payload in `{_custom_tool_input_field(tool)}`."
        ),
        params_json_schema=_raw_input_schema(tool),
        on_invoke_tool=invoke,
        strict_json_schema=False,
        needs_approval=function_needs_approval,
    )


def _configure_chat_completions_filesystem_tools(toolset: Any) -> None:
    for name, tool in vars(toolset).items():
        if isinstance(tool, CustomTool):
            setattr(toolset, name, _custom_tool_as_function_tool(tool))
        elif isinstance(tool, FunctionTool):
            setattr(toolset, name, _function_tool_with_error_result(tool))


def _tool_with_chat_completions_schema(tool: Tool) -> Tool:
    if isinstance(tool, FunctionTool):
        return _ensure_chat_completions_tool_schema(tool)
    return tool


_CHARS_ESCAPE_RE = re.compile(r"\\(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0abtnvfr\\])")
_CHARS_ESCAPE_MAP = {
    "\\\\": "\\",
    "\\n": "\n",
    "\\t": "\t",
    "\\r": "\r",
    "\\0": "\x00",
    "\\a": "\x07",
    "\\b": "\x08",
    "\\v": "\x0b",
    "\\f": "\x0c",
}


def _decode_chars_escape(s: str) -> str:
    if "\\" not in s:
        return s

    def sub(match: re.Match[str]) -> str:
        token = match.group(0)
        if token in _CHARS_ESCAPE_MAP:
            return _CHARS_ESCAPE_MAP[token]
        if token.startswith(("\\u", "\\x")):
            return chr(int(token[2:], 16))
        return token

    return _CHARS_ESCAPE_RE.sub(sub, s)


def _format_validation_error(tool_name: str, exc: ValidationError) -> str:
    parts: list[str] = []
    for err in exc.errors():
        loc = ".".join(str(x) for x in err.get("loc", ()))
        msg = err.get("msg", "invalid")
        parts.append(f"{loc}: {msg}" if loc else msg)
    return f"{tool_name}: invalid arguments — " + "; ".join(parts)


def _wrap_exec_command(tool: FunctionTool) -> FunctionTool:
    invoke_tool = tool.on_invoke_tool

    async def invoke(ctx: Any, raw_input: str) -> Any:
        try:
            return await invoke_tool(ctx, raw_input)
        except ValidationError as exc:
            return _format_validation_error(tool.name, exc)
        except InvalidManifestPathError as exc:
            rel = exc.context.get("rel", "?")
            return (
                "exec_command: workdir must be a path inside /workspace "
                "(or omitted to use the turn's cwd). "
                f"Got: {rel!r}."
            )

    tool.on_invoke_tool = invoke
    return tool


def _wrap_write_stdin(tool: FunctionTool) -> FunctionTool:
    invoke_tool = tool.on_invoke_tool

    async def invoke(ctx: Any, raw_input: str) -> Any:
        try:
            parsed = json.loads(raw_input)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict) and isinstance(parsed.get("chars"), str):
            parsed["chars"] = _decode_chars_escape(parsed["chars"])
            raw_input = json.dumps(parsed)
        try:
            return await invoke_tool(ctx, raw_input)
        except ValidationError as exc:
            return _format_validation_error(tool.name, exc)

    tool.on_invoke_tool = invoke
    return tool


def _configure_shell_tools(toolset: Any, *, chat_completions: bool) -> None:
    for name, tool in vars(toolset).items():
        if not isinstance(tool, FunctionTool):
            continue
        wrapped = tool
        if tool.name == "exec_command":
            wrapped = _wrap_exec_command(wrapped)
        elif tool.name == "write_stdin":
            wrapped = _wrap_write_stdin(wrapped)
        if chat_completions:
            wrapped = _function_tool_with_error_result(wrapped)
        setattr(toolset, name, wrapped)


def _make_shell_configurator(*, chat_completions: bool) -> Any:
    def configure(toolset: Any) -> None:
        _configure_shell_tools(toolset, chat_completions=chat_completions)

    return configure


def _lifecycle_tool_completed(tool_name: str, output: Any) -> bool:
    if tool_name == "agent_finish":
        completion_key = "agent_completed"
    elif tool_name == "finish_scan":
        completion_key = "scan_completed"
    else:
        return False

    if not isinstance(output, str):
        return False
    try:
        parsed = json.loads(output)
    except (TypeError, ValueError):
        return False
    return bool(isinstance(parsed, dict) and parsed.get("success") and parsed.get(completion_key))


def _wait_tool_parked(tool_name: str, output: Any) -> bool:
    if tool_name != "wait_for_message" or not isinstance(output, str):
        return False
    try:
        parsed = json.loads(output)
    except (TypeError, ValueError):
        return False
    return bool(
        isinstance(parsed, dict)
        and parsed.get("success")
        and parsed.get("wait_outcome") == "waiting"
    )


def _finish_tool_use_behavior(
    ctx: RunContextWrapper[Any],
    tool_results: list[FunctionToolResult],
) -> ToolsToFinalOutputResult:
    """Stop only after a lifecycle tool reports successful completion."""
    interactive = (
        bool(ctx.context.get("interactive", False)) if isinstance(ctx.context, dict) else False
    )
    for tool_result in tool_results:
        if _lifecycle_tool_completed(tool_result.tool.name, tool_result.output):
            return ToolsToFinalOutputResult(
                is_final_output=True,
                final_output=tool_result.output,
            )
        if interactive and _wait_tool_parked(tool_result.tool.name, tool_result.output):
            return ToolsToFinalOutputResult(
                is_final_output=True,
                final_output=tool_result.output,
            )
    return ToolsToFinalOutputResult(is_final_output=False, final_output=None)


_BASE_TOOLS: tuple[Tool, ...] = (
    think,
    load_skill,
    create_todo,
    list_todos,
    update_todo,
    mark_todo_done,
    mark_todo_pending,
    delete_todo,
    create_note,
    list_notes,
    get_note,
    update_note,
    delete_note,
    web_search,
    create_vulnerability_report,
    list_requests,
    view_request,
    repeat_request,
    list_sitemap,
    view_sitemap_entry,
    scope_rules,
    view_agent_graph,
    send_message_to_agent,
    wait_for_message,
    create_agent,
    stop_agent,
)


def build_strix_agent(
    *,
    name: str = "strix",
    skills: list[str] | None = None,
    is_root: bool,
    scan_mode: str = "deep",
    is_whitebox: bool = False,
    interactive: bool = False,
    chat_completions_tools: bool = False,
    system_prompt_context: dict[str, Any] | None = None,
) -> SandboxAgent[Any]:
    """Build a SandboxAgent for either root or child use.

    Args:
        chat_completions_tools: Wrap SDK custom tools as function tools
            when the selected backend cannot accept Responses custom tools.
    """
    instructions = render_system_prompt(
        skills=skills,
        scan_mode=scan_mode,
        is_whitebox=is_whitebox,
        is_root=is_root,
        interactive=interactive,
        system_prompt_context=system_prompt_context,
    )

    if is_root:
        tools: list[Tool] = [*_BASE_TOOLS, finish_scan]
    else:
        tools = [*_BASE_TOOLS, agent_finish]
    if chat_completions_tools:
        tools = [_tool_with_chat_completions_schema(tool) for tool in tools]

    logger.info(
        "Built %s agent '%s' (skills=%d, tools=%d, scan_mode=%s, whitebox=%s)",
        "root" if is_root else "child",
        name,
        len(skills or []),
        len(tools),
        scan_mode,
        is_whitebox,
    )

    return SandboxAgent(
        name=name,
        instructions=instructions,
        tools=tools,
        tool_use_behavior=_finish_tool_use_behavior,
        model=None,
        capabilities=[
            Filesystem(
                configure_tools=(
                    _configure_chat_completions_filesystem_tools if chat_completions_tools else None
                ),
            ),
            Shell(
                configure_tools=_make_shell_configurator(
                    chat_completions=chat_completions_tools,
                ),
            ),
        ],
    )


def make_child_factory(
    *,
    scan_mode: str = "deep",
    is_whitebox: bool = False,
    interactive: bool = False,
    chat_completions_tools: bool = False,
    system_prompt_context: dict[str, Any] | None = None,
) -> Any:
    """Return the runner-owned builder used by ``spawn_child_agent``.

    Run-level arguments (``scan_mode``, ``is_whitebox``, etc.) are
    captured in a closure so each child inherits scan-level configuration
    without the graph tool knowing about runner internals.
    """

    def _factory(*, name: str, skills: list[str]) -> SandboxAgent[Any]:
        return build_strix_agent(
            name=name,
            skills=skills,
            is_root=False,
            scan_mode=scan_mode,
            is_whitebox=is_whitebox,
            interactive=interactive,
            chat_completions_tools=chat_completions_tools,
            system_prompt_context=system_prompt_context,
        )

    return _factory
