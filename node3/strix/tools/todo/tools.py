"""Per-agent todo tools — mirrored to {state_dir}/todos.json."""

from __future__ import annotations

import json
import logging
import tempfile
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agents import RunContextWrapper, function_tool

from strix.tools.run_memory.tools import attack_surface_from_file, coverage_from_file, evidence_from_file, hypotheses_from_file
from strix.tools.workflow import is_recon_task


logger = logging.getLogger(__name__)


VALID_PRIORITIES = ["low", "normal", "high", "critical"]
PRIORITY_ALIASES = {"medium": "normal", "med": "normal"}
VALID_STATUSES = ["pending", "in_progress", "done"]
TERMINAL_INTERNAL_STATUSES = {"done", "failed", "blocked", "skipped"}
TODO_DETAIL_FIELDS = ("surface_id", "endpoint", "method", "parameter", "vuln_type", "auth_state")
_GENERIC_TEST_MARKERS = (
    "sql injection",
    "sqli",
    "xss",
    "idor",
    "broken access",
    "ssrf",
    "csrf",
    "path traversal",
    "lfi",
    "rfi",
    "authentication",
    "session",
    "authorization",
)

_PRIORITY_RANK = {"critical": 0, "high": 1, "normal": 2, "low": 3}


def _todo_sort_key(todo: dict[str, Any]) -> tuple[int, str, str]:
    raw_order = todo.get("order_index")
    try:
        order_index = int(raw_order)
    except (TypeError, ValueError):
        order_index = 1_000_000
    return (
        order_index,
        todo.get("created_at", ""),
        todo.get("todo_id", ""),
    )


_todos_storage: dict[str, dict[str, dict[str, Any]]] = {}

_todos_path: Path | None = None
_todos_io_lock = threading.RLock()


def hydrate_todos_from_disk(state_dir: Path) -> None:
    global _todos_path  # noqa: PLW0603
    _todos_path = state_dir / "todos.json"
    with _todos_io_lock:
        _todos_storage.clear()
        if not _todos_path.exists():
            return
        try:
            data = json.loads(_todos_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.exception(
                "todos.json at %s is unreadable; starting with empty todos",
                _todos_path,
            )
            return
        if not isinstance(data, dict):
            return
        loaded = 0
        for aid, by_id in data.items():
            if not isinstance(aid, str) or not isinstance(by_id, dict):
                continue
            cleaned = {
                str(tid): t
                for tid, t in by_id.items()
                if isinstance(tid, str) and isinstance(t, dict)
            }
            if cleaned:
                _todos_storage[aid] = cleaned
                loaded += len(cleaned)
        logger.info(
            "todos hydrated from %s (%d agent(s), %d todo(s))",
            _todos_path,
            len(_todos_storage),
            loaded,
        )


def _persist() -> None:
    path = _todos_path
    if path is None:
        return
    try:
        payload = json.dumps(_todos_storage, ensure_ascii=False, default=str)
        path.parent.mkdir(parents=True, exist_ok=True)
        with (
            _todos_io_lock,
            tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=str(path.parent),
                prefix=f".{path.name}.",
                suffix=".tmp",
                delete=False,
            ) as tmp,
        ):
            tmp.write(payload)
            tmp_path = Path(tmp.name)
        tmp_path.replace(path)
    except Exception:
        logger.exception("todos persist to %s failed", path)


def _agent_id_from(ctx: RunContextWrapper) -> str:
    inner = ctx.context if isinstance(ctx.context, dict) else {}
    return str(inner.get("agent_id") or "default")


def _state_dir_from(ctx: RunContextWrapper) -> Path | None:
    inner = ctx.context if isinstance(ctx.context, dict) else {}
    raw = inner.get("state_dir")
    if isinstance(raw, Path):
        return raw
    if isinstance(raw, str) and raw.strip():
        return Path(raw)
    return None


def _is_root_agent(ctx: RunContextWrapper) -> bool:
    inner = ctx.context if isinstance(ctx.context, dict) else {}
    return inner.get("parent_id") is None


def _get_agent_todos(agent_id: str) -> dict[str, dict[str, Any]]:
    return _todos_storage.setdefault(agent_id, {})


def _normalize_priority(priority: str | None, default: str = "normal") -> str:
    candidate = (priority or default or "normal").lower()
    candidate = PRIORITY_ALIASES.get(candidate, candidate)
    if candidate not in VALID_PRIORITIES:
        raise ValueError(f"Invalid priority. Must be one of: {', '.join(VALID_PRIORITIES)}")
    return candidate


