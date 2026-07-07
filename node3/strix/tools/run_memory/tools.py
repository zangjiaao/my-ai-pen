"""Per-run attack-surface, coverage, and evidence memory.

The tools in this module intentionally mirror small JSON ledgers under
``{run_dir}/.state`` so resumed agents and platform checkpoints can rely on
structured state instead of only conversation history.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import tempfile
import threading
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agents import RunContextWrapper, function_tool


logger = logging.getLogger(__name__)

_memory_lock = threading.RLock()
_state_dir: Path | None = None
_attack_surface: dict[str, dict[str, Any]] = {}
_coverage: dict[str, dict[str, Any]] = {}
_evidence: dict[str, dict[str, Any]] = {}
_DB_FILENAME = "run_memory.db"

_VALID_SURFACE_KINDS = {
    "url",
    "api_endpoint",
    "form",
    "auth_endpoint",
    "admin_endpoint",
    "file_upload",
    "static_asset",
    "websocket",
    "service",
    "repository",
    "other",
}
_VALID_COVERAGE_STATUSES = {
    "planned",
    "in_progress",
    "tried",
    "passed",
    "failed",
    "blocked",
    "skipped",
}
_VALID_EVIDENCE_TYPES = {
    "http_trace",
    "tool_output",
    "screenshot",
    "artifact",
    "note",
    "manual_observation",
    "other",
}


def hydrate_memory_from_disk(state_dir: Path) -> None:
    global _state_dir  # noqa: PLW0603
    with _memory_lock:
        _state_dir = state_dir
        state_dir.mkdir(parents=True, exist_ok=True)
        _ensure_db()
        _import_json_if_table_empty("attack_surface", "surface_id", _path("attack_surface.json"))
        _import_json_if_table_empty("coverage", "coverage_id", _path("coverage.json"))
        _import_json_if_table_empty("evidence", "evidence_id", _path("evidence.json"))
        _reload_cache_from_db()
        _export_json_snapshots()
        logger.info(
            "memory hydrated from %s (%d surface, %d coverage, %d evidence)",
            state_dir,
            len(_attack_surface),
            len(_coverage),
            len(_evidence),
        )


def attack_surface_from_file(path: Path) -> list[dict[str, Any]]:
    return _load_from_db_near(path, "attack_surface", "surface_id") or _load_list(path, "surface_id")


def coverage_from_file(path: Path) -> list[dict[str, Any]]:
    return _load_from_db_near(path, "coverage", "coverage_id") or _load_list(path, "coverage_id")


def evidence_from_file(path: Path) -> list[dict[str, Any]]:
    return _load_from_db_near(path, "evidence", "evidence_id") or _load_list(path, "evidence_id")


def evidence_exists(evidence_ids: list[str]) -> bool:
    with _memory_lock:
        return all(eid in _evidence for eid in evidence_ids)


def missing_evidence_ids(evidence_ids: list[str]) -> list[str]:
    if _state_dir is None:
        return []
    with _memory_lock:
        return [eid for eid in evidence_ids if eid not in _evidence]


def missing_evidence_ids_in_state(state_dir: Path | None, evidence_ids: list[str]) -> list[str]:
    if state_dir is None:
        return missing_evidence_ids(evidence_ids)
    db_path = state_dir / _DB_FILENAME
    if db_path.exists():
        rows = _rows_by_id("evidence", "evidence_id", db_path)
    else:
        rows = {}
    if not rows:
        rows = {
            str(item.get("evidence_id")): item
            for item in _load_list(state_dir / "evidence.json", "evidence_id")
            if str(item.get("evidence_id") or "").strip()
        }
    return [eid for eid in evidence_ids if eid not in rows]


def state_dir_from_context(ctx: RunContextWrapper | dict[str, Any] | None) -> Path | None:
    inner = ctx.context if isinstance(ctx, RunContextWrapper) else ctx
    if not isinstance(inner, dict):
        return None
    raw = inner.get("state_dir")
    if isinstance(raw, Path):
        return raw
    if isinstance(raw, str) and raw.strip():
        return Path(raw)
    return None


@contextmanager
def _bound_state_dir(state_dir: Path | None):
    global _state_dir  # noqa: PLW0603
    if state_dir is None:
        yield
        return
    with _memory_lock:
        previous = _state_dir
        if previous != state_dir:
            hydrate_memory_from_disk(state_dir)
        try:
            yield
        finally:
            if previous is not None and previous != _state_dir:
                hydrate_memory_from_disk(previous)


def _path(filename: str) -> Path:
    if _state_dir is None:
        return Path(filename)
    return _state_dir / filename


def _db_path() -> Path:
    return _path(_DB_FILENAME)


def _connect(path: Path | None = None) -> sqlite3.Connection:
    db_path = path or _db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def _ensure_db() -> None:
    _ensure_db_at(_db_path())


def _ensure_db_at(path: Path) -> None:
    with _connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS attack_surface (
                surface_id TEXT PRIMARY KEY,
                dedupe_key TEXT UNIQUE NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS coverage (
                coverage_id TEXT PRIMARY KEY,
                dedupe_key TEXT UNIQUE NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS evidence (
                evidence_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )


def _table_empty(table: str) -> bool:
    with _connect() as conn:
        row = conn.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()
    return int(row["count"] if row else 0) == 0


def _import_json_if_table_empty(table: str, id_field: str, path: Path) -> None:
    if not _table_empty(table):
        return
    rows = _load_list(path, id_field)
    if not rows:
        return
    with _connect() as conn:
        for item in rows:
            item_id = str(item.get(id_field) or "").strip()
            if not item_id:
                continue
            created_at = str(item.get("created_at") or _now())
            updated_at = str(item.get("updated_at") or created_at)
            if table == "attack_surface":
                dedupe_key = str(item.get("dedupe_key") or _surface_key(
                    str(item.get("kind") or "other"),
                    item.get("method"),
                    item.get("url"),
                    item.get("address"),
                ))
                conn.execute(
                    "INSERT OR IGNORE INTO attack_surface(surface_id, dedupe_key, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (item_id, dedupe_key, json.dumps(item, ensure_ascii=False, default=str), created_at, updated_at),
                )
            elif table == "coverage":
                dedupe_key = str(item.get("dedupe_key") or _coverage_key(
                    str(item.get("endpoint") or ""),
                    str(item.get("parameter") or "<none>"),
                    str(item.get("vuln_type") or ""),
                    item.get("auth_state"),
                ))
                conn.execute(
                    "INSERT OR IGNORE INTO coverage(coverage_id, dedupe_key, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (item_id, dedupe_key, json.dumps(item, ensure_ascii=False, default=str), created_at, updated_at),
                )
            elif table == "evidence":
                conn.execute(
                    "INSERT OR IGNORE INTO evidence(evidence_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)",
                    (item_id, json.dumps(item, ensure_ascii=False, default=str), created_at, updated_at),
                )


def _reload_cache_from_db() -> None:
    _attack_surface.clear()
    _coverage.clear()
    _evidence.clear()
    _attack_surface.update(_rows_by_id("attack_surface", "surface_id"))
    _coverage.update(_rows_by_id("coverage", "coverage_id"))
    _evidence.update(_rows_by_id("evidence", "evidence_id"))


def _rows_by_id(table: str, id_field: str, path: Path | None = None) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    try:
        with _connect(path) as conn:
            cursor = conn.execute(f"SELECT {id_field}, payload FROM {table} ORDER BY created_at ASC")
            for row in cursor.fetchall():
                item = _decode_payload(row["payload"])
                item_id = str(item.get(id_field) or row[id_field] or "").strip()
                if item_id:
                    item[id_field] = item_id
                    rows[item_id] = item
    except sqlite3.Error:
        logger.exception("failed to read %s from run memory db", table)
    return rows


def _load_from_db_near(path: Path, table: str, id_field: str) -> list[dict[str, Any]]:
    db_path = path.parent / _DB_FILENAME
    if not db_path.exists():
        return []
    rows = _rows_by_id(table, id_field, db_path)
    return _sorted_values(rows)


def _decode_payload(payload: str) -> dict[str, Any]:
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _export_json_snapshots() -> None:
    _persist(_path("attack_surface.json"), _sorted_values(_attack_surface))
    _persist(_path("coverage.json"), _sorted_values(_coverage))
    _persist(_path("evidence.json"), _sorted_values(_evidence))


def _load_list(path: Path, id_field: str) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.exception("memory file %s is unreadable", path)
        return []
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, dict):
        return [
            {**item, id_field: item.get(id_field) or item_id}
            for item_id, item in raw.items()
            if isinstance(item_id, str) and isinstance(item, dict)
        ]
    return []


def _persist(path: Path, payload: list[dict[str, Any]]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(path.parent),
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as tmp:
            tmp.write(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
            tmp_path = Path(tmp.name)
        tmp_path.replace(path)
    except Exception:
        logger.exception("memory persist to %s failed", path)


def _sorted_values(items: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(items.values(), key=lambda item: str(item.get("created_at") or ""))


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _new_id(prefix: str, existing: dict[str, dict[str, Any]]) -> str:
    for _ in range(1024):
        item_id = f"{prefix}-{uuid.uuid4().hex[:10]}"
        if item_id not in existing:
            return item_id
    raise RuntimeError(f"failed to allocate unique {prefix} id")


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _clean_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            parsed = stripped.split(",")
        value = parsed
    if not isinstance(value, list):
        value = [value]
    cleaned: list[str] = []
    for item in value:
        text = _clean_text(item)
        if text and text not in cleaned:
            cleaned.append(text)
    return cleaned


def _agent_id_from(ctx: RunContextWrapper) -> str | None:
    inner = ctx.context if isinstance(ctx.context, dict) else {}
    raw = inner.get("agent_id")
    return raw if isinstance(raw, str) and raw.strip() else None


def _surface_key(kind: str, method: str | None, url: str | None, address: str | None) -> str:
    return "|".join(
        [
            kind.lower(),
            (method or "").upper(),
            (url or "").rstrip("/"),
            (address or "").lower(),
        ],
    )


def _coverage_key(endpoint: str, parameter: str, vuln_type: str, auth_state: str | None) -> str:
    return "|".join([endpoint.strip(), parameter.strip(), vuln_type.strip().lower(), (auth_state or "").strip().lower()])


def _find_by_key(items: dict[str, dict[str, Any]], key_field: str, key: str) -> dict[str, Any] | None:
    return next((item for item in items.values() if item.get(key_field) == key), None)


def _save_attack_surface(item: dict[str, Any]) -> None:
    _ensure_db()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO attack_surface(surface_id, dedupe_key, payload, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(dedupe_key) DO UPDATE SET
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (
                item["surface_id"],
                item["dedupe_key"],
                json.dumps(item, ensure_ascii=False, default=str),
                item["created_at"],
                item["updated_at"],
            ),
        )
    _reload_cache_from_db()
    _export_json_snapshots()


def _save_coverage(item: dict[str, Any]) -> None:
    _ensure_db()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO coverage(coverage_id, dedupe_key, payload, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(dedupe_key) DO UPDATE SET
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (
                item["coverage_id"],
                item["dedupe_key"],
                json.dumps(item, ensure_ascii=False, default=str),
                item["created_at"],
                item["updated_at"],
            ),
        )
    _reload_cache_from_db()
    _export_json_snapshots()


def _save_evidence(item: dict[str, Any]) -> None:
    _ensure_db()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO evidence(evidence_id, payload, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                item["evidence_id"],
                json.dumps(item, ensure_ascii=False, default=str),
                item["created_at"],
                item["updated_at"],
            ),
        )
    _reload_cache_from_db()
    _export_json_snapshots()


def _record_attack_surface_impl(
    *,
    kind: str,
    url: str | None,
    method: str | None,
    parameters: list[str] | str | None,
    auth_state: str | None,
    role: str | None,
    source: str | None,
    evidence_ids: list[str] | str | None,
    notes: str | None,
    address: str | None,
    agent_id: str | None,
) -> dict[str, Any]:
    with _memory_lock:
        clean_kind = _clean_text(kind).lower()
        if clean_kind not in _VALID_SURFACE_KINDS:
            return {"success": False, "error": f"kind must be one of: {', '.join(sorted(_VALID_SURFACE_KINDS))}"}
        clean_url = _clean_text(url) or None
        clean_address = _clean_text(address) or None
        if not clean_url and not clean_address:
            return {"success": False, "error": "Provide url or address"}
        clean_method = (_clean_text(method).upper() or None)
        clean_params = _clean_list(parameters)
        clean_evidence_ids = _clean_list(evidence_ids)
        missing = missing_evidence_ids(clean_evidence_ids)
        if missing:
            return {
                "success": False,
                "error": "Unknown evidence_ids; call record_evidence first and cite the returned IDs",
                "missing_evidence_ids": missing,
            }
        key = _surface_key(clean_kind, clean_method, clean_url, clean_address)
        timestamp = _now()
        existing = _find_by_key(_attack_surface, "dedupe_key", key)
        if existing:
            existing["updated_at"] = timestamp
            existing["parameters"] = sorted(set(existing.get("parameters") or []) | set(clean_params))
            existing["evidence_ids"] = sorted(set(existing.get("evidence_ids") or []) | set(clean_evidence_ids))
            for field, value in {
                "auth_state": _clean_text(auth_state) or None,
                "role": _clean_text(role) or None,
                "source": _clean_text(source) or None,
                "notes": _clean_text(notes) or None,
                "agent_id": agent_id,
            }.items():
                if value:
                    existing[field] = value
            _save_attack_surface(existing)
            surface = _find_by_key(_attack_surface, "dedupe_key", key) or existing
            return {"success": True, "status": "updated", "surface": dict(surface)}

        surface_id = _new_id("as", _attack_surface)
        item = {
            "surface_id": surface_id,
            "kind": clean_kind,
            "url": clean_url,
            "address": clean_address,
            "method": clean_method,
            "parameters": clean_params,
            "auth_state": _clean_text(auth_state) or None,
            "role": _clean_text(role) or None,
            "source": _clean_text(source) or None,
            "evidence_ids": clean_evidence_ids,
            "notes": _clean_text(notes) or None,
            "agent_id": agent_id,
            "dedupe_key": key,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        clean_item = {k: v for k, v in item.items() if v not in (None, [], "")}
        _save_attack_surface(clean_item)
        return {"success": True, "status": "created", "surface": dict(_attack_surface[surface_id])}


def _record_coverage_impl(
    *,
    endpoint: str,
    vuln_type: str,
    status: str,
    parameter: str | None,
    auth_state: str | None,
    evidence_ids: list[str] | str | None,
    result: str | None,
    notes: str | None,
    agent_id: str | None,
) -> dict[str, Any]:
    with _memory_lock:
        clean_endpoint = _clean_text(endpoint)
        clean_vuln_type = _clean_text(vuln_type).lower()
        clean_status = _clean_text(status).lower()
        if not clean_endpoint:
            return {"success": False, "error": "endpoint cannot be empty"}
        if not clean_vuln_type:
            return {"success": False, "error": "vuln_type cannot be empty"}
        if clean_status not in _VALID_COVERAGE_STATUSES:
            return {"success": False, "error": f"status must be one of: {', '.join(sorted(_VALID_COVERAGE_STATUSES))}"}
        clean_parameter = _clean_text(parameter) or "<none>"
        clean_auth_state = _clean_text(auth_state) or None
        clean_evidence_ids = _clean_list(evidence_ids)
        missing = missing_evidence_ids(clean_evidence_ids)
        if missing:
            return {
                "success": False,
                "error": "Unknown evidence_ids; call record_evidence first and cite the returned IDs",
                "missing_evidence_ids": missing,
            }
        key = _coverage_key(clean_endpoint, clean_parameter, clean_vuln_type, clean_auth_state)
        timestamp = _now()
        existing = _find_by_key(_coverage, "dedupe_key", key)
        if existing:
            existing.update(
                {
                    "status": clean_status,
                    "result": _clean_text(result) or existing.get("result"),
                    "notes": _clean_text(notes) or existing.get("notes"),
                    "updated_at": timestamp,
                    "agent_id": agent_id or existing.get("agent_id"),
                },
            )
            existing["evidence_ids"] = sorted(set(existing.get("evidence_ids") or []) | set(clean_evidence_ids))
            _save_coverage(existing)
            coverage = _find_by_key(_coverage, "dedupe_key", key) or existing
            return {"success": True, "status": "updated", "coverage": dict(coverage)}

        coverage_id = _new_id("cov", _coverage)
        item = {
            "coverage_id": coverage_id,
            "endpoint": clean_endpoint,
            "parameter": clean_parameter,
            "vuln_type": clean_vuln_type,
            "status": clean_status,
            "auth_state": clean_auth_state,
            "evidence_ids": clean_evidence_ids,
            "result": _clean_text(result) or None,
            "notes": _clean_text(notes) or None,
            "agent_id": agent_id,
            "dedupe_key": key,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        clean_item = {k: v for k, v in item.items() if v not in (None, [], "")}
        _save_coverage(clean_item)
        return {"success": True, "status": "created", "coverage": dict(_coverage[coverage_id])}


def _record_evidence_impl(
    *,
    evidence_type: str,
    summary: str,
    content: str | None,
    source_tool: str | None,
    target: str | None,
    metadata: dict[str, Any] | str | None,
    agent_id: str | None,
) -> dict[str, Any]:
    with _memory_lock:
        clean_type = _clean_text(evidence_type).lower()
        if clean_type not in _VALID_EVIDENCE_TYPES:
            return {"success": False, "error": f"evidence_type must be one of: {', '.join(sorted(_VALID_EVIDENCE_TYPES))}"}
        clean_summary = _clean_text(summary)
        if not clean_summary:
            return {"success": False, "error": "summary cannot be empty"}
        clean_metadata: dict[str, Any] = {}
        if isinstance(metadata, dict):
            clean_metadata = metadata
        elif isinstance(metadata, str) and metadata.strip():
            try:
                parsed = json.loads(metadata)
            except json.JSONDecodeError:
                clean_metadata = {"text": metadata.strip()}
            else:
                clean_metadata = parsed if isinstance(parsed, dict) else {"value": parsed}
        evidence_id = _new_id("ev", _evidence)
        timestamp = _now()
        item = {
            "evidence_id": evidence_id,
            "evidence_type": clean_type,
            "summary": clean_summary,
            "content": _clean_text(content) or None,
            "source_tool": _clean_text(source_tool) or None,
            "target": _clean_text(target) or None,
            "metadata": clean_metadata or None,
            "agent_id": agent_id,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        clean_item = {k: v for k, v in item.items() if v not in (None, {}, "")}
        _save_evidence(clean_item)
        return {"success": True, "evidence": dict(_evidence[evidence_id]), "evidence_id": evidence_id}


def _list_memory_impl(kind: str, limit: int = 50) -> dict[str, Any]:
    with _memory_lock:
        clean_kind = _clean_text(kind).lower() or "summary"
        bounded = max(1, min(int(limit or 50), 200))
        if clean_kind == "attack_surface":
            return {"success": True, "kind": clean_kind, "items": _sorted_values(_attack_surface)[-bounded:], "total_count": len(_attack_surface)}
        if clean_kind == "coverage":
            return {"success": True, "kind": clean_kind, "items": _sorted_values(_coverage)[-bounded:], "total_count": len(_coverage)}
        if clean_kind == "evidence":
            return {"success": True, "kind": clean_kind, "items": _sorted_values(_evidence)[-bounded:], "total_count": len(_evidence)}
        if clean_kind == "summary":
            return {
                "success": True,
                "kind": "summary",
                "attack_surface_count": len(_attack_surface),
                "coverage_count": len(_coverage),
                "evidence_count": len(_evidence),
                "coverage_by_status": _count_by(_coverage.values(), "status"),
                "coverage_by_vuln_type": _count_by(_coverage.values(), "vuln_type"),
            }
        return {"success": False, "error": "kind must be one of: summary, attack_surface, coverage, evidence"}


def _count_by(items: Any, field: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        key = str(item.get(field) or "unknown")
        counts[key] = counts.get(key, 0) + 1
    return counts


@function_tool(timeout=30, strict_mode=False)
async def record_evidence(
    ctx: RunContextWrapper,
    evidence_type: str,
    summary: str,
    content: str | None = None,
    source_tool: str | None = None,
    target: str | None = None,
    metadata: dict[str, Any] | str | None = None,
) -> str:
    """Record reusable evidence and return an evidence_id.

    Use this before filing a vulnerability or marking coverage as tested.
    Keep summaries concise but include enough detail to identify the proof.
    """
    state_dir = state_dir_from_context(ctx)
    agent_id = _agent_id_from(ctx)

    def _record() -> dict[str, Any]:
        with _bound_state_dir(state_dir):
            return _record_evidence_impl(
                evidence_type=evidence_type,
                summary=summary,
                content=content,
                source_tool=source_tool,
                target=target,
                metadata=metadata,
                agent_id=agent_id,
            )

    result = await asyncio.to_thread(_record)
    return json.dumps(result, ensure_ascii=False, default=str)


@function_tool(timeout=30, strict_mode=False)
async def record_attack_surface(
    ctx: RunContextWrapper,
    kind: str,
    url: str | None = None,
    method: str | None = None,
    parameters: list[str] | str | None = None,
    auth_state: str | None = None,
    role: str | None = None,
    source: str | None = None,
    evidence_ids: list[str] | str | None = None,
    notes: str | None = None,
    address: str | None = None,
) -> str:
    """Record a discovered endpoint, form, service, or other attack surface.

    Include method, parameters, auth_state, and evidence_ids when known. The
    ledger is deduplicated by kind/method/url/address.
    """
    state_dir = state_dir_from_context(ctx)
    agent_id = _agent_id_from(ctx)

    def _record() -> dict[str, Any]:
        with _bound_state_dir(state_dir):
            return _record_attack_surface_impl(
                kind=kind,
                url=url,
                method=method,
                parameters=parameters,
                auth_state=auth_state,
                role=role,
                source=source,
                evidence_ids=evidence_ids,
                notes=notes,
                address=address,
                agent_id=agent_id,
            )

    result = await asyncio.to_thread(_record)
    return json.dumps(result, ensure_ascii=False, default=str)


@function_tool(timeout=30, strict_mode=False)
async def record_coverage(
    ctx: RunContextWrapper,
    endpoint: str,
    vuln_type: str,
    status: str,
    parameter: str | None = None,
    auth_state: str | None = None,
    evidence_ids: list[str] | str | None = None,
    result: str | None = None,
    notes: str | None = None,
) -> str:
    """Record that a vulnerability class was planned, tried, blocked, or passed.

    Use one row per endpoint/parameter/vulnerability-type/auth-state. Attach
    evidence_ids for any meaningful test result.
    """
    state_dir = state_dir_from_context(ctx)
    agent_id = _agent_id_from(ctx)

    def _record() -> dict[str, Any]:
        with _bound_state_dir(state_dir):
            return _record_coverage_impl(
                endpoint=endpoint,
                vuln_type=vuln_type,
                status=status,
                parameter=parameter,
                auth_state=auth_state,
                evidence_ids=evidence_ids,
                result=result,
                notes=notes,
                agent_id=agent_id,
            )

    payload = await asyncio.to_thread(_record)
    return json.dumps(payload, ensure_ascii=False, default=str)


@function_tool(timeout=30)
async def list_memory(ctx: RunContextWrapper, kind: str = "summary", limit: int = 50) -> str:
    """List persistent run memory.

    kind may be ``summary``, ``attack_surface``, ``coverage``, or ``evidence``.
    """
    state_dir = state_dir_from_context(ctx)

    def _list() -> dict[str, Any]:
        with _bound_state_dir(state_dir):
            return _list_memory_impl(kind, limit)

    return json.dumps(
        await asyncio.to_thread(_list),
        ensure_ascii=False,
        default=str,
    )
