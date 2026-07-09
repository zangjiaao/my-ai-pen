"""SDK session helpers for Strix agents."""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING, Any, cast

from agents.memory import SQLiteSession


if TYPE_CHECKING:
    from pathlib import Path

    from agents.items import TResponseInputItem
    from agents.memory import Session


def open_agent_session(agent_id: str, path: Path) -> SQLiteSession:
    path.parent.mkdir(parents=True, exist_ok=True)
    return SQLiteSession(session_id=agent_id, db_path=path)


_IMAGE_REJECTED_TEXT = "[image rejected by the model]"
_COMPACTED_TEXT_PREFIX = "[compacted by Strix session history]"
_DEFAULT_MAX_TEXT_CHARS = 8_000
_DEFAULT_RECENT_ITEMS_TO_KEEP = 12
_DEFAULT_RECENT_TEXT_BUDGET = 48_000
_DEFAULT_EXACT_RECENT_ITEMS = 2
_DEFAULT_OVER_BUDGET_RECENT_TEXT_CHARS = 2_000


async def strip_all_images_from_session(session: Session) -> bool:
    items = await session.get_items()
    if not items:
        return False

    rebuilt: list[Any] = []
    changed = False
    for item in items:
        item_dict = cast("dict[str, Any]", item) if isinstance(item, dict) else None
        if (
            item_dict is not None
            and item_dict.get("type") == "function_call_output"
            and isinstance(item_dict.get("output"), list)
            and any(
                isinstance(b, dict) and b.get("type") == "input_image" for b in item_dict["output"]
            )
        ):
            rebuilt.append(
                {
                    "type": "function_call_output",
                    "call_id": item_dict.get("call_id"),
                    "output": [{"type": "input_text", "text": _IMAGE_REJECTED_TEXT}],
                },
            )
            changed = True
        else:
            rebuilt.append(item)

    if not changed:
        return False

    rebuilt_items = cast("list[TResponseInputItem]", rebuilt)
    await session.clear_session()
    try:
        await session.add_items(rebuilt_items)
    except Exception:
        with contextlib.suppress(Exception):
            await session.add_items(rebuilt_items)
        raise
    return True


async def compact_session_items(
    session: Session,
    *,
    max_text_chars: int = _DEFAULT_MAX_TEXT_CHARS,
    recent_items_to_keep: int = _DEFAULT_RECENT_ITEMS_TO_KEEP,
    recent_text_budget: int = _DEFAULT_RECENT_TEXT_BUDGET,
    exact_recent_items: int = _DEFAULT_EXACT_RECENT_ITEMS,
    over_budget_recent_text_chars: int = _DEFAULT_OVER_BUDGET_RECENT_TEXT_CHARS,
) -> bool:
    """Bound old SDK session items so prior turns do not dominate context.

    The newest few items are left untouched because the model may need exact
    tool results for the current turn. The rest of the recent window is still
    constrained by a text budget so repeated large validator/reporter outputs
    do not get resent verbatim on every future model call.
    """
    items = await session.get_items()
    if not items:
        return False

    cutoff = max(0, len(items) - max(0, recent_items_to_keep))
    exact_recent_indexes = _exact_recent_indexes(
        items,
        cutoff=cutoff,
        recent_text_budget=recent_text_budget,
        exact_recent_items=exact_recent_items,
    )
    rebuilt: list[Any] = []
    changed = False
    for index, item in enumerate(items):
        if index in exact_recent_indexes:
            rebuilt.append(item)
            continue

        item_max_text_chars = max_text_chars
        if index >= cutoff:
            item_max_text_chars = min(max_text_chars, max(1, int(over_budget_recent_text_chars)))
        compacted = _compact_session_item(item, max_text_chars=item_max_text_chars)
        if compacted is not item:
            changed = True
        rebuilt.append(compacted)

    if not changed:
        return False

    rebuilt_items = cast("list[TResponseInputItem]", rebuilt)
    await session.clear_session()
    try:
        await session.add_items(rebuilt_items)
    except Exception:
        with contextlib.suppress(Exception):
            await session.add_items(rebuilt_items)
        raise
    return True