def _sorted_todos(agent_id: str) -> list[dict[str, Any]]:
    todos_list = [
        {**todo, "todo_id": todo_id} for todo_id, todo in _get_agent_todos(agent_id).items()
    ]
    todos_list.sort(key=_todo_sort_key)
    return todos_list


def _next_order_index(agent_todos: dict[str, dict[str, Any]]) -> int:
    highest = -1
    for fallback_index, todo in enumerate(agent_todos.values()):
        try:
            current = int(todo.get("order_index"))
        except (TypeError, ValueError):
            current = fallback_index
            todo["order_index"] = current
        highest = max(highest, current)
    return highest + 1


def _is_internal_child_tracking_todo(todo: dict[str, Any]) -> bool:
    return bool(todo.get("internal_tracking")) or (
        bool(str(todo.get("linked_agent_id") or "").strip())
        and bool(str(todo.get("parent_todo_id") or "").strip())
    )


def _is_top_level_root_todo(todo: dict[str, Any]) -> bool:
    return not str(todo.get("linked_agent_id") or "").strip() and not str(todo.get("parent_todo_id") or "").strip()


def _single_root_phase_transition_errors(
    agent_todos: dict[str, dict[str, Any]],
    updates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    status_updates = [
        upd
        for upd in updates
        if str(upd.get("status") or "").strip().lower() in {"in_progress", "done"}
    ]
    top_level_updates = [
        upd
        for upd in status_updates
        if upd.get("todo_id") in agent_todos and _is_top_level_root_todo(agent_todos[upd["todo_id"]])
    ]
    if len(top_level_updates) <= 1:
        return []
    return [
        {
            "todo_id": str(upd.get("todo_id") or ""),
            "error": (
                "Root top-level todos represent scan phases and must be advanced one at a time. "
                "Update the current phase, complete its work and memory records, then advance the next phase."
            ),
        }
        for upd in top_level_updates
    ]


def _parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _artifact_time(item: dict[str, Any]) -> datetime | None:
    candidates = [
        _parse_time(item.get(field))
        for field in ("updated_at", "created_at", "timestamp", "completed_at")
    ]
    valid = [candidate for candidate in candidates if candidate is not None]
    return max(valid) if valid else None


def _load_json_artifacts(path: Path, id_field: str | None = None) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, dict):
        if id_field and isinstance(raw.get(id_field), str):
            return [raw]
        return [item for item in raw.values() if isinstance(item, dict)]
    return []


def _phase_keys(todo_id: str, todo: dict[str, Any]) -> set[str]:
    return {
        str(value or "").strip().lower()
        for value in (todo_id, todo.get("title"))
        if str(value or "").strip()
    }


def _artifact_matches_phase(item: dict[str, Any], phase_keys: set[str]) -> bool:
    phase = str(item.get("phase") or "").strip().lower()
    return bool(phase and phase in phase_keys)


def _phase_work_artifacts_since(
    state_dir: Path,
    started_at: datetime,
    *,
    phase_keys: set[str],
) -> list[dict[str, Any]]:
    run_dir = state_dir.parent
    artifact_sets = [
        ("attack_surface", attack_surface_from_file(state_dir / "attack_surface.json")),
        ("hypothesis", hypotheses_from_file(state_dir / "hypotheses.json")),
        ("coverage", coverage_from_file(state_dir / "coverage.json")),
        ("evidence", evidence_from_file(state_dir / "evidence.json")),
        ("note", _load_json_artifacts(state_dir / "notes.json")),
        ("vulnerability", _load_json_artifacts(run_dir / "vulnerabilities.json", "id")),
    ]
    recent: list[dict[str, Any]] = []
    for kind, artifacts in artifact_sets:
        for item in artifacts:
            artifact_at = _artifact_time(item)
            if artifact_at is not None and artifact_at >= started_at and _artifact_matches_phase(item, phase_keys):
                recent.append(
                    {
                        "kind": kind,
                        "id": (
                            item.get("coverage_id")
                            or item.get("surface_id")
                            or item.get("hypothesis_id")
                            or item.get("evidence_id")
                            or item.get("id")
                        ),
                        "phase": item.get("phase"),
                    },
                )
    return recent


