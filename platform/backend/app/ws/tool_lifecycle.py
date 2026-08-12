"""Tool-call persist merge + request-line surface (Spec #350 interrupt settle).

Extracted from ws/router.py so the router does not keep growing merge policy.
"""
from __future__ import annotations

def _append_tool_stdout(current: object, incoming: object) -> str:
    current_stdout = str(current or "")
    incoming_stdout = str(incoming or "")
    if incoming_stdout and incoming_stdout not in current_stdout:
        separator = "" if current_stdout.endswith("\n") or not current_stdout else "\n"
        return f"{current_stdout}{separator}{incoming_stdout}"
    return current_stdout or incoming_stdout


# Shell multi-line scripts — keep nearly full command on Main rows (not a 500-char tease).
_SHELL_COMMAND_WIRE_MAX = 8000


def _command_from_result_blob(blob: object) -> str:
    """Extract shell command from jsonResult text/summary when args were not persisted."""
    if isinstance(blob, dict):
        for key in ("command", "cmd", "script"):
            val = blob.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()[:_SHELL_COMMAND_WIRE_MAX]
        return ""
    raw = str(blob or "").strip()
    if not raw.startswith("{"):
        return ""
    try:
        import json as _json

        parsed = _json.loads(raw)
    except Exception:
        return ""
    if isinstance(parsed, dict):
        return _command_from_result_blob(parsed)
    return ""


def _surface_from_tool_args(tool_name: object, args: object) -> tuple[str, str]:
    """Best-effort (command, target) for tool chip — all tools, not only shell."""
    name = str(tool_name or "").strip().lower()
    if not isinstance(args, dict):
        return "", ""

    def pick(*keys: str, limit: int = 500) -> str:
        for key in keys:
            val = args.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()[:limit]
            # limit etc. may be numeric on list tools
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                return str(val)
        return ""

    if any(k in name for k in ("shell", "exec", "command", "script", "stdin")):
        return pick("command", "cmd", "script", "code", "input", limit=_SHELL_COMMAND_WIRE_MAX), ""
    if name.startswith("http") or name in {"request", "session"}:
        method = (pick("method") or "GET").upper()
        url = pick("url", "target")
        return (f"{method} {url}"[:500] if url else ""), url
    if "browser" in name:
        action = pick("action")
        url = pick("url", "target") or pick("selector")
        detail = " ".join(p for p in (action, url) if p).strip()
        return "", detail[:500]
    if name in {"read", "write", "edit"} or "file" in name:
        path = pick("path", "file", "relative_path")
        return path, path
    if "skill" in name:
        op = pick("op") or "list"
        sid = pick("id", "skill_id", "name")
        return "", f"{op} {sid}".strip() if sid else op
    if "todo" in name:
        op = pick("op") or "view"
        task = pick("task", "phase", "note")
        return "", f"{op} · {task}" if task else op
    if "finding" in name:
        action = pick("action") or "confirm"
        title = pick("title", "vuln_type", "location", "url", "finding_id")
        return "", f"{action} · {title}" if title else action
    if "hypothesis" in name:
        op = pick("op") or "list"
        statement = pick("statement", "id", "signal")
        return "", f"{op} · {statement}" if statement else op
    if "subagent" in name:
        op = pick("op") or "spawn"
        goal = pick("this_turn_goal", "target", "scope", "assignment", "agent_id")
        packages = args.get("packages")
        if isinstance(packages, list) and len(packages) > 1:
            return "", f"{op} · {len(packages)} packages"
        return "", f"{op} · {goal}" if goal else op
    if name.startswith("platform_"):
        return "", pick(
            "asset_id",
            "vulnerability_id",
            "finding_id",
            "report_id",
            "id",
            "title",
            "name",
            "query",
            "status",
        )
    command = pick("command", "cmd", "script", "code")
    target = pick(
        "url",
        "target",
        "path",
        "file",
        "query",
        "title",
        "name",
        "id",
        "action",
        "op",
        "this_turn_goal",
        "text",
        "content",
    )
    return command, target


def _tool_item_from_content(content: dict) -> dict:
    command = str(content.get("command") or "").strip()
    target = str(content.get("target") or "").strip()
    args = content.get("args") if isinstance(content.get("args"), dict) else {}
    if not command or not target:
        surf_cmd, surf_tgt = _surface_from_tool_args(content.get("tool_name"), args or content.get("args"))
        if not command:
            command = surf_cmd
        if not target:
            target = surf_tgt
    # Legacy / end frames: command only inside result_text or summary JSON.
    if not command:
        command = (
            _command_from_result_blob(content.get("result"))
            or _command_from_result_blob(content.get("result_text"))
            or _command_from_result_blob(content.get("summary"))
        )
    # Keep args.command so FE request projection always has a source.
    if command and isinstance(args, dict) and not str(args.get("command") or "").strip():
        args = {**args, "command": command}
        content = {**content, "args": args}
    item = {
        "tool_name": content.get("tool_name", ""),
        "tool_run_id": content.get("tool_run_id"),
        "command": command,
        "target": target,
        "status": content.get("status", "running"),
        "stdout": content.get("stdout", ""),
        "evidence_id": content.get("evidence_id"),
    }
    for key in ("summary", "display_title", "category", "args", "result", "result_text"):
        if content.get(key) is not None:
            item[key] = content.get(key)
    if args and item.get("args") is None:
        item["args"] = args
    return item