def _exact_recent_indexes(
    items: list[Any],
    *,
    cutoff: int,
    recent_text_budget: int,
    exact_recent_items: int,
) -> set[int]:
    exact: set[int] = set()
    budget = max(0, int(recent_text_budget))
    minimum_exact = max(0, int(exact_recent_items))
    total = 0

    for index in range(len(items) - 1, cutoff - 1, -1):
        size = _session_item_text_chars(items[index])
        if len(exact) < minimum_exact:
            exact.add(index)
            total += size
            continue
        if total + size <= budget:
            exact.add(index)
            total += size
    return exact


def _compact_session_item(item: Any, *, max_text_chars: int) -> Any:
    if not isinstance(item, dict):
        return item
    item_dict = cast("dict[str, Any]", item)
    item_type = item_dict.get("type")

    if item_type == "function_call_output":
        output = item_dict.get("output")
        compacted_output = _compact_value(output, max_text_chars=max_text_chars)
        if compacted_output != output:
            rebuilt = dict(item_dict)
            rebuilt["output"] = compacted_output
            return rebuilt
        return item

    if item_type == "function_call" and isinstance(item_dict.get("arguments"), str):
        arguments = str(item_dict["arguments"])
        compacted_arguments = _compact_text(arguments, max_text_chars=max_text_chars)
        if compacted_arguments != arguments:
            rebuilt = dict(item_dict)
            rebuilt["arguments"] = compacted_arguments
            return rebuilt
        return item

    if item_dict.get("role") in {"user", "assistant", "system"}:
        content = item_dict.get("content")
        compacted_content = _compact_value(content, max_text_chars=max_text_chars)
        if compacted_content != content:
            rebuilt = dict(item_dict)
            rebuilt["content"] = compacted_content
            return rebuilt
    return item


def _session_item_text_chars(item: Any) -> int:
    if isinstance(item, str):
        return len(item)
    if isinstance(item, dict):
        total = 0
        for key in ("content", "output", "arguments", "summary", "text"):
            if key in item:
                total += _value_text_chars(item.get(key))
        if total:
            return total
    return _value_text_chars(item)


def _value_text_chars(value: Any) -> int:
    if isinstance(value, str):
        return len(value)
    if isinstance(value, list):
        return sum(_value_text_chars(item) for item in value)
    if isinstance(value, dict):
        return sum(_value_text_chars(item) for item in value.values())
    return len(str(value or ""))


def _compact_value(value: Any, *, max_text_chars: int) -> Any:
    if isinstance(value, str):
        return _compact_text(value, max_text_chars=max_text_chars)
    if isinstance(value, list):
        changed = False
        compacted: list[Any] = []
        for item in value:
            if isinstance(item, dict):
                rebuilt = dict(item)
                for key in ("text", "content", "output"):
                    if isinstance(rebuilt.get(key), str):
                        new_text = _compact_text(str(rebuilt[key]), max_text_chars=max_text_chars)
                        if new_text != rebuilt[key]:
                            rebuilt[key] = new_text
                            changed = True
                compacted.append(rebuilt)
            else:
                compacted_item = _compact_value(item, max_text_chars=max_text_chars)
                if compacted_item != item:
                    changed = True
                compacted.append(compacted_item)
        return compacted if changed else value
    return value


def _compact_text(text: str, *, max_text_chars: int) -> str:
    if max_text_chars <= 0 or len(text) <= max_text_chars:
        return text
    if text.startswith(_COMPACTED_TEXT_PREFIX):
        return text

    preview_budget = max(200, max_text_chars - 220)
    head_len = max(100, preview_budget // 2)
    tail_len = max(100, preview_budget - head_len)
    return (
        f"{_COMPACTED_TEXT_PREFIX}\n"
        f"Original length: {len(text)} characters. "
        "Older oversized session content was compacted to keep future model context bounded. "
        "Persist decisive proof with record_evidence or an artifact when exact full output is needed.\n"
        f"--- head ---\n{text[:head_len]}\n"
        f"--- tail ---\n{text[-tail_len:]}"
    )