def _root_phase_completion_error(
    todo_id: str,
    todo: dict[str, Any],
    state_dir: Path | None,
) -> dict[str, Any] | None:
    if state_dir is None or not _is_top_level_root_todo(todo):
        return None
    started_at = _parse_time(todo.get("started_at"))
    if started_at is None:
        return None
    if _phase_work_artifacts_since(state_dir, started_at, phase_keys=_phase_keys(todo_id, todo)):
        return None
    return {
        "todo_id": todo_id,
        "error": (
            "Root top-level scan phases cannot be marked done without phase-linked work artifacts "
            "recorded after the phase started. Set the artifact phase to the current phase title "
            "or todo_id when recording attack surface, hypotheses, coverage, evidence, notes, "
            "or vulnerability reports from the phase work."
        ),
    }


def validate_todo_exists(*, owner_agent_id: str, todo_id: str) -> str:
    """Return a normalized todo ID if it exists for the owner."""
    clean_id = str(todo_id or "").strip()
    if not clean_id:
        raise ValueError("todo_id cannot be empty")
    if clean_id not in _get_agent_todos(owner_agent_id):
        raise ValueError(f"Todo with ID '{clean_id}' not found")
    return clean_id


def create_bound_todo(
    *,
    owner_agent_id: str,
    title: str,
    description: str | None = None,
    priority: str | None = None,
    linked_agent_id: str,
    parent_todo_id: str | None = None,
) -> dict[str, Any]:
    """Create an in-progress parent todo assigned to a child agent."""
    clean_title = str(title or "").strip()
    if not clean_title:
        raise ValueError("Todo title cannot be empty")
    normalized_priority = _normalize_priority(priority)
    timestamp = datetime.now(UTC).isoformat()
    todo_id = str(uuid.uuid4())[:6]
    agent_todos = _get_agent_todos(owner_agent_id)
    todo = {
        "title": clean_title,
        "description": str(description or "").strip() or None,
        "priority": normalized_priority,
        "status": "in_progress",
        "order_index": _next_order_index(agent_todos),
        "created_at": timestamp,
        "updated_at": timestamp,
        "started_at": timestamp,
        "completed_at": None,
        "linked_agent_id": str(linked_agent_id),
        "internal_tracking": True,
    }
    if parent_todo_id:
        todo["parent_todo_id"] = validate_todo_exists(
            owner_agent_id=owner_agent_id,
            todo_id=parent_todo_id,
        )
    agent_todos[todo_id] = todo
    _persist()
    return {**todo, "todo_id": todo_id}


def bind_todo_to_agent(
    *,
    owner_agent_id: str,
    todo_id: str,
    linked_agent_id: str,
) -> dict[str, Any]:
    """Assign an existing parent todo to a child agent and mark it active."""
    clean_id = validate_todo_exists(owner_agent_id=owner_agent_id, todo_id=todo_id)
    agent_todos = _get_agent_todos(owner_agent_id)
    timestamp = datetime.now(UTC).isoformat()
    todo = agent_todos[clean_id]
    todo["linked_agent_id"] = str(linked_agent_id)
    todo["status"] = "in_progress"
    todo["started_at"] = todo.get("started_at") or timestamp
    todo["completed_at"] = None
    todo["updated_at"] = timestamp
    _persist()
    return {**todo, "todo_id": clean_id}


def complete_bound_todos(*, linked_agent_id: str, success: bool = True) -> list[dict[str, Any]]:
    """Resolve todos assigned to a child agent after agent_finish."""
    if not success:
        return resolve_bound_todos(linked_agent_id=linked_agent_id, status="failed")
    return resolve_bound_todos(linked_agent_id=linked_agent_id, status="done")


def resolve_bound_todos(
    *,
    linked_agent_id: str,
    status: str,
    reason: str | None = None,
) -> list[dict[str, Any]]:
    """Mark parent todos assigned to a child as terminal."""
    normalized_status = str(status or "").strip().lower()
    if normalized_status not in TERMINAL_INTERNAL_STATUSES:
        raise ValueError(
            "Invalid terminal todo status. Must be one of: "
            + ", ".join(sorted(TERMINAL_INTERNAL_STATUSES)),
        )
    timestamp = datetime.now(UTC).isoformat()
    resolved: list[dict[str, Any]] = []
    for owner_agent_id, agent_todos in _todos_storage.items():
        for todo_id, todo in agent_todos.items():
            if str(todo.get("linked_agent_id") or "") != str(linked_agent_id):
                continue
            if str(todo.get("status") or "").lower() in TERMINAL_INTERNAL_STATUSES:
                continue
            todo["status"] = normalized_status
            todo["completed_at"] = timestamp
            todo["updated_at"] = timestamp
            if reason:
                todo["resolution_reason"] = str(reason).strip()
            resolved.append({**todo, "todo_id": todo_id, "owner_agent_id": owner_agent_id})
    if resolved:
        _persist()
    return resolved


