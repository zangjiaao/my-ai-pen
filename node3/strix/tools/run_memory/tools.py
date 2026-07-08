"""Per-run attack-surface, hypothesis, coverage, and evidence memory.

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
_hypotheses: dict[str, dict[str, Any]] = {}
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
_SURFACE_KIND_ALIASES = {
    "admin": "admin_endpoint",
    "admin_api": "admin_endpoint",
    "admin_route": "admin_endpoint",
    "api": "api_endpoint",
    "api_route": "api_endpoint",
    "endpoint": "api_endpoint",
    "external_domain": "other",
    "external_host": "other",
    "rest_api": "api_endpoint",
    "rest_api_endpoint": "api_endpoint",
    "route": "api_endpoint",
    "file": "static_asset",
    "file_upload_endpoint": "file_upload",
    "static": "static_asset",
    "upload": "file_upload",
    "upload_endpoint": "file_upload",
    "web_socket": "websocket",
    "ws": "websocket",
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
_VALID_HYPOTHESIS_STATUSES = {
    "planned",
    "in_progress",
    "tested",
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
_EVIDENCE_TYPE_ALIASES = {
    "browser": "manual_observation",
    "browser_observation": "manual_observation",
    "browser_trace": "manual_observation",
    "command": "tool_output",
    "command_output": "tool_output",
    "exec_command": "tool_output",
    "http": "http_trace",
    "http_request": "http_trace",
    "http_response": "http_trace",
    "network": "http_trace",
    "network_trace": "http_trace",
    "observation": "manual_observation",
    "request": "http_trace",
    "request_response": "http_trace",
    "response": "http_trace",
    "scan_result": "tool_output",
    "scanner_output": "tool_output",
    "shell": "tool_output",
    "shell_output": "tool_output",
    "terminal": "tool_output",
    "terminal_output": "tool_output",
    "text": "note",
    "tool": "tool_output",
    "vulnerability_report": "artifact",
}


def hydrate_memory_from_disk(state_dir: Path) -> None:
    global _state_dir  # noqa: PLW0603
    with _memory_lock:
        _state_dir = state_dir
        state_dir.mkdir(parents=True, exist_ok=True)
        _ensure_db()
        _import_json_if_table_empty("attack_surface", "surface_id", _path("attack_surface.json"))
        _import_json_if_table_empty("hypotheses", "hypothesis_id", _path("hypotheses.json"))
        _import_json_if_table_empty("coverage", "coverage_id", _path("coverage.json"))
        _import_json_if_table_empty("evidence", "evidence_id", _path("evidence.json"))
        _reload_cache_from_db()
        _export_json_snapshots()
        logger.info(
            "memory hydrated from %s (%d surface, %d hypotheses, %d coverage, %d evidence)",
            state_dir,
            len(_attack_surface),
            len(_hypotheses),
            len(_coverage),
            len(_evidence),
        )


def attack_surface_from_file(path: Path) -> list[dict[str, Any]]:
    return _load_from_db_near(path, "attack_surface", "surface_id") or _load_list(path, "surface_id")


def coverage_from_file(path: Path) -> list[dict[str, Any]]:
    return _load_from_db_near(path, "coverage", "coverage_id") or _load_list(path, "coverage_id")


def hypotheses_from_file(path: Path) -> list[dict[str, Any]]:
    return _load_from_db_near(path, "hypotheses", "hypothesis_id") or _load_list(path, "hypothesis_id")


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
            CREATE TABLE IF NOT EXISTS hypotheses (
                hypothesis_id TEXT PRIMARY KEY,
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
            elif table == "hypotheses":
                dedupe_key = str(item.get("dedupe_key") or _hypothesis_key(
                    item.get("surface_id"),
                    str(item.get("endpoint") or ""),
                    item.get("method"),
                    item.get("parameter"),
                    str(item.get("vuln_type") or ""),
                    item.get("auth_state"),
                    item.get("phase"),
                ))
                conn.execute(
                    "INSERT OR IGNORE INTO hypotheses(hypothesis_id, dedupe_key, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
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
    _hypotheses.clear()
    _coverage.clear()
    _evidence.clear()
    _attack_surface.update(_rows_by_id("attack_surface", "surface_id"))
    _hypotheses.update(_rows_by_id("hypotheses", "hypothesis_id"))
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
    _ensure_db_at(db_path)
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
    _persist(_path("hypotheses.json"), _sorted_values(_hypotheses))
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


def _looks_like_url(value: str) -> bool:
    lowered = value.lower()
    return lowered.startswith(("http://", "https://", "ws://", "wss://"))


def _normalize_evidence_type(value: Any) -> tuple[str, str | None]:
    raw = _clean_text(value)
    normalized = raw.lower().replace("-", "_").replace(" ", "_")
    if normalized in _VALID_EVIDENCE_TYPES:
        return normalized, None
    if normalized in _EVIDENCE_TYPE_ALIASES:
        return _EVIDENCE_TYPE_ALIASES[normalized], raw or None
    return "other", raw or None


def _normalize_surface_kind(value: Any) -> tuple[str, str | None]:
    raw = _clean_text(value)
    normalized = raw.lower().replace("-", "_").replace(" ", "_")
    if normalized in _VALID_SURFACE_KINDS:
        return normalized, None
    if normalized in _SURFACE_KIND_ALIASES:
        return _SURFACE_KIND_ALIASES[normalized], raw or None
    return normalized, None


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


def _hypothesis_key(
    surface_id: str | None,
    endpoint: str,
    method: str | None,
    parameter: str | None,
    vuln_type: str,
    auth_state: str | None,
    phase: str | None,
) -> str:
    return "|".join([
        (surface_id or "").strip(),
        endpoint.strip(),
        (method or "").strip().upper(),
        (parameter or "<none>").strip(),
        vuln_type.strip().lower(),
        (auth_state or "").strip().lower(),
        (phase or "").strip().lower(),
    ])


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


def _save_hypothesis(item: dict[str, Any]) -> None:
    _ensure_db()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO hypotheses(hypothesis_id, dedupe_key, payload, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(dedupe_key) DO UPDATE SET
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (
                item["hypothesis_id"],
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
    phase: str | None,
    agent_id: str | None,
) -> dict[str, Any]:
    with _memory_lock:
        clean_kind, original_kind = _normalize_surface_kind(kind)
        if clean_kind not in _VALID_SURFACE_KINDS:
            return {"success": False, "error": f"kind must be one of: {', '.join(sorted(_VALID_SURFACE_KINDS))}"}
        clean_url = _clean_text(url) or None
        clean_address = _clean_text(address) or None
        if not clean_url and not clean_address:
            return {"success": False, "error": "Provide url or address"}
        if _state_dir is not None:
            try:
                from strix.tools.workflow import load_workflow_state, target_in_authorized_scope
            except ImportError:
                pass
            else:
                workflow_state = load_workflow_state(_state_dir)
                scope_target = clean_url or clean_address
                if not target_in_authorized_scope(workflow_state, scope_target):
                    return {
                        "success": True,
                        "status": "skipped_out_of_scope",
                        "scope": "out_of_scope",
                        "target": scope_target,
                        "note": "Target is outside the platform-authorized scope and was not added to attack surface coverage.",
                    }
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
                "phase": _clean_text(phase) or None,
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
            "phase": _clean_text(phase) or None,
            "dedupe_key": key,
            "original_kind": original_kind,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        clean_item = {k: v for k, v in item.items() if v not in (None, [], "")}
        _save_attack_surface(clean_item)
        return {"success": True, "status": "created", "surface": dict(_attack_surface[surface_id])}


def _record_hypothesis_impl(
    *,
    vuln_type: str,
    hypothesis: str,
    test_strategy: str,
    endpoint: str | None,
    method: str | None,
    parameter: str | None,
    surface_id: str | None,
    auth_state: str | None,
    phase: str | None,
    risk_reason: str | None,
    status: str | None,
    evidence_ids: list[str] | str | None,
    coverage_ids: list[str] | str | None,
    notes: str | None,
    agent_id: str | None,
) -> dict[str, Any]:
    with _memory_lock:
        clean_vuln_type = _clean_text(vuln_type).lower()
        clean_hypothesis = _clean_text(hypothesis)
        clean_strategy = _clean_text(test_strategy)
        clean_endpoint = _clean_text(endpoint)
        clean_method = _clean_text(method).upper() or None
        clean_parameter = _clean_text(parameter) or "<none>"
        clean_surface_id = _clean_text(surface_id) or None
        clean_auth_state = _clean_text(auth_state) or None
        clean_phase = _clean_text(phase) or None
        clean_status = _clean_text(status).lower() or "planned"
        clean_evidence_ids = _clean_list(evidence_ids)
        clean_coverage_ids = _clean_list(coverage_ids)
        if not clean_vuln_type:
            return {"success": False, "error": "vuln_type cannot be empty"}
        if not clean_hypothesis:
            return {"success": False, "error": "hypothesis cannot be empty"}
        if not clean_strategy:
            return {"success": False, "error": "test_strategy cannot be empty"}
        if not clean_endpoint and not clean_surface_id:
            return {"success": False, "error": "Provide endpoint or surface_id"}
        if clean_status not in _VALID_HYPOTHESIS_STATUSES:
            return {
                "success": False,
                "error": f"status must be one of: {', '.join(sorted(_VALID_HYPOTHESIS_STATUSES))}",
            }
        if clean_surface_id and clean_surface_id not in _attack_surface:
            return {
                "success": False,
                "error": "Unknown surface_id; call record_attack_surface first or omit surface_id",
                "missing_surface_id": clean_surface_id,
            }
        missing = missing_evidence_ids(clean_evidence_ids)
        if missing:
            return {
                "success": False,
                "error": "Unknown evidence_ids; call record_evidence first and cite the returned IDs",
                "missing_evidence_ids": missing,
            }
        missing_coverage = [cid for cid in clean_coverage_ids if cid not in _coverage]
        if missing_coverage:
            return {
                "success": False,
                "error": "Unknown coverage_ids; call record_coverage first and cite the returned IDs",
                "missing_coverage_ids": missing_coverage,
            }
        if clean_status in {"blocked", "skipped"} and not (
            clean_evidence_ids or _clean_text(notes) or _clean_text(risk_reason)
        ):
            return {
                "success": False,
                "error": "Hypothesis status blocked/skipped requires evidence_ids, notes, or risk_reason",
            }
        if clean_status == "tested" and not (clean_coverage_ids or clean_evidence_ids):
            return {
                "success": False,
                "error": "Hypothesis status tested requires coverage_ids or evidence_ids",
            }

        key = _hypothesis_key(
            clean_surface_id,
            clean_endpoint,
            clean_method,
            clean_parameter,
            clean_vuln_type,
            clean_auth_state,
            clean_phase,
        )
        timestamp = _now()
        existing = _find_by_key(_hypotheses, "dedupe_key", key)
        if existing:
            existing.update(
                {
                    "vuln_type": clean_vuln_type,
                    "hypothesis": clean_hypothesis,
                    "test_strategy": clean_strategy,
                    "status": clean_status,
                    "risk_reason": _clean_text(risk_reason) or existing.get("risk_reason"),
                    "notes": _clean_text(notes) or existing.get("notes"),
                    "updated_at": timestamp,
                    "agent_id": agent_id or existing.get("agent_id"),
                },
            )
            for field, value in {
                "endpoint": clean_endpoint or None,
                "method": clean_method,
                "parameter": clean_parameter,
                "surface_id": clean_surface_id,
                "auth_state": clean_auth_state,
                "phase": clean_phase,
            }.items():
                if value:
                    existing[field] = value
            existing["evidence_ids"] = sorted(set(existing.get("evidence_ids") or []) | set(clean_evidence_ids))
            existing["coverage_ids"] = sorted(set(existing.get("coverage_ids") or []) | set(clean_coverage_ids))
            _save_hypothesis(existing)
            hypothesis_item = _find_by_key(_hypotheses, "dedupe_key", key) or existing
            return {"success": True, "status": "updated", "hypothesis": dict(hypothesis_item), "hypothesis_id": hypothesis_item["hypothesis_id"]}

        hypothesis_id = _new_id("hyp", _hypotheses)
        item = {
            "hypothesis_id": hypothesis_id,
            "surface_id": clean_surface_id,
            "endpoint": clean_endpoint or None,
            "method": clean_method,
            "parameter": clean_parameter,
            "vuln_type": clean_vuln_type,
            "auth_state": clean_auth_state,
            "phase": clean_phase,
            "hypothesis": clean_hypothesis,
            "test_strategy": clean_strategy,
            "risk_reason": _clean_text(risk_reason) or None,
            "status": clean_status,
            "evidence_ids": clean_evidence_ids,
            "coverage_ids": clean_coverage_ids,
            "notes": _clean_text(notes) or None,
            "agent_id": agent_id,
            "dedupe_key": key,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        clean_item = {k: v for k, v in item.items() if v not in (None, [], "")}
        _save_hypothesis(clean_item)
        return {"success": True, "status": "created", "hypothesis": dict(_hypotheses[hypothesis_id]), "hypothesis_id": hypothesis_id}


def _update_hypothesis_from_coverage(coverage: dict[str, Any]) -> None:
    hypothesis_id = _clean_text(coverage.get("hypothesis_id"))
    if not hypothesis_id or hypothesis_id not in _hypotheses:
        return
    hypothesis_item = dict(_hypotheses[hypothesis_id])
    status = _clean_text(coverage.get("status")).lower()
    if status in {"tried", "passed", "failed"}:
        hypothesis_item["status"] = "tested"
    elif status in {"blocked", "skipped"}:
        hypothesis_item["status"] = status
    timestamp = _now()
    hypothesis_item["updated_at"] = timestamp
    hypothesis_item["coverage_ids"] = sorted(set(hypothesis_item.get("coverage_ids") or []) | {_clean_text(coverage.get("coverage_id"))})
    hypothesis_item["evidence_ids"] = sorted(set(hypothesis_item.get("evidence_ids") or []) | set(_clean_list(coverage.get("evidence_ids"))))
    if coverage.get("result") and not hypothesis_item.get("notes"):
        hypothesis_item["notes"] = coverage.get("result")
    _save_hypothesis({k: v for k, v in hypothesis_item.items() if v not in (None, [], "")})


def _record_coverage_impl(
    *,
    endpoint: str,
    vuln_type: str,
    status: str,
    parameter: str | None,
    auth_state: str | None,
    evidence_ids: list[str] | str | None,
    hypothesis_id: str | None,
    phase: str | None,
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
        clean_hypothesis_id = _clean_text(hypothesis_id) or None
        clean_phase = _clean_text(phase) or None
        missing = missing_evidence_ids(clean_evidence_ids)
        if missing:
            return {
                "success": False,
                "error": "Unknown evidence_ids; call record_evidence first and cite the returned IDs",
                "missing_evidence_ids": missing,
            }
        if clean_status in {"tried", "passed", "failed"} and not clean_evidence_ids:
            return {
                "success": False,
                "error": "Coverage status tried/passed/failed requires evidence_ids from record_evidence",
            }
        if clean_status in {"blocked", "skipped"} and not (
            clean_evidence_ids or _clean_text(result) or _clean_text(notes)
        ):
            return {
                "success": False,
                "error": "Coverage status blocked/skipped requires evidence_ids, result, or notes explaining why testing could not continue",
            }
        if clean_hypothesis_id and clean_hypothesis_id not in _hypotheses:
            return {
                "success": False,
                "error": "Unknown hypothesis_id; call record_hypothesis first and cite the returned ID",
                "missing_hypothesis_id": clean_hypothesis_id,
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
                    "hypothesis_id": clean_hypothesis_id or existing.get("hypothesis_id"),
                    "phase": clean_phase or existing.get("phase"),
                },
            )
            existing["evidence_ids"] = sorted(set(existing.get("evidence_ids") or []) | set(clean_evidence_ids))
            _save_coverage(existing)
            coverage = _find_by_key(_coverage, "dedupe_key", key) or existing
            _update_hypothesis_from_coverage(coverage)
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
            "hypothesis_id": clean_hypothesis_id,
            "phase": clean_phase,
            "result": _clean_text(result) or None,
            "notes": _clean_text(notes) or None,
            "agent_id": agent_id,
            "dedupe_key": key,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        clean_item = {k: v for k, v in item.items() if v not in (None, [], "")}
        _save_coverage(clean_item)
        coverage = dict(_coverage[coverage_id])
        _update_hypothesis_from_coverage(coverage)
        return {"success": True, "status": "created", "coverage": coverage}


def _record_evidence_impl(
    *,
    evidence_type: str,
    summary: str,
    content: str | None,
    source_tool: str | None,
    target: str | None,
    phase: str | None,
    metadata: dict[str, Any] | str | None,
    agent_id: str | None,
) -> dict[str, Any]:
    with _memory_lock:
        clean_type, original_type = _normalize_evidence_type(evidence_type)
        clean_summary = _clean_text(summary)
        if not clean_summary:
            return {"success": False, "error": "summary cannot be empty"}
        clean_metadata: dict[str, Any] = {}
        if isinstance(metadata, dict):
            clean_metadata = dict(metadata)
        elif isinstance(metadata, str) and metadata.strip():
            try:
                parsed = json.loads(metadata)
            except json.JSONDecodeError:
                clean_metadata = {"text": metadata.strip()}
            else:
                clean_metadata = parsed if isinstance(parsed, dict) else {"value": parsed}
        if original_type:
            clean_metadata.setdefault("original_evidence_type", original_type)
        clean_target = _clean_text(target)
        if not clean_target and original_type and _looks_like_url(original_type):
            clean_target = original_type
        evidence_id = _new_id("ev", _evidence)
        timestamp = _now()
        item = {
            "evidence_id": evidence_id,
            "evidence_type": clean_type,
            "summary": clean_summary,
            "content": _clean_text(content) or None,
            "source_tool": _clean_text(source_tool) or None,
            "target": clean_target or None,
            "phase": _clean_text(phase) or None,
            "metadata": clean_metadata or None,
            "agent_id": agent_id,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        clean_item = {k: v for k, v in item.items() if v not in (None, {}, "")}
        _save_evidence(clean_item)
        return {"success": True, "evidence": dict(_evidence[evidence_id]), "evidence_id": evidence_id}


def hypothesis_gaps_for_state(state_dir: Path | None) -> list[dict[str, Any]]:
    if state_dir is None:
        hypotheses = _sorted_values(_hypotheses)
        coverage_by_id = _coverage
        evidence_by_id = _evidence
    else:
        hypotheses = hypotheses_from_file(state_dir / "hypotheses.json")
        coverage_by_id = {
            str(item.get("coverage_id")): item
            for item in coverage_from_file(state_dir / "coverage.json")
            if str(item.get("coverage_id") or "").strip()
        }
        evidence_by_id = {
            str(item.get("evidence_id")): item
            for item in evidence_from_file(state_dir / "evidence.json")
            if str(item.get("evidence_id") or "").strip()
        }
    return hypothesis_gaps(hypotheses, coverage_by_id, evidence_by_id)


def hypothesis_gaps(
    hypotheses: list[dict[str, Any]],
    coverage_by_id: dict[str, dict[str, Any]],
    evidence_by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    gaps: list[dict[str, Any]] = []
    for item in hypotheses:
        hypothesis_id = str(item.get("hypothesis_id") or "").strip()
        status = str(item.get("status") or "planned").strip().lower()
        evidence_ids = _clean_list(item.get("evidence_ids"))
        coverage_ids = _clean_list(item.get("coverage_ids"))
        missing_evidence = [eid for eid in evidence_ids if eid not in evidence_by_id]
        missing_coverage = [cid for cid in coverage_ids if cid not in coverage_by_id]
        problems: list[str] = []
        if status in {"planned", "in_progress"}:
            problems.append(f"hypothesis is still {status}")
        if status == "tested" and not coverage_ids:
            problems.append("tested hypothesis has no linked coverage_ids")
        if status == "tested" and not evidence_ids:
            problems.append("tested hypothesis has no linked evidence_ids")
        if status in {"blocked", "skipped"} and not (
            evidence_ids or _clean_text(item.get("notes")) or _clean_text(item.get("risk_reason"))
        ):
            problems.append(f"{status} hypothesis has no evidence, notes, or risk_reason")
        if missing_evidence:
            problems.append("missing evidence reference(s): " + ", ".join(missing_evidence))
        if missing_coverage:
            problems.append("missing coverage reference(s): " + ", ".join(missing_coverage))
        if problems:
            gaps.append({
                "hypothesis_id": hypothesis_id,
                "surface_id": item.get("surface_id"),
                "endpoint": item.get("endpoint"),
                "method": item.get("method"),
                "parameter": item.get("parameter"),
                "vuln_type": item.get("vuln_type"),
                "phase": item.get("phase"),
                "status": status,
                "problems": problems,
            })
    return gaps


def _list_memory_impl(kind: str, limit: int = 50) -> dict[str, Any]:
    with _memory_lock:
        clean_kind = _clean_text(kind).lower() or "summary"
        bounded = max(1, min(int(limit or 50), 200))
        coverage_gaps: list[dict[str, Any]] = []
        external_discovery_gaps: list[dict[str, Any]] = []
        hypothesis_gaps_list: list[dict[str, Any]] = []
        surface_hypothesis_gaps_list: list[dict[str, Any]] = []
        coverage_without_hypothesis_list: list[dict[str, Any]] = []
        if clean_kind in {"summary", "coverage_gaps"}:
            try:
                from strix.tools.workflow import coverage_gaps_for_state
            except ImportError:
                coverage_gaps = []
            else:
                coverage_gaps = coverage_gaps_for_state(_state_dir)
        if clean_kind in {"summary", "surface_hypothesis_gaps", "coverage_without_hypothesis"} and _state_dir is not None:
            try:
                from strix.platform.node_runner import coverage_without_hypothesis_links, surface_hypothesis_gaps
                from strix.tools.workflow import load_workflow_state
            except ImportError:
                surface_hypothesis_gaps_list = []
                coverage_without_hypothesis_list = []
            else:
                attack_surface = attack_surface_from_file(_state_dir / "attack_surface.json")
                hypotheses = hypotheses_from_file(_state_dir / "hypotheses.json")
                coverage = coverage_from_file(_state_dir / "coverage.json")
                workflow_state = load_workflow_state(_state_dir)
                surface_hypothesis_gaps_list = surface_hypothesis_gaps(attack_surface, hypotheses, workflow_state)
                coverage_without_hypothesis_list = coverage_without_hypothesis_links(coverage, hypotheses)
        if clean_kind in {"summary", "hypothesis_gaps"}:
            hypothesis_gaps_list = hypothesis_gaps_for_state(_state_dir)
        if clean_kind in {"summary", "external_discovery_gaps"}:
            try:
                from strix.tools.workflow import discovered_inventory_gaps_for_state
            except ImportError:
                external_discovery_gaps = []
            else:
                external_discovery_gaps = discovered_inventory_gaps_for_state(_state_dir)
        if clean_kind == "attack_surface":
            return {"success": True, "kind": clean_kind, "items": _sorted_values(_attack_surface)[-bounded:], "total_count": len(_attack_surface)}
        if clean_kind == "hypotheses":
            return {"success": True, "kind": clean_kind, "items": _sorted_values(_hypotheses)[-bounded:], "total_count": len(_hypotheses)}
        if clean_kind == "coverage":
            return {"success": True, "kind": clean_kind, "items": _sorted_values(_coverage)[-bounded:], "total_count": len(_coverage)}
        if clean_kind == "hypothesis_gaps":
            return {
                "success": True,
                "kind": clean_kind,
                "items": hypothesis_gaps_list[:bounded],
                "total_count": len(hypothesis_gaps_list),
            }
        if clean_kind == "surface_hypothesis_gaps":
            return {
                "success": True,
                "kind": clean_kind,
                "items": surface_hypothesis_gaps_list[:bounded],
                "total_count": len(surface_hypothesis_gaps_list),
            }
        if clean_kind == "coverage_without_hypothesis":
            return {
                "success": True,
                "kind": clean_kind,
                "items": coverage_without_hypothesis_list[:bounded],
                "total_count": len(coverage_without_hypothesis_list),
            }
        if clean_kind == "coverage_gaps":
            return {
                "success": True,
                "kind": clean_kind,
                "items": coverage_gaps[:bounded],
                "total_count": len(coverage_gaps),
            }
        if clean_kind == "external_discovery_gaps":
            return {
                "success": True,
                "kind": clean_kind,
                "items": external_discovery_gaps[:bounded],
                "total_count": len(external_discovery_gaps),
            }
        if clean_kind == "evidence":
            return {"success": True, "kind": clean_kind, "items": _sorted_values(_evidence)[-bounded:], "total_count": len(_evidence)}
        if clean_kind == "summary":
            return {
                "success": True,
                "kind": "summary",
                "attack_surface_count": len(_attack_surface),
                "hypothesis_count": len(_hypotheses),
                "surface_hypothesis_gap_count": len(surface_hypothesis_gaps_list),
                "surface_hypothesis_gap_examples": surface_hypothesis_gaps_list[: min(5, bounded)],
                "hypothesis_gap_count": len(hypothesis_gaps_list),
                "hypothesis_gap_examples": hypothesis_gaps_list[: min(5, bounded)],
                "coverage_count": len(_coverage),
                "coverage_without_hypothesis_count": len(coverage_without_hypothesis_list),
                "coverage_without_hypothesis_examples": coverage_without_hypothesis_list[: min(5, bounded)],
                "uncovered_attack_surface_count": len(coverage_gaps),
                "coverage_gap_examples": coverage_gaps[: min(5, bounded)],
                "external_discovery_gap_count": len(external_discovery_gaps),
                "external_discovery_gap_examples": external_discovery_gaps[: min(5, bounded)],
                "evidence_count": len(_evidence),
                "coverage_by_status": _count_by(_coverage.values(), "status"),
                "coverage_by_vuln_type": _count_by(_coverage.values(), "vuln_type"),
                "hypotheses_by_status": _count_by(_hypotheses.values(), "status"),
                "hypotheses_by_vuln_type": _count_by(_hypotheses.values(), "vuln_type"),
            }
        return {"success": False, "error": "kind must be one of: summary, attack_surface, hypotheses, hypothesis_gaps, surface_hypothesis_gaps, coverage, coverage_without_hypothesis, coverage_gaps, external_discovery_gaps, evidence"}


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
    phase: str | None = None,
    metadata: dict[str, Any] | str | None = None,
) -> str:
    """Record reusable evidence and return an evidence_id.

    Use this before filing a vulnerability or marking coverage as tested.
    Keep summaries concise but include enough detail to identify the proof.

    Args:
        evidence_type: Prefer one of ``http_trace``, ``tool_output``,
            ``screenshot``, ``artifact``, ``note``, ``manual_observation``,
            or ``other``. Common aliases are normalized automatically.
        summary: Short description of what this evidence proves.
        content: Optional bounded raw proof text.
        source_tool: Tool or command that produced the evidence.
        target: URL, endpoint, host, file, or asset the evidence belongs to.
        phase: Optional current root phase title or ID this evidence supports.
        metadata: Optional structured details.
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
                phase=phase,
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
    phase: str | None = None,
) -> str:
    """Record a discovered endpoint, form, service, or other attack surface.

    Include method, parameters, auth_state, and evidence_ids when known. Common
    kind aliases such as ``api``, ``endpoint``, and ``REST API endpoint`` are
    normalized automatically. The ledger is deduplicated by kind/method/url/address.
    Use phase to bind the record to the current root phase when applicable.
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
                phase=phase,
                agent_id=agent_id,
            )

    result = await asyncio.to_thread(_record)
    return json.dumps(result, ensure_ascii=False, default=str)


@function_tool(timeout=30, strict_mode=False)
async def record_hypothesis(
    ctx: RunContextWrapper,
    vuln_type: str,
    hypothesis: str,
    test_strategy: str,
    endpoint: str | None = None,
    method: str | None = None,
    parameter: str | None = None,
    surface_id: str | None = None,
    auth_state: str | None = None,
    phase: str | None = None,
    risk_reason: str | None = None,
    status: str | None = "planned",
    evidence_ids: list[str] | str | None = None,
    coverage_ids: list[str] | str | None = None,
    notes: str | None = None,
) -> str:
    """Record a concrete vulnerability hypothesis before or during testing.

    Use this to convert attack surface into a test matrix. A hypothesis should
    say what could be vulnerable, why it is worth testing, and how it will be
    tested. Later ``record_coverage`` should cite the returned hypothesis_id.

    Args:
        vuln_type: Vulnerability class or business-risk category to test.
        hypothesis: Concrete statement of the suspected weakness.
        test_strategy: Planned validation approach or negative-test strategy.
        endpoint: URL/path/route under test when known.
        method: Optional HTTP method.
        parameter: Optional parameter, object field, or business action.
        surface_id: Optional ID returned by record_attack_surface.
        auth_state: Role/session state used for testing.
        phase: Current root phase title or ID.
        risk_reason: Why this hypothesis matters for impact/coverage.
        status: planned, in_progress, tested, blocked, or skipped.
        evidence_ids: Evidence already supporting or blocking this hypothesis.
        coverage_ids: Coverage records already closing this hypothesis.
        notes: Additional bounded context.
    """
    state_dir = state_dir_from_context(ctx)
    agent_id = _agent_id_from(ctx)

    def _record() -> dict[str, Any]:
        with _bound_state_dir(state_dir):
            return _record_hypothesis_impl(
                vuln_type=vuln_type,
                hypothesis=hypothesis,
                test_strategy=test_strategy,
                endpoint=endpoint,
                method=method,
                parameter=parameter,
                surface_id=surface_id,
                auth_state=auth_state,
                phase=phase,
                risk_reason=risk_reason,
                status=status,
                evidence_ids=evidence_ids,
                coverage_ids=coverage_ids,
                notes=notes,
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
    hypothesis_id: str | None = None,
    phase: str | None = None,
    result: str | None = None,
    notes: str | None = None,
) -> str:
    """Record that a vulnerability class was planned, tried, blocked, or passed.

    Use one row per endpoint/parameter/vulnerability-type/auth-state. Attach
    evidence_ids for any meaningful test result and cite hypothesis_id when
    this closes a planned hypothesis.
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
                hypothesis_id=hypothesis_id,
                phase=phase,
                result=result,
                notes=notes,
                agent_id=agent_id,
            )

    payload = await asyncio.to_thread(_record)
    return json.dumps(payload, ensure_ascii=False, default=str)


@function_tool(timeout=30)
async def list_memory(ctx: RunContextWrapper, kind: str = "summary", limit: int = 50) -> str:
    """List persistent run memory.

    kind may be ``summary``, ``attack_surface``, ``hypotheses``,
    ``hypothesis_gaps``, ``surface_hypothesis_gaps``, ``coverage``,
    ``coverage_without_hypothesis``, ``coverage_gaps``,
    ``external_discovery_gaps``, or ``evidence``.
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