def _merge_tool_lifecycle_status(existing: object, incoming: object) -> str:
    """Prefer fail, then done, over running — align with FE mergeToolLifecycleStatus.

    Empty stays empty when both missing (result-hint path). Do not invent running
    for blank+blank, but keep a single-side status when only one side is set.
    """
    e_raw = str(existing or "").strip()
    i_raw = str(incoming or "").strip()
    if not e_raw and not i_raw:
        return ""
    fail_vals = {
        "fail",
        "failed",
        "error",
        "blocked",
        "canceled",
        "cancelled",
        "interrupted",
    }
    done_vals = {"done", "ok", "success", "completed", "complete", "saved", "loaded"}
    e = e_raw.lower()
    i = i_raw.lower()
    if e in fail_vals or i in fail_vals:
        # Prefer the concrete fail token that arrived (incoming if fail, else existing).
        if i in fail_vals:
            return i_raw if i_raw else "error"
        return e_raw if e_raw else "error"
    if e in done_vals or i in done_vals:
        return "done"
    if i_raw:
        return i_raw
    return e_raw


def _merge_tool_items(existing: dict, incoming: dict) -> list[dict]:
    current = existing.get("tool_items") if isinstance(existing.get("tool_items"), list) else [_tool_item_from_content(existing)]
    incoming_item = _tool_item_from_content(incoming)
    incoming_run_id = str(incoming_item.get("tool_run_id") or "")
    merged: list[dict] = []
    updated = False

    for item in current:
        if not isinstance(item, dict):
            continue
        item_run_id = str(item.get("tool_run_id") or "")
        if incoming_run_id and item_run_id == incoming_run_id:
            merged_item = {
                **item,
                **incoming_item,
                # Prefer non-empty command/target; interrupt settle must not wipe detail.
                "command": (
                    str(incoming_item.get("command") or "").strip()
                    or str(item.get("command") or "").strip()
                    or ""
                ),
                "target": (
                    str(incoming_item.get("target") or "").strip()
                    or str(item.get("target") or "").strip()
                    or ""
                ),
                "stdout": _append_tool_stdout(item.get("stdout"), incoming_item.get("stdout")),
                "status": _merge_tool_lifecycle_status(item.get("status"), incoming_item.get("status"))
                or "running",
                "evidence_id": incoming_item.get("evidence_id") or item.get("evidence_id"),
            }
            for key in ("summary", "display_title", "category", "target", "args", "result", "result_text"):
                merged_item[key] = incoming_item.get(key) if incoming_item.get(key) is not None else item.get(key)
            merged.append(merged_item)
            updated = True
        else:
            merged.append(item)

    if not updated:
        merged.append(incoming_item)
    return merged


def _merge_thinking_status(existing: object, incoming: object) -> str | None:
    """Prefer terminal done over stale running; never drop done (Spec #305).

    Done synonyms MUST stay aligned with frontend normalizeExecutionStatus
    (platform/frontend/src/lib/status.ts):
      done | ok | success | completed | complete | saved | loaded
    Fail synonyms (for reference; thinking rarely uses them):
      fail | failed | error | blocked | canceled | cancelled
    Empty / unknown → not done (caller keeps raw running etc.).
    """
    done_vals = {"done", "ok", "success", "completed", "complete", "saved", "loaded"}
    e = str(existing or "").strip().lower()
    i = str(incoming or "").strip().lower()
    if e in done_vals or i in done_vals:
        return "done"
    if i:
        return i
    if e:
        return e
    return None


def _merge_saved_message_content(existing: dict, incoming: dict, msg_type: str) -> dict:
    if msg_type != "tool_call":
        # Streaming text/thinking: always keep the longer body so partial frames
        # cannot regress a fuller snapshot that arrived out of order.
        merged = {**existing, **incoming}
        if msg_type in {"text", "thinking"}:
            prev = str(existing.get("text") or existing.get("reasoning") or "")
            nxt = str(incoming.get("text") or incoming.get("reasoning") or "")
            if len(prev) > len(nxt):
                merged["text"] = prev
                if msg_type == "thinking":
                    merged["reasoning"] = prev
            elif nxt:
                merged["text"] = nxt
                if msg_type == "thinking":
                    merged["reasoning"] = nxt
            if msg_type == "thinking":
                status = _merge_thinking_status(existing.get("status"), incoming.get("status"))
                if status is not None:
                    merged["status"] = status
                elif "status" in merged and merged.get("status") in (None, ""):
                    merged.pop("status", None)
        return merged
    stdout = _append_tool_stdout(existing.get("stdout"), incoming.get("stdout"))
    merged_status = _merge_tool_lifecycle_status(existing.get("status"), incoming.get("status"))
    return {
        **existing,
        **incoming,
        "command": incoming.get("command") or existing.get("command") or "",
        "evidence_id": incoming.get("evidence_id") or existing.get("evidence_id"),
        "stdout": stdout,
        # Prefer fail/done over stale running (interrupt settle then late end).
        "status": merged_status or "running",
        "tool_items": _merge_tool_items(existing, incoming),
    }