def active_parent_todo_id(owner_agent_id: str) -> str | None:
    """Return a single active unbound parent todo, if one is unambiguous."""
    active = [
        todo_id
        for todo_id, todo in _get_agent_todos(owner_agent_id).items()
        if str(todo.get("status") or "").lower() == "in_progress"
        and not str(todo.get("linked_agent_id") or "").strip()
    ]
    return active[0] if len(active) == 1 else None


def reconcile_bound_todos_with_agent_statuses(agent_statuses: dict[str, str]) -> list[dict[str, Any]]:
    """Resolve bound todos whose linked agent is already terminal."""
    resolved: list[dict[str, Any]] = []
    for agent_id, status in agent_statuses.items():
        normalized_status = str(status or "").strip().lower()
        if normalized_status in {"failed", "crashed"}:
            resolved.extend(resolve_bound_todos(
                linked_agent_id=agent_id,
                status="failed",
                reason=f"Agent ended with status {normalized_status}",
            ))
        elif normalized_status == "stopped":
            resolved.extend(resolve_bound_todos(
                linked_agent_id=agent_id,
                status="skipped",
                reason=f"Agent ended with status {normalized_status}",
            ))
    return resolved


def _normalize_todo_ids(raw_ids: Any) -> list[str]:
    if raw_ids is None:
        return []
    if isinstance(raw_ids, str):
        stripped = raw_ids.strip()
        if not stripped:
            return []
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError:
            data = stripped.split(",") if "," in stripped else [stripped]
        if isinstance(data, list):
            return [str(item).strip() for item in data if str(item).strip()]
        return [str(data).strip()]
    if isinstance(raw_ids, list):
        return [str(item).strip() for item in raw_ids if str(item).strip()]
    return [str(raw_ids).strip()]


def unfinished_todos_for_agent(agent_id: str) -> list[dict[str, Any]]:
    """Return unresolved todos for an agent."""
    unresolved = [
        {**todo, "todo_id": todo_id}
        for todo_id, todo in _get_agent_todos(agent_id).items()
        if str(todo.get("status") or "").lower() not in TERMINAL_INTERNAL_STATUSES
    ]
    unresolved.sort(key=_todo_sort_key)
    return unresolved


def _normalize_bulk_updates(raw_updates: Any) -> list[dict[str, Any]]:
    if raw_updates is None:
        return []
    data: Any = raw_updates
    if isinstance(raw_updates, str):
        stripped = raw_updates.strip()
        if not stripped:
            return []
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError as e:
            raise ValueError("Updates must be valid JSON") from e

    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        raise TypeError("Updates must be a list of update objects")

    normalized: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            raise TypeError("Each update must be an object with todo_id")
        todo_id = item.get("todo_id") or item.get("id")
        if not todo_id:
            raise ValueError("Each update must include 'todo_id'")
        normalized.append(
            {
                "todo_id": str(todo_id).strip(),
                "title": item.get("title"),
                "description": item.get("description"),
                "priority": item.get("priority"),
                "status": item.get("status"),
                **{field: item.get(field) for field in TODO_DETAIL_FIELDS if field in item},
            },
        )
    return normalized


def _normalize_bulk_todos(raw_todos: Any) -> list[dict[str, Any]]:
    if raw_todos is None:
        return []
    data: Any = raw_todos
    if isinstance(raw_todos, str):
        stripped = raw_todos.strip()
        if not stripped:
            return []
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError:
            entries = [line.strip(" -*\t") for line in stripped.splitlines() if line.strip(" -*\t")]
            return [{"title": entry} for entry in entries]

    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        raise TypeError("Todos must be provided as a list, dict, or JSON string")

    normalized: list[dict[str, Any]] = []
    for item in data:
        if isinstance(item, str):
            title = item.strip()
            if title:
                normalized.append({"title": title})
            continue
        if not isinstance(item, dict):
            raise TypeError("Each todo entry must be a string or object with a title")
        title = item.get("title", "")
        if not isinstance(title, str) or not title.strip():
            raise ValueError("Each todo entry must include a non-empty 'title'")
        normalized.append(
            {
                "title": title.strip(),
                "description": (item.get("description") or "").strip() or None,
                "priority": item.get("priority"),
                **{field: item.get(field) for field in TODO_DETAIL_FIELDS if field in item},
            },
        )
    return normalized


