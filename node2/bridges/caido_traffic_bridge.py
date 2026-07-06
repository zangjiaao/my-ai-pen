"""Caido traffic bridge for Node2.

Run this with the Strix virtualenv so it can reuse Strix's Caido SDK helpers:

    D:\Coding\my-ai-pen\research\strix\.venv\Scripts\python.exe node2\bridges\caido_traffic_bridge.py

Then point Node2 at it:

    NODE2_EXTERNAL_TRAFFIC_SOURCE_URL=http://127.0.0.1:48180

The bridge intentionally exposes Node2's generic traffic-source shape instead
of Strix Agent APIs. Node2 remains Pi-first; Caido is used as an execution
layer for proxy history.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 48180
DEFAULT_STRIX_DIR = Path(__file__).resolve().parents[2] / "research" / "strix"
MAX_LIST_FETCH = 200


def _install_strix_path() -> None:
    strix_dir = Path(os.environ.get("NODE2_STRIX_DIR", DEFAULT_STRIX_DIR)).resolve()
    if strix_dir.exists() and str(strix_dir) not in sys.path:
        sys.path.insert(0, str(strix_dir))


_install_strix_path()

try:
    from strix.tools.proxy import caido_api
    from caido_sdk_client.types import CreateProjectOptions
except Exception as exc:  # noqa: BLE001
    caido_api = None
    CreateProjectOptions = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


PROJECT_SELECTED = False


@dataclass
class BridgeConfig:
    host: str
    port: int


def main() -> None:
    parser = argparse.ArgumentParser(description="Expose Caido proxy history as a Node2 traffic source.")
    parser.add_argument("--host", default=os.environ.get("NODE2_CAIDO_BRIDGE_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("NODE2_CAIDO_BRIDGE_PORT", DEFAULT_PORT)))
    args = parser.parse_args()

    config = BridgeConfig(host=args.host, port=args.port)
    server = ThreadingHTTPServer((config.host, config.port), make_handler(config))
    print(json.dumps({"event": "node2_caido_bridge_started", "url": f"http://{config.host}:{config.port}"}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def make_handler(config: BridgeConfig) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "Node2CaidoTrafficBridge/0.1"

        def do_GET(self) -> None:  # noqa: N802
            try:
                parsed = urlparse(self.path)
                if parsed.path == "/status":
                    self._send_json(asyncio.run(status_payload(config)))
                    return
                if parsed.path == "/traffic":
                    params = parse_qs(parsed.query)
                    self._send_json(asyncio.run(list_traffic(params)))
                    return
                if parsed.path.startswith("/traffic/"):
                    request_id = unquote(parsed.path.removeprefix("/traffic/"))
                    self._send_json(asyncio.run(get_traffic(request_id)))
                    return
                self._send_json({"success": False, "error": "not found"}, status=404)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"success": False, "error": str(exc)}, status=500)

        def log_message(self, fmt: str, *args: Any) -> None:
            if os.environ.get("NODE2_CAIDO_BRIDGE_QUIET") == "1":
                return
            super().log_message(fmt, *args)

        def _send_json(self, payload: Any, *, status: int = 200) -> None:
            body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


async def status_payload(config: BridgeConfig) -> dict[str, Any]:
    project_ready = False
    project_error = None
    if IMPORT_ERROR is None:
        try:
            await ready_client()
            project_ready = True
        except Exception as exc:  # noqa: BLE001
            project_error = str(exc)
    return {
        "success": IMPORT_ERROR is None and project_error is None,
        "bridge": "node2-caido-traffic",
        "url": f"http://{config.host}:{config.port}",
        "caido_url": os.environ.get("STRIX_CAIDO_URL", "http://127.0.0.1:48080"),
        "strix_imported": IMPORT_ERROR is None,
        "project_ready": project_ready,
        "error": project_error or (None if IMPORT_ERROR is None else f"failed to import Strix Caido helpers: {IMPORT_ERROR}"),
    }


async def list_traffic(params: dict[str, list[str]]) -> dict[str, Any]:
    ensure_caido_imported()
    limit = bounded_int(first_value(params, "limit"), default=50, minimum=1, maximum=MAX_LIST_FETCH)
    method = first_value(params, "method")
    url_contains = first_value(params, "url_contains")
    httpql_filter = first_value(params, "httpql_filter")
    if method:
        method_filter = f'req.method.eq:"{method.upper()}"'
        httpql_filter = f"({httpql_filter}) AND {method_filter}" if httpql_filter else method_filter

    client = await ready_client()
    connection = await caido_api.list_requests_with_client(
        client,
        httpql_filter=httpql_filter,
        first=limit,
        sort_by="timestamp",
        sort_order="desc",
    )
    rows: list[dict[str, Any]] = []
    for edge in connection.edges:
        row = await traffic_row_from_id(client, str(edge.node.request.id))
        if url_contains and url_contains not in row.get("url", ""):
            continue
        rows.append(row)
    return {
        "success": True,
        "source": "caido",
        "requests": rows,
        "page_info": {
            "has_next_page": connection.page_info.has_next_page,
            "has_previous_page": connection.page_info.has_previous_page,
            "start_cursor": connection.page_info.start_cursor,
            "end_cursor": connection.page_info.end_cursor,
        },
    }


async def get_traffic(request_id: str) -> dict[str, Any]:
    ensure_caido_imported()
    client = await ready_client()
    normalized_id = request_id.removeprefix("external_")
    return await traffic_row_from_id(client, normalized_id)


async def ready_client() -> Any:
    global PROJECT_SELECTED  # noqa: PLW0603 - process-local bridge state
    client = await caido_api.get_client()
    if not PROJECT_SELECTED:
        if CreateProjectOptions is None:
            raise RuntimeError("CreateProjectOptions is unavailable")
        project = await client.project.create(
            CreateProjectOptions(name=f"node2-{int(time.time())}", temporary=True)
        )
        await client.project.select(project.id)
        PROJECT_SELECTED = True
    return client


async def traffic_row_from_id(client: Any, request_id: str) -> dict[str, Any]:
    result = await caido_api.get_request_with_client(client, request_id, part="request")
    if result is None or result.request is None:
        raise ValueError(f"Caido request not found: {request_id}")

    request_raw = bytes_to_text(result.request.raw)
    response_raw = bytes_to_bytes(result.response.raw) if result.response is not None else None
    request_parts = caido_api.parse_raw_request(request_raw) if request_raw else {"method": result.request.method, "url_path": result.request.path, "headers": {}, "body": ""}
    full_url = caido_api.full_url_from_components(result.request, request_parts, {})
    response = caido_api.parse_raw_response(response_raw)
    return {
        "id": str(result.request.id),
        "source": "caido",
        "method": str(request_parts.get("method") or result.request.method).upper(),
        "url": full_url,
        "status": response.get("status_code") if response else getattr(result.response, "status_code", None),
        "request_headers": request_parts.get("headers") or {},
        "request_body": request_parts.get("body") or None,
        "response_headers": response.get("headers") if response else {},
        "response_body": response.get("body") if response else None,
        "received_at": getattr(result.request.created_at, "isoformat", lambda: str(result.request.created_at))(),
        "caido": {
            "request_id": str(result.request.id),
            "response_id": str(result.response.id) if result.response is not None else None,
            "host": result.request.host,
            "port": result.request.port,
            "is_tls": result.request.is_tls,
            "response_length": getattr(result.response, "length", None) if result.response is not None else None,
            "roundtrip_ms": getattr(result.response, "roundtrip_time", None) if result.response is not None else None,
        },
    }


def ensure_caido_imported() -> None:
    if IMPORT_ERROR is not None:
        raise RuntimeError(f"failed to import Strix Caido helpers: {IMPORT_ERROR}")


def first_value(params: dict[str, list[str]], name: str) -> str | None:
    values = params.get(name) or []
    value = values[0].strip() if values else ""
    return value or None


def bounded_int(raw: str | None, *, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(raw) if raw is not None else default
    except ValueError:
        parsed = default
    return max(minimum, min(parsed, maximum))


def bytes_to_text(value: bytes | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def bytes_to_bytes(value: bytes | str | None) -> bytes | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value
    return str(value).encode("utf-8", errors="replace")


if __name__ == "__main__":
    main()