def _has_todo_detail(task: dict[str, Any]) -> bool:
    if str(task.get("description") or "").strip():
        return True
    return any(str(task.get(field) or "").strip() for field in TODO_DETAIL_FIELDS)


def _is_generic_testing_todo(task: dict[str, Any]) -> bool:
    title = str(task.get("title") or "")
    if is_recon_task(name=title, task=str(task.get("description") or "")):
        return False
    lowered = title.lower()
    return any(marker in lowered for marker in _GENERIC_TEST_MARKERS)


def _apply_single_update(
    agent_todos: dict[str, dict[str, Any]],
    todo_id: str,
    title: str | None = None,
    description: str | None = None,
    priority: str | None = None,
    status: str | None = None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if todo_id not in agent_todos:
        return {"todo_id": todo_id, "error": f"Todo with ID '{todo_id}' not found"}
    todo = agent_todos[todo_id]
    if title is not None:
        if not title.strip():
            return {"todo_id": todo_id, "error": "Title cannot be empty"}
        todo["title"] = title.strip()
    if description is not None:
        todo["description"] = description.strip() if description else None
    if priority is not None:
        try:
            todo["priority"] = _normalize_priority(priority, str(todo.get("priority", "normal")))
        except ValueError as exc:
            return {"todo_id": todo_id, "error": str(exc)}
    if details:
        for field, value in details.items():
            if field not in TODO_DETAIL_FIELDS:
                continue
            text = str(value or "").strip()
            if text:
                todo[field] = text
            elif field in todo:
                todo.pop(field, None)
    if status is not None:
        status_candidate = status.lower()
        if status_candidate not in VALID_STATUSES:
            return {
                "todo_id": todo_id,
                "error": f"Invalid status. Must be one of: {', '.join(VALID_STATUSES)}",
            }
        current_status = str(todo.get("status") or "pending").lower()
        if status_candidate == "done" and current_status != "in_progress":
            return {
                "todo_id": todo_id,
                "error": "Todo must be in_progress before it can be marked done",
            }
        timestamp = datetime.now(UTC).isoformat()
        todo["status"] = status_candidate
        if status_candidate == "in_progress":
            todo["started_at"] = todo.get("started_at") or timestamp
            todo["completed_at"] = None
        elif status_candidate == "done":
            todo["completed_at"] = timestamp
        else:
            todo["completed_at"] = None
        todo["updated_at"] = timestamp
        return None
    todo["updated_at"] = datetime.now(UTC).isoformat()
    return None


@function_tool(timeout=30)
async def create_todo(ctx: RunContextWrapper, todos: Any) -> str:
    """Create one or many todos for the current agent.

    Always pass a list, even for a single todo (wrap it in a one-item array).

    Each agent (including subagents) has its **own private todo list** —
    your todos don't leak to other agents and vice versa.

    When to use:

    - Planning multi-step assessments with parallel workstreams.
    - Tracking work you'll come back to later.
    - Breaking down complex scopes (per-endpoint, per-target, per-vuln-class).

    When NOT to use:

    - Simple linear workflows where progress is obvious.
    - Single quick task — just do it.

    Args:
        todos: array of todo objects, a single todo object, or a JSON string.
            For one todo, prefer a one-item list. Each object's fields:

            - ``title`` (str, **required**): short actionable title,
              e.g. ``"Test /api/admin for IDOR"``.
            - ``description`` (str, optional): extra context or
              acceptance criteria.
            - ``priority`` (str, optional): one of ``"low"`` /
              ``"normal"`` / ``"high"`` / ``"critical"``. Defaults to
              ``"normal"``.

            Example: ``[{"title": "Probe /admin", "priority": "high"},
            {"title": "Check JWT alg=none"}]``.
    """
    agent_id = _agent_id_from(ctx)
    try:
        tasks = _normalize_bulk_todos(todos)
        if not tasks:
            return json.dumps(
                {"success": False, "error": "Provide a non-empty 'todos' list to create"},
                ensure_ascii=False,
                default=str,
            )
        if _is_root_agent(ctx):
            generic_without_detail = [
                task.get("title")
                for task in tasks
                if _is_generic_testing_todo(task) and not _has_todo_detail(task)
            ]
            if generic_without_detail:
                return json.dumps(
                    {
                        "success": False,
                        "error": (
                            "Root vulnerability-testing todos must include endpoint/detail fields "
                            "or a concrete description. Create recon/mapping todos first, then "
                            "endpoint-level test todos from recorded attack surface."
                        ),
                        "generic_todos": generic_without_detail,
                    },
                    ensure_ascii=False,
                    default=str,
                )

        normalized_tasks = [
            {**task, "priority": _normalize_priority(task.get("priority"))}
            for task in tasks
        ]
        agent_todos = _get_agent_todos(agent_id)
        created: list[dict[str, Any]] = []
        for task in normalized_tasks:
            task_priority = task["priority"]
            todo_id = str(uuid.uuid4())[:6]
            timestamp = datetime.now(UTC).isoformat()
            agent_todos[todo_id] = {
                "title": task["title"],
                "description": task.get("description"),
                "priority": task_priority,
                "status": "pending",
                "order_index": _next_order_index(agent_todos),
                "created_at": timestamp,
                "updated_at": timestamp,
                "completed_at": None,
                **{
                    field: str(task.get(field)).strip()
                    for field in TODO_DETAIL_FIELDS
                    if str(task.get(field) or "").strip()
                },
            }
            created.append({"todo_id": todo_id, "title": task["title"], "priority": task_priority})
    except (ValueError, TypeError) as e:
        return json.dumps(
            {"success": False, "error": f"Failed to create todo: {e}"},
            ensure_ascii=False,
            default=str,
        )

    _persist()
    return json.dumps(
        {
            "success": True,
            "created": created,
            "created_count": len(created),
            "todos": _sorted_todos(agent_id),
            "total_count": len(_get_agent_todos(agent_id)),
        },
        ensure_ascii=False,
        default=str,
    )


@function_tool(timeout=30)
async def list_todos(
    ctx: RunContextWrapper,
    status: str | None = None,
    priority: str | None = None,
) -> str:
    """List the current agent's todos, sorted by status then priority.

    Sort order: status (done → in_progress → pending), then priority
    within each status (critical → high → normal → low).

    Args:
        status: Filter — ``"pending"`` / ``"in_progress"`` / ``"done"``.
        priority: Filter — ``"low"`` / ``"normal"`` / ``"high"`` /
            ``"critical"``.
    """
    agent_id = _agent_id_from(ctx)
    try:
        agent_todos = _get_agent_todos(agent_id)
        status_filter = status.lower() if isinstance(status, str) else None
        priority_filter = priority.lower() if isinstance(priority, str) else None

        todos_list: list[dict[str, Any]] = []
        for todo_id, todo in agent_todos.items():
            if status_filter and todo.get("status") != status_filter:
                continue
            if priority_filter and todo.get("priority") != priority_filter:
                continue
            entry = todo.copy()
            entry["todo_id"] = todo_id
            todos_list.append(entry)

        todos_list.sort(key=_todo_sort_key)

        summary: dict[str, int] = {"pending": 0, "in_progress": 0, "done": 0}
        for todo in todos_list:
            sv = todo.get("status", "pending")
            summary[sv] = summary.get(sv, 0) + 1
    except (ValueError, TypeError) as e:
        return json.dumps(
            {
                "success": False,
                "error": f"Failed to list todos: {e}",
                "todos": [],
                "filtered_count": 0,
                "total_count": 0,
                "summary": {"pending": 0, "in_progress": 0, "done": 0},
            },
            ensure_ascii=False,
            default=str,
        )

    return json.dumps(
        {
            "success": True,
            "todos": todos_list,
            "filtered_count": len(todos_list),
            "total_count": len(agent_todos),
            "summary": summary,
        },
        ensure_ascii=False,
        default=str,
    )


@function_tool(timeout=30)
async def update_todo(ctx: RunContextWrapper, updates: Any) -> str:
    """Update one or many todos.

    Always pass a list, even for a single update (wrap it in a one-item
    array).

    For toggling status only, prefer the dedicated ``mark_todo_done`` /
    ``mark_todo_pending`` tools — they're simpler and accept the same
    list-of-ids form.

    Args:
        updates: JSON array of update objects. For one update, pass a
            one-item list. Each object's fields:

            - ``todo_id`` (str, **required**): ID returned by
              ``create_todo``.
            - ``title`` (str, optional): new title.
            - ``description`` (str, optional): new description (empty
              string clears it).
            - ``priority`` (str, optional): one of ``"low"`` /
              ``"normal"`` / ``"high"`` / ``"critical"``.
            - ``status`` (str, optional): one of ``"pending"`` /
              ``"in_progress"`` / ``"done"``.

            Omitted fields stay unchanged. Example:
            ``[{"todo_id": "abc", "status": "in_progress",
            "priority": "high"}]``.
    """
    agent_id = _agent_id_from(ctx)
    try:
        agent_todos = _get_agent_todos(agent_id)
        updates_to_apply = _normalize_bulk_updates(updates)
        if not updates_to_apply:
            return json.dumps(
                {"success": False, "error": "Provide a non-empty 'updates' list"},
                ensure_ascii=False,
                default=str,
            )

        state_dir = _state_dir_from(ctx)
        root_agent = _is_root_agent(ctx)
        root_phase_errors = (
            _single_root_phase_transition_errors(agent_todos, updates_to_apply)
            if root_agent
            else []
        )
        if root_phase_errors:
            return json.dumps(
                {
                    "success": False,
                    "updated": [],
                    "updated_count": 0,
                    "todos": _sorted_todos(agent_id),
                    "total_count": len(agent_todos),
                    "errors": root_phase_errors,
                },
                ensure_ascii=False,
                default=str,
            )

        updated: list[str] = []
        errors: list[dict[str, Any]] = []
        for upd in updates_to_apply:
            existing = agent_todos.get(upd["todo_id"])
            if (
                root_agent
                and existing is not None
                and str(upd.get("status") or "").strip().lower() == "done"
            ):
                completion_error = _root_phase_completion_error(
                    upd["todo_id"],
                    existing,
                    state_dir,
                )
                if completion_error:
                    errors.append(completion_error)
                    continue
            err = _apply_single_update(
                agent_todos,
                upd["todo_id"],
                upd.get("title"),
                upd.get("description"),
                upd.get("priority"),
                upd.get("status"),
                {field: upd.get(field) for field in TODO_DETAIL_FIELDS if field in upd},
            )
            if err:
                errors.append(err)
            else:
                updated.append(upd["todo_id"])
    except (ValueError, TypeError) as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False, default=str)

    if updated:
        _persist()
    response: dict[str, Any] = {
        "success": len(errors) == 0,
        "updated": updated,
        "updated_count": len(updated),
        "todos": _sorted_todos(agent_id),
        "total_count": len(agent_todos),
    }
    if errors:
        response["errors"] = errors
    return json.dumps(response, ensure_ascii=False, default=str)


def _mark(
    *,
    agent_id: str,
    todo_ids: Any,
    new_status: str,
    root_agent: bool = False,
    state_dir: Path | None = None,
) -> str:
    try:
        agent_todos = _get_agent_todos(agent_id)
        ids = _normalize_todo_ids(todo_ids)
        if not ids:
            msg = f"Provide a non-empty 'todo_ids' list to mark as {new_status}"
            return json.dumps({"success": False, "error": msg}, ensure_ascii=False, default=str)

        root_phase_errors = (
            _single_root_phase_transition_errors(
                agent_todos,
                [{"todo_id": tid, "status": new_status} for tid in ids],
            )
            if root_agent and new_status in {"in_progress", "done"}
            else []
        )
        if root_phase_errors:
            return json.dumps(
                {
                    "success": False,
                    "marked": [],
                    "marked_count": 0,
                    "new_status": new_status,
                    "todos": _sorted_todos(agent_id),
                    "total_count": len(agent_todos),
                    "errors": root_phase_errors,
                },
                ensure_ascii=False,
                default=str,
            )

        marked: list[str] = []
        errors: list[dict[str, Any]] = []
        timestamp = datetime.now(UTC).isoformat()
        for tid in ids:
            if tid not in agent_todos:
                errors.append({"todo_id": tid, "error": f"Todo with ID '{tid}' not found"})
                continue
            todo = agent_todos[tid]
            current_status = str(todo.get("status") or "pending").lower()
            if new_status == "done" and current_status != "in_progress":
                errors.append({
                    "todo_id": tid,
                    "error": "Todo must be in_progress before it can be marked done",
                })
                continue
            if root_agent and new_status == "done":
                completion_error = _root_phase_completion_error(tid, todo, state_dir)
                if completion_error:
                    errors.append(completion_error)
                    continue
            todo["status"] = new_status
            todo["completed_at"] = timestamp if new_status == "done" else None
            if new_status == "pending":
                todo["started_at"] = None
            elif new_status == "done":
                todo["started_at"] = todo.get("started_at") or timestamp
            todo["updated_at"] = timestamp
            marked.append(tid)
    except (ValueError, TypeError) as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False, default=str)

    if marked:
        _persist()
    response: dict[str, Any] = {
        "success": len(errors) == 0,
        "marked": marked,
        "marked_count": len(marked),
        "new_status": new_status,
        "todos": _sorted_todos(agent_id),
        "total_count": len(agent_todos),
    }
    if errors:
        response["errors"] = errors
    return json.dumps(response, ensure_ascii=False, default=str)


@function_tool(timeout=30)
async def mark_todo_done(ctx: RunContextWrapper, todo_ids: Any) -> str:
    """Mark one or many todos as done.

    Always pass a list, even for a single ID (wrap it in a one-item array).

    Args:
        todo_ids: array of todo IDs, a single todo ID, or a JSON string.
    """
    return _mark(
        agent_id=_agent_id_from(ctx),
        todo_ids=todo_ids,
        new_status="done",
        root_agent=_is_root_agent(ctx),
        state_dir=_state_dir_from(ctx),
    )


@function_tool(timeout=30)
async def mark_todo_pending(ctx: RunContextWrapper, todo_ids: Any) -> str:
    """Reset one or many todos to pending (e.g., to retry a failed task).

    Always pass a list, even for a single ID (wrap it in a one-item array).

    Args:
        todo_ids: array of todo IDs, a single todo ID, or a JSON string.
    """
    return _mark(
        agent_id=_agent_id_from(ctx),
        todo_ids=todo_ids,
        new_status="pending",
        root_agent=_is_root_agent(ctx),
        state_dir=_state_dir_from(ctx),
    )


@function_tool(timeout=30)
async def delete_todo(ctx: RunContextWrapper, todo_ids: Any) -> str:
    """Archive one or many completed todos without removing plan history.

    Unfinished todos cannot be deleted. This prevents bypassing lifecycle
    checks by removing pending work before ``finish_scan``.

    Always pass a list, even for a single ID (wrap it in a one-item array).

    Args:
        todo_ids: array of todo IDs, a single todo ID, or a JSON string.
    """
    agent_id = _agent_id_from(ctx)
    try:
        agent_todos = _get_agent_todos(agent_id)
        ids = _normalize_todo_ids(todo_ids)
        if not ids:
            return json.dumps(
                {"success": False, "error": "Provide a non-empty 'todo_ids' list to delete"},
                ensure_ascii=False,
                default=str,
            )

        archived: list[str] = []
        errors: list[dict[str, Any]] = []
        timestamp = datetime.now(UTC).isoformat()
        for tid in ids:
            if tid not in agent_todos:
                errors.append({"todo_id": tid, "error": f"Todo with ID '{tid}' not found"})
                continue
            todo = agent_todos[tid]
            status = str(todo.get("status") or "pending").lower()
            if status != "done":
                errors.append({
                    "todo_id": tid,
                    "error": (
                        "Cannot delete unfinished todo; mark it in_progress and then done "
                        "after completing the work"
                    ),
                })
                continue
            todo["archived_at"] = todo.get("archived_at") or timestamp
            todo["updated_at"] = timestamp
            archived.append(tid)
    except (ValueError, TypeError) as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False, default=str)

    if archived:
        _persist()
    response: dict[str, Any] = {
        "success": len(errors) == 0,
        "deleted": archived,
        "deleted_count": len(archived),
        "archived": archived,
        "archived_count": len(archived),
        "todos": _sorted_todos(agent_id),
        "total_count": len(agent_todos),
    }
    if errors:
        response["errors"] = errors
    return json.dumps(response, ensure_ascii=False, default=str)
