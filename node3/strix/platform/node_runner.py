from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from strix.config import load_settings
from strix.core.agents import AgentCoordinator
from strix.core.runner import run_strix_scan
from strix.interface.utils import (
    assign_workspace_subdirs,
    clone_repository,
    collect_local_sources,
    generate_run_name,
    infer_target_type,
    rewrite_localhost_targets,
)
from strix.platform.node_protocol import (
    PlatformEventSink,
    agent_graph_from_file,
    emit_final_artifacts,
    extract_target,
    normalize_vulnerabilities,
    runtime_checkpoint,
    send,
    text,
    todos_from_file,
)
from strix.report.state import ReportState, set_global_report_state
from strix.runtime import session_manager
from strix.tools.run_memory.tools import (
    attack_surface_from_file,
    coverage_from_file,
    evidence_from_file,
    hypothesis_gaps,
    hypotheses_from_file,
)
from strix.tools.workflow import (
    discovered_inventory_gaps,
    load_workflow_state,
    sitemap_expansion_gaps_from_state,
    sitemap_gate,
    sitemap_pagination_gaps_from_state,
    target_in_authorized_scope,
)


HOST_GATEWAY_HOSTNAME = "host.docker.internal"
COMPLETION_WATCH_INTERVAL_SECONDS = 2.0
COMPLETION_FLUSH_TIMEOUT_SECONDS = 10.0
TERMINAL_TODO_STATUSES = {"done", "blocked", "failed", "skipped"}
TERMINAL_AGENT_STATUSES = {"failed", "crashed", "stopped"}
MEANINGFUL_COVERAGE_STATUSES = {"tried", "passed", "failed"}
SURFACE_KINDS_REQUIRING_COVERAGE = {
    "url",
    "api_endpoint",
    "form",
    "auth_endpoint",
    "admin_endpoint",
    "file_upload",
    "websocket",
    "service",
}
HTTP_METHOD_RE = re.compile(r"^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(.+)$", re.IGNORECASE)
def stable_platform_run_name(conversation_id: str) -> str:
    safe = "".join(ch if ch.isalnum() else "-" for ch in str(conversation_id).strip().lower())
    safe = "-".join(part for part in safe.split("-") if part)
    return f"conversation-{safe[:36] or 'session'}"


def merge_task_context(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    for key in ("instruction", "scan_mode"):
        if incoming.get(key):
            merged[key] = incoming[key]
    for key in ("target", "scope", "snapshot"):
        value = incoming.get(key)
        if isinstance(value, dict) and value:
            merged[key] = value
    return merged


class StrixPlatformConversationSession:
    """Long-lived Strix root session bound to one platform conversation."""

    def __init__(self, ws: Any, task: dict[str, Any], config: Any) -> None:
        self.ws = ws
        self.task = dict(task)
        self.config = config
        self.conversation_id = str(task["conversation_id"])
        self.run_name = stable_platform_run_name(self.conversation_id)
        self.coordinator = AgentCoordinator()
        self.sink = PlatformEventSink(ws, self.task)
        self.sink.scan_completed_callback = self._schedule_scan_completed
        self.report_state: ReportState | None = None
        self.run_dir = ""
        self.run_task: asyncio.Task[None] | None = None
        self.pump_task: asyncio.Task[None] | None = None
        self.completion_watch_task: asyncio.Task[None] | None = None
        self.started_at = time.monotonic()
        self._completion_sent = False
        self._closed = False

    def is_running(self) -> bool:
        return self.run_task is not None and not self.run_task.done()

    def update_task_context(self, task: dict[str, Any]) -> None:
        self.task = merge_task_context(self.task, task)
        self.sink.task = self.task

    async def start(self) -> None:
        if self.is_running():
            return
        if self.pump_task is None or self.pump_task.done():
            self.pump_task = asyncio.create_task(self.sink.pump())
        if self.completion_watch_task is None or self.completion_watch_task.done():
            self.completion_watch_task = asyncio.create_task(self._watch_scan_completion())
        self.run_task = asyncio.create_task(self._run())

    async def send_user_message(self, task: dict[str, Any]) -> bool:
        self.update_task_context(task)
        instruction = str(task.get("instruction") or "").strip()
        if not instruction:
            return False
        if not self.is_running():
            await self.start()
        root_id = await self._wait_for_root_agent()
        if root_id is None:
            return False
        return await self.coordinator.send(
            root_id,
            {
                "from": "user",
                "type": "instruction",
                "priority": "high",
                "content": instruction,
            },
        )

    async def interrupt(self, reason: str = "") -> None:
        root_id = await self._wait_for_root_agent(timeout=2.0)
        if root_id is not None:
            await self.coordinator.send(
                root_id,
                {
                    "from": "user",
                    "type": "instruction",
                    "priority": "urgent",
                    "content": (
                        "[User interrupt] Stop the current action as soon as possible, "
                        "preserve all findings and state, and wait for the user's next instruction."
                        + (f"\nReason/action: {reason}" if reason else "")
                    ),
                },
            )
            with contextlib.suppress(Exception):
                await self.coordinator.cancel_descendants_graceful(root_id)
                await self.coordinator.set_status(root_id, "stopped")
        if self.run_task and not self.run_task.done():
            self.run_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, TimeoutError, Exception):
                await asyncio.wait_for(self.run_task, timeout=10.0)
        if self.report_state is not None:
            with contextlib.suppress(Exception):
                self.report_state.cleanup(status="interrupted")
                await self._send_checkpoint("interrupted")
        await send(self.ws, text(self.task, "Node3 interrupted the current Strix run; session state is preserved."))
        await send(self.ws, {
            "type": "task_complete",
            "conversation_id": self.conversation_id,
            "task_id": self.task["task_id"],
            "status": "interrupted",
            "summary": f"Node3 Strix run interrupted. Run: {self.run_name}. Session can be continued from saved state.",
        })

    async def close(self) -> None:
        self._closed = True
        if self.run_task and not self.run_task.done():
            self.run_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.run_task
        if self.report_state is not None:
            with contextlib.suppress(Exception):
                self.report_state.cleanup(status="stopped")
        if self.run_name:
            with contextlib.suppress(Exception):
                await session_manager.cleanup(self.run_name)
        await self.sink.close()
        if self.completion_watch_task is not None and not self.completion_watch_task.done():
            self.completion_watch_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.completion_watch_task
        if self.pump_task is not None:
            await self.pump_task

    async def _run(self) -> None:
        target = extract_target(self.task)
        image = load_settings().runtime.image
        if not image:
            await send(self.ws, {
                "type": "task_error",
                "conversation_id": self.conversation_id,
                "task_id": self.task["task_id"],
                "message": "STRIX_IMAGE is not configured",
            })
            return

        try:
            async with working_directory(self.config.strix_project_dir):
                self.report_state = ReportState(self.run_name)
                self.report_state.hydrate_from_run_dir()
                targets_info = await self._targets_info(target)
                local_sources = collect_local_sources(targets_info)
                scan_config = self._scan_config(targets_info, local_sources, target)

                self.run_dir = str(self.report_state.get_run_dir())
                self.sink.set_run_context(self.run_name, self.run_dir)
                self.report_state.set_scan_config(scan_config)
                self.report_state.save_run_data()
                self.report_state.vulnerability_found_callback = self.sink.vulnerability_found
                set_global_report_state(self.report_state)

                await send(self.ws, text(
                    self.task,
                    f"Node3 attached this conversation to Strix session {self.run_name} for {target or 'the saved target'}.",
                ))
                await ensure_sandbox_image(image)
                await run_strix_scan(
                    scan_config=scan_config,
                    scan_id=self.run_name,
                    image=image,
                    local_sources=local_sources,
                    coordinator=self.coordinator,
                    interactive=True,
                    cleanup_on_exit=False,
                    event_sink=self.sink.sdk_event,
                )
        except asyncio.CancelledError:
            self.coordinator.mark_shutting_down()
            if self.report_state is not None:
                self.report_state.cleanup(status="interrupted")
                await self.sink.flush()
                await self._send_checkpoint("interrupted")
            raise
        except Exception as exc:
            if self.report_state is not None:
                self.report_state.cleanup(status="failed")
                await self.sink.flush()
                await self._send_checkpoint("failed")
            await send(self.ws, {
                "type": "task_error",
                "conversation_id": self.conversation_id,
                "task_id": self.task["task_id"],
                "message": str(exc),
            })

    async def _targets_info(self, target: str | None) -> list[dict[str, Any]]:
        if target:
            targets_info = build_targets_info(target)
            for target_info in targets_info:
                if target_info["type"] == "repository":
                    repo_url = target_info["details"]["target_repo"]
                    dest_name = target_info["details"].get("workspace_subdir")
                    cloned_path = clone_repository(repo_url, self.run_name, dest_name)
                    target_info["details"]["cloned_repo_path"] = cloned_path
            return targets_info

        if self.report_state is not None:
            saved = self.report_state.run_record.get("targets_info")
            if isinstance(saved, list) and saved:
                return [item for item in saved if isinstance(item, dict)]
        await send(self.ws, {
            "type": "task_error",
            "conversation_id": self.conversation_id,
            "task_id": self.task["task_id"],
            "message": "Node3 requires a target URL, host, repository, or local path for a new Strix conversation.",
        })
        raise RuntimeError("missing target for Strix conversation")

    def _scan_config(
        self,
        targets_info: list[dict[str, Any]],
        local_sources: list[dict[str, Any]],
        target: str | None,
    ) -> dict[str, Any]:
        scan_config: dict[str, Any] = {
            "scan_id": self.run_name,
            "targets": targets_info,
            "user_instructions": build_instruction(self.task),
            "run_name": self.run_name,
            "diff_scope": {"active": False},
            "scan_mode": self.task["scan_mode"],
            "non_interactive": False,
            "keep_alive_after_finish": True,
            "local_sources": local_sources,
            "scope_mode": "full",
            "diff_base": None,
            "resume_instruction": str(self.task.get("instruction") or "").strip(),
        }
        return scan_config

    async def _wait_for_root_agent(self, timeout: float = 30.0) -> str | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            async with self.coordinator._lock:
                for agent_id, parent_id in self.coordinator.parent_of.items():
                    if parent_id is None:
                        return agent_id
            await asyncio.sleep(0.1)
        return None

    def _schedule_scan_completed(self) -> None:
        if not self._completion_sent and not self._closed:
            self._completion_sent = True
            asyncio.create_task(self._on_scan_completed())

    async def _watch_scan_completion(self) -> None:
        while not self._closed and not self._completion_sent:
            await asyncio.sleep(COMPLETION_WATCH_INTERVAL_SECONDS)
            if self._report_state_scan_completed():
                self._schedule_scan_completed()
                return

    def _report_state_scan_completed(self) -> bool:
        if self.report_state is None:
            return False

        record = dict(self.report_state.run_record or {})
        if not self._record_is_scan_completed(record):
            run_dir = Path(self.run_dir) if self.run_dir else self.report_state.get_run_dir()
            run_json = run_dir / "run.json"
            if run_json.exists():
                try:
                    loaded = json.loads(run_json.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    loaded = {}
                if isinstance(loaded, dict):
                    record = loaded

        if not self._record_is_scan_completed(record):
            return False

        self.report_state.run_record.update(record)
        scan_results = record.get("scan_results")
        if isinstance(scan_results, dict):
            self.report_state.scan_results = scan_results
            self.report_state.final_scan_result = self.report_state._format_final_scan_result(scan_results)
        if isinstance(record.get("end_time"), str):
            self.report_state.end_time = record["end_time"]
        return True

    @staticmethod
    def _record_is_scan_completed(record: dict[str, Any]) -> bool:
        scan_results = record.get("scan_results")
        return (
            record.get("status") == "completed"
            and isinstance(scan_results, dict)
            and scan_results.get("scan_completed") is True
        )

    async def _flush_sink(self) -> None:
        try:
            await asyncio.wait_for(self.sink.flush(), timeout=COMPLETION_FLUSH_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            pass

    async def _on_scan_completed(self) -> None:
        if self.report_state is None:
            return
        await self._flush_sink()
        await emit_final_artifacts(self.ws, self.task, self.run_name, self.report_state)
        finding_count = len(self.report_state.vulnerability_reports)
        completion_gate = self._completion_gate()
        task_status = "completed" if completion_gate["ok"] else "incomplete"
        await self._send_checkpoint("scan_completed" if completion_gate["ok"] else "scan_incomplete")
        await send(self.ws, text(
            self.task,
            completion_text(finding_count, completion_gate),
        ))
        await send(self.ws, {
            "type": "task_complete",
            "conversation_id": self.conversation_id,
            "task_id": self.task["task_id"],
            "status": task_status,
            "summary": completion_summary(
                task_status,
                self.run_name,
                finding_count,
                time.monotonic() - self.started_at,
                completion_gate,
            ),
        })

    async def _send_checkpoint(self, status: str) -> None:
        if self.report_state is None:
            return
        await send_runtime_checkpoint(
            self.ws,
            self.task,
            self.sink,
            self.report_state,
            self.run_name,
            session_metadata={
                "conversation_id": self.conversation_id,
                "run_name": self.run_name,
                "run_dir": self.run_dir,
                "status": status,
            },
        )

    def _completion_gate(self) -> dict[str, Any]:
        if self.report_state is None:
            return {"ok": True, "unfinished_todos": [], "unfinished_count": 0}
        run_dir = Path(self.run_dir) if self.run_dir else self.report_state.get_run_dir()
        return completion_gate_for_run(run_dir)


async def run_platform_scan(ws: Any, task: dict[str, Any], config: Any) -> None:
    target = extract_target(task)
    if not target:
        await send(ws, {
            "type": "task_error",
            "conversation_id": task["conversation_id"],
            "task_id": task["task_id"],
            "message": "Node3 requires a target URL, host, repository, or local path.",
        })
        return

    started_at = time.monotonic()
    sink = PlatformEventSink(ws, task)
    coordinator = AgentCoordinator()
    run_name = ""
    report_state: ReportState | None = None
    pump_task = asyncio.create_task(sink.pump())

    try:
        async with working_directory(config.strix_project_dir):
            targets_info = build_targets_info(target)
            run_name = generate_run_name(targets_info)
            for target_info in targets_info:
                if target_info["type"] == "repository":
                    repo_url = target_info["details"]["target_repo"]
                    dest_name = target_info["details"].get("workspace_subdir")
                    cloned_path = clone_repository(repo_url, run_name, dest_name)
                    target_info["details"]["cloned_repo_path"] = cloned_path

            local_sources = collect_local_sources(targets_info)
            scan_config = {
                "scan_id": run_name,
                "targets": targets_info,
                "user_instructions": build_instruction(task),
                "run_name": run_name,
                "diff_scope": {"active": False},
                "scan_mode": task["scan_mode"],
                "non_interactive": True,
                "local_sources": local_sources,
                "scope_mode": "full",
                "diff_base": None,
                "resume_instruction": "",
            }
            report_state = ReportState(run_name)
            report_state.hydrate_from_run_dir()
            run_dir = str(report_state.get_run_dir())
            sink.set_run_context(run_name, run_dir)
            report_state.set_scan_config(scan_config)
            report_state.save_run_data()
            report_state.vulnerability_found_callback = sink.vulnerability_found
            set_global_report_state(report_state)

            image = load_settings().runtime.image
            if not image:
                raise RuntimeError("STRIX_IMAGE is not configured")

            await send(ws, text(task, f"Node3 已接管任务，使用 Strix {task['scan_mode']} 模式测试 {target}。"))
            await ensure_sandbox_image(image)
            await run_strix_scan(
                scan_config=scan_config,
                scan_id=run_name,
                image=image,
                local_sources=local_sources,
                coordinator=coordinator,
                interactive=False,
                cleanup_on_exit=True,
                event_sink=sink.sdk_event,
            )

            await sink.flush()
            await emit_final_artifacts(ws, task, run_name, report_state)
            finding_count = len(report_state.vulnerability_reports)
            completion_gate = completion_gate_for_run(Path(run_dir))
            task_status = "completed" if completion_gate["ok"] else "incomplete"
            await send_runtime_checkpoint(
                ws,
                task,
                sink,
                report_state,
                run_name,
                session_metadata={"status": "scan_completed" if completion_gate["ok"] else "scan_incomplete"},
            )
            await send(ws, text(task, completion_text(finding_count, completion_gate)))
            await send(ws, {
                "type": "task_complete",
                "conversation_id": task["conversation_id"],
                "task_id": task["task_id"],
                "status": task_status,
                "summary": completion_summary(
                    task_status,
                    run_name,
                    finding_count,
                    time.monotonic() - started_at,
                    completion_gate,
                ),
            })
    except asyncio.CancelledError:
        coordinator.mark_shutting_down()
        if run_name:
            with contextlib.suppress(Exception):
                await session_manager.cleanup(run_name)
        if report_state is not None:
            report_state.cleanup(status="interrupted")
            await sink.flush()
            await send_runtime_checkpoint(ws, task, sink, report_state, run_name)
        await send(ws, {
            "type": "task_error",
            "conversation_id": task["conversation_id"],
            "task_id": task["task_id"],
            "message": "Node3 Strix scan was interrupted.",
        })
        raise
    except Exception as exc:
        if report_state is not None:
            report_state.cleanup(status="failed")
            await sink.flush()
            await send_runtime_checkpoint(ws, task, sink, report_state, run_name)
        await send(ws, {
            "type": "task_error",
            "conversation_id": task["conversation_id"],
            "task_id": task["task_id"],
            "message": str(exc),
        })
    finally:
        await sink.close()
        await pump_task


async def send_runtime_checkpoint(
    ws: Any,
    task: dict[str, Any],
    sink: PlatformEventSink,
    report_state: ReportState,
    run_name: str,
    session_metadata: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if not run_name:
        return None
    checkpoint_message = runtime_checkpoint(
        task,
        run_name,
        str(report_state.get_run_dir()),
        fallback_agents=list(sink.agents_by_id.values()),
    )
    node3_strix = checkpoint_message.get("checkpoint", {}).get("node3_strix", {})
    if isinstance(node3_strix, dict) and not node3_strix.get("vulnerabilities") and report_state.vulnerability_reports:
        node3_strix["vulnerabilities"] = normalize_vulnerabilities(report_state.vulnerability_reports)
    if isinstance(node3_strix, dict) and session_metadata:
        node3_strix["session"] = dict(session_metadata)
    await send(ws, checkpoint_message)
    return checkpoint_message


def build_targets_info(target: str) -> list[dict[str, Any]]:
    target_type, target_details = infer_target_type(target)
    display_target = target_details.get("target_path", target) if target_type == "local_code" else target
    targets_info = [{"type": target_type, "details": target_details, "original": display_target}]
    assign_workspace_subdirs(targets_info)
    rewrite_localhost_targets(targets_info, HOST_GATEWAY_HOSTNAME)
    return targets_info


async def ensure_sandbox_image(image: str) -> None:
    if await docker_image_exists(image):
        return
    process = await asyncio.create_subprocess_exec(
        "docker",
        "pull",
        image,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    last_progress = ""
    assert process.stdout is not None
    while True:
        try:
            raw_line = await asyncio.wait_for(process.stdout.readline(), timeout=2.0)
        except TimeoutError:
            raw_line = None
        if raw_line:
            last_progress = raw_line.decode("utf-8", errors="replace").strip()
        elif raw_line == b"":
            break
        if raw_line is None and process.returncode is None:
            await asyncio.sleep(0)
    exit_code = await process.wait()
    if exit_code != 0:
        raise RuntimeError(f"docker pull {image} failed with code {exit_code}. Last output: {last_progress}")


async def docker_image_exists(image: str) -> bool:
    process = await asyncio.create_subprocess_exec(
        "docker",
        "image",
        "inspect",
        image,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    return await process.wait() == 0


@contextlib.asynccontextmanager
async def working_directory(path: Path) -> AsyncIterator[None]:
    previous = Path.cwd()
    path.mkdir(parents=True, exist_ok=True)
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def build_instruction(task: dict[str, Any]) -> str:
    pieces = [
        str(task.get("instruction") or "").strip(),
        "Run in coverage-first mode: map the authorized attack surface and plan endpoint/business-flow coverage before deep vulnerability validation.",
        "Avoid reporting negative or speculative findings as vulnerabilities.",
    ]
    return "\n\n".join(piece for piece in pieces if piece)


def should_forward_docker_pull_line(line: str) -> bool:
    if not line:
        return False
    lowered = line.lower()
    return any(
        marker in lowered
        for marker in (
            "pulling from",
            "pulling fs layer",
            "waiting",
            "downloading",
            "verifying checksum",
            "extracting",
            "pull complete",
            "download complete",
            "downloaded newer image",
            "image is up to date",
            "digest:",
            "status:",
        )
    )


def format_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes = int(seconds // 60)
    rest = int(seconds % 60)
    return f"{minutes}m {rest}s"


def unfinished_todos_for_run(run_dir: Path) -> list[dict[str, Any]]:
    todos = todos_from_file(run_dir / ".state" / "todos.json")
    return [
        todo
        for todo in todos
        if str(todo.get("status") or "pending").lower() not in TERMINAL_TODO_STATUSES
    ]


def split_actionable_unfinished_todos(run_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    unfinished = unfinished_todos_for_run(run_dir)
    if not unfinished:
        return [], []

    agent_statuses = {
        str(agent.get("id") or ""): str(agent.get("status") or "").lower()
        for agent in agent_graph_from_file(run_dir / ".state" / "agents.json")
        if str(agent.get("id") or "")
    }
    actionable = []
    ignored = []
    for todo in unfinished:
        agent_id = str(todo.get("agent_id") or "")
        if agent_id and agent_statuses.get(agent_id) in TERMINAL_AGENT_STATUSES:
            ignored.append({
                **todo,
                "ignore_reason": f"owner agent is {agent_statuses[agent_id]}",
            })
            continue
        linked_agent_id = str(todo.get("linked_agent_id") or "")
        if linked_agent_id and agent_statuses.get(linked_agent_id) in TERMINAL_AGENT_STATUSES:
            ignored.append({
                **todo,
                "ignore_reason": f"linked agent is {agent_statuses[linked_agent_id]}",
            })
        else:
            actionable.append(todo)
    return actionable, ignored


def _normalize_endpoint_target(raw: Any) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    parsed = urlsplit(value)
    if parsed.scheme and parsed.netloc:
        path = parsed.path or "/"
        if path != "/":
            path = path.rstrip("/")
        return urlunsplit((
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            path,
            parsed.query,
            "",
        ))
    return value.rstrip("/").lower()


def _endpoint_target_variants(raw: Any) -> set[str]:
    value = str(raw or "").strip()
    if not value:
        return set()
    normalized = _normalize_endpoint_target(value)
    variants = {normalized} if normalized else set()
    parsed = urlsplit(value)
    if parsed.scheme and parsed.netloc:
        path = parsed.path or "/"
        if path != "/":
            path = path.rstrip("/")
        path_key = urlunsplit(("", "", path, parsed.query, "")).lower()
        if path_key:
            variants.add(path_key)
        variants.add(urlunsplit(("", "", path, "", "")).lower())
    return variants


def _coverage_endpoint_key(item: dict[str, Any]) -> tuple[str | None, set[str]]:
    endpoint = str(item.get("endpoint") or "").strip()
    parts = [part.strip() for part in endpoint.split(",") if part.strip()]
    if len(parts) > 1 and any(HTTP_METHOD_RE.match(part) for part in parts):
        targets: set[str] = set()
        for part in parts:
            match = HTTP_METHOD_RE.match(part)
            target = match.group(2) if match else part
            targets.update(_endpoint_target_variants(target))
        return None, targets
    match = HTTP_METHOD_RE.match(endpoint)
    method = match.group(1).upper() if match else None
    target = match.group(2) if match else endpoint
    return method, _endpoint_target_variants(target)


def _surface_endpoint_key(item: dict[str, Any]) -> tuple[str | None, set[str]]:
    method = str(item.get("method") or "").strip().upper() or None
    target = item.get("url") or item.get("address")
    return method, _endpoint_target_variants(target)


def _coverage_resolves_surface(item: dict[str, Any]) -> bool:
    status = str(item.get("status") or "").lower()
    if status in MEANINGFUL_COVERAGE_STATUSES:
        return True
    if status in {"blocked", "skipped"}:
        return bool(str(item.get("result") or item.get("notes") or "").strip())
    return False


def _method_tokens(value: Any) -> set[str]:
    text = str(value or "").strip().upper()
    if not text or text in {"-", "ANY", "ALL", "*"}:
        return set()
    return {
        part
        for part in re.split(r"[^A-Z]+", text)
        if part in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"}
    }


def _methods_compatible(left: Any, right: Any) -> bool:
    left_tokens = _method_tokens(left)
    right_tokens = _method_tokens(right)
    return not left_tokens or not right_tokens or bool(left_tokens.intersection(right_tokens))


def _hypothesis_endpoint_keys(item: dict[str, Any]) -> list[tuple[str | None, set[str]]]:
    explicit_method = str(item.get("method") or "").strip().upper() or None
    endpoint = str(item.get("endpoint") or "").strip()
    parts = [part.strip() for part in endpoint.split(",") if part.strip()]
    if len(parts) > 1 and any(HTTP_METHOD_RE.match(part) for part in parts):
        keys: list[tuple[str | None, set[str]]] = []
        for part in parts:
            match = HTTP_METHOD_RE.match(part)
            method = explicit_method or (match.group(1).upper() if match else None)
            target = match.group(2) if match else part
            targets = _endpoint_target_variants(target)
            if targets:
                keys.append((method, targets))
        return keys
    match = HTTP_METHOD_RE.match(endpoint)
    method = explicit_method or (match.group(1).upper() if match else None)
    target = match.group(2) if match else endpoint
    targets = _endpoint_target_variants(target)
    return [(method, targets)] if targets else []


def surface_hypothesis_gaps(
    attack_surface: list[dict[str, Any]],
    hypotheses: list[dict[str, Any]],
    workflow_state: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Return testable attack surfaces that have no linked hypothesis."""
    hypotheses_by_surface = {
        str(item.get("surface_id") or "").strip()
        for item in hypotheses
        if str(item.get("surface_id") or "").strip()
    }
    hypothesis_endpoints = [
        (item, hypothesis_method, hypothesis_targets)
        for item in hypotheses
        for hypothesis_method, hypothesis_targets in _hypothesis_endpoint_keys(item)
    ]
    gaps: list[dict[str, Any]] = []
    for item in attack_surface:
        kind = str(item.get("kind") or "").lower()
        if kind and kind not in SURFACE_KINDS_REQUIRING_COVERAGE:
            continue
        if workflow_state is not None and not target_in_authorized_scope(
            workflow_state,
            item.get("url") or item.get("address"),
        ):
            continue
        surface_id = str(item.get("surface_id") or "").strip()
        if surface_id and surface_id in hypotheses_by_surface:
            continue
        surface_method, surface_targets = _surface_endpoint_key(item)
        if not surface_targets:
            continue
        matched = False
        for _, hypothesis_method, hypothesis_targets in hypothesis_endpoints:
            if not surface_targets.intersection(hypothesis_targets):
                continue
            if _methods_compatible(surface_method, hypothesis_method):
                matched = True
                break
        if not matched:
            gaps.append({
                "surface_id": item.get("surface_id"),
                "kind": item.get("kind"),
                "method": item.get("method"),
                "url": item.get("url"),
                "address": item.get("address"),
                "parameters": item.get("parameters"),
                "auth_state": item.get("auth_state"),
                "source": item.get("source"),
            })
    return gaps


def coverage_without_hypothesis_links(
    coverage: list[dict[str, Any]],
    hypotheses: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return meaningful coverage records that are not tied to a hypothesis."""
    linked_coverage_ids = {
        str(coverage_id).strip()
        for hypothesis in hypotheses
        for coverage_id in (hypothesis.get("coverage_ids") if isinstance(hypothesis.get("coverage_ids"), list) else [])
        if str(coverage_id).strip()
    }
    known_hypothesis_ids = {
        str(hypothesis.get("hypothesis_id") or "").strip()
        for hypothesis in hypotheses
        if str(hypothesis.get("hypothesis_id") or "").strip()
    }
    gaps: list[dict[str, Any]] = []
    for item in coverage:
        if not _coverage_resolves_surface(item):
            continue
        coverage_id = str(item.get("coverage_id") or "").strip()
        hypothesis_id = str(item.get("hypothesis_id") or "").strip()
        if hypothesis_id and hypothesis_id in known_hypothesis_ids:
            continue
        if coverage_id and coverage_id in linked_coverage_ids:
            continue
        gaps.append({
            "coverage_id": item.get("coverage_id"),
            "endpoint": item.get("endpoint"),
            "parameter": item.get("parameter"),
            "vuln_type": item.get("vuln_type"),
            "status": item.get("status"),
            "auth_state": item.get("auth_state"),
            "evidence_ids": _clean_evidence_ids(item.get("evidence_ids")),
            "result": item.get("result"),
        })
    return gaps


def uncovered_attack_surfaces(
    attack_surface: list[dict[str, Any]],
    coverage: list[dict[str, Any]],
    workflow_state: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    resolved_coverage = [
        item
        for item in coverage
        if _coverage_resolves_surface(item)
    ]
    covered_exact: set[tuple[str | None, str]] = set()
    for item in resolved_coverage:
        method, targets = _coverage_endpoint_key(item)
        for target in targets:
            covered_exact.add((method, target))
    covered_by_target: dict[str, set[str | None]] = {}
    for method, target in covered_exact:
        if target:
            covered_by_target.setdefault(target, set()).add(method)

    uncovered: list[dict[str, Any]] = []
    for item in attack_surface:
        kind = str(item.get("kind") or "").lower()
        if kind and kind not in SURFACE_KINDS_REQUIRING_COVERAGE:
            continue
        if workflow_state is not None and not target_in_authorized_scope(
            workflow_state,
            item.get("url") or item.get("address"),
        ):
            continue
        method, targets = _surface_endpoint_key(item)
        if not targets:
            continue
        if method:
            covered = any((method, target) in covered_exact or (None, target) in covered_exact for target in targets)
        else:
            covered = any(target in covered_by_target for target in targets)
        if not covered:
            uncovered.append({
                "surface_id": item.get("surface_id"),
                "kind": item.get("kind"),
                "method": item.get("method"),
                "url": item.get("url"),
                "address": item.get("address"),
                "source": item.get("source"),
            })
    return uncovered


def invalid_vulnerability_validations(
    vulnerabilities: list[dict[str, Any]],
    agents: list[dict[str, Any]],
    evidence_records: dict[str, dict[str, Any]] | set[str],
) -> list[dict[str, Any]]:
    enforce_evidence_owner = isinstance(evidence_records, dict)
    evidence_by_id = (
        evidence_records
        if enforce_evidence_owner
        else {evidence_id: {"evidence_id": evidence_id} for evidence_id in evidence_records}
    )
    agents_by_id = {
        str(agent.get("id") or ""): agent
        for agent in agents
        if str(agent.get("id") or "").strip()
    }
    invalid: list[dict[str, Any]] = []
    for item in vulnerabilities:
        problems: list[str] = []
        validation_agent_id = str(item.get("validation_agent_id") or "").strip()
        validation_evidence_ids = _clean_evidence_ids(item.get("validation_evidence_ids"))
        reporting_agent_id = str(item.get("agent_id") or "").strip()
        if not validation_agent_id:
            problems.append("missing validation_agent_id")
        else:
            validation_agent = agents_by_id.get(validation_agent_id)
            if validation_agent is None:
                problems.append("validation_agent_id not found in agent graph")
            elif not str(validation_agent.get("parent_id") or "").strip():
                problems.append("validation_agent_id references root agent")
            if reporting_agent_id and validation_agent_id == reporting_agent_id:
                problems.append("validation_agent_id matches reporting agent")
        if not validation_evidence_ids:
            problems.append("missing validation_evidence_ids")
        else:
            missing_validation_evidence = [
                evidence_id
                for evidence_id in validation_evidence_ids
                if evidence_id not in evidence_by_id
            ]
            if missing_validation_evidence:
                problems.append("validation evidence missing: " + ", ".join(missing_validation_evidence))
            if enforce_evidence_owner and validation_agent_id:
                wrong_owner = [
                    evidence_id
                    for evidence_id in validation_evidence_ids
                    if evidence_id in evidence_by_id
                    and str(evidence_by_id[evidence_id].get("agent_id") or "").strip() != validation_agent_id
                ]
                if wrong_owner:
                    problems.append(
                        "validation evidence not recorded by validation_agent_id: "
                        + ", ".join(wrong_owner)
                    )
        if problems:
            invalid.append({
                "id": item.get("id"),
                "title": item.get("title"),
                "agent_id": item.get("agent_id"),
                "validation_agent_id": item.get("validation_agent_id"),
                "validation_evidence_ids": validation_evidence_ids,
                "problems": problems,
            })
    return invalid


def confirmed_coverage_without_reports(
    coverage: list[dict[str, Any]],
    vulnerabilities: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return positive coverage records that have no matching formal report."""
    confirmed = [
        item
        for item in coverage
        if str(item.get("status") or "").strip().lower() == "passed"
    ]
    gaps: list[dict[str, Any]] = []
    for item in confirmed:
        if any(_coverage_matches_vulnerability(item, vuln) for vuln in vulnerabilities):
            continue
        gaps.append({
            "coverage_id": item.get("coverage_id"),
            "endpoint": item.get("endpoint"),
            "parameter": item.get("parameter"),
            "vuln_type": item.get("vuln_type"),
            "auth_state": item.get("auth_state"),
            "evidence_ids": _clean_evidence_ids(item.get("evidence_ids")),
            "result": item.get("result"),
        })
    return gaps


def _coverage_matches_vulnerability(coverage_item: dict[str, Any], vulnerability: dict[str, Any]) -> bool:
    coverage_evidence = set(_clean_evidence_ids(coverage_item.get("evidence_ids")))
    vulnerability_evidence = set(
        _clean_evidence_ids(vulnerability.get("evidence_ids"))
        + _clean_evidence_ids(vulnerability.get("validation_evidence_ids")),
    )
    if coverage_evidence and coverage_evidence.intersection(vulnerability_evidence):
        return True

    coverage_method, coverage_targets = _coverage_endpoint_key(coverage_item)
    for vuln_method, vuln_targets in _vulnerability_endpoint_keys(vulnerability):
        if not coverage_targets.intersection(vuln_targets):
            continue
        if coverage_method and vuln_method and coverage_method != vuln_method:
            continue
        return True
    return False


def _vulnerability_endpoint_keys(item: dict[str, Any]) -> list[tuple[str | None, set[str]]]:
    keys: list[tuple[str | None, set[str]]] = []
    explicit_method = str(item.get("method") or "").strip().upper() or None
    for raw in (item.get("endpoint"), item.get("target")):
        text = str(raw or "").strip()
        if not text:
            continue
        match = HTTP_METHOD_RE.match(text)
        method = explicit_method or (match.group(1).upper() if match else None)
        target = match.group(2) if match else text
        targets = _endpoint_target_variants(target)
        if targets:
            keys.append((method, targets))
    return keys


def completion_gate_for_run(run_dir: Path) -> dict[str, Any]:
    unfinished, ignored_unfinished = split_actionable_unfinished_todos(run_dir)
    state_dir = run_dir / ".state"
    workflow_state = load_workflow_state(state_dir)
    workflow_sitemap_gate = sitemap_gate(state_dir)
    agents = agent_graph_from_file(state_dir / "agents.json")
    attack_surface = attack_surface_from_file(state_dir / "attack_surface.json")
    hypotheses = hypotheses_from_file(state_dir / "hypotheses.json")
    coverage = coverage_from_file(state_dir / "coverage.json")
    evidence = evidence_from_file(state_dir / "evidence.json")
    vulnerabilities = normalize_vulnerabilities_from_run(run_dir)
    evidence_by_id = {
        str(item.get("evidence_id")): item
        for item in evidence
        if str(item.get("evidence_id") or "").strip()
    }
    evidence_ids = set(evidence_by_id)
    meaningful_coverage = [
        item
        for item in coverage
        if str(item.get("status") or "").lower() in MEANINGFUL_COVERAGE_STATUSES
    ]
    unevidenced_findings = [
        item
        for item in vulnerabilities
        if not _clean_evidence_ids(item.get("evidence_ids"))
    ]
    missing_evidence_refs = sorted({
        evidence_id
        for item in vulnerabilities + coverage + attack_surface
        for evidence_id in (
            _clean_evidence_ids(item.get("evidence_ids"))
            + _clean_evidence_ids(item.get("validation_evidence_ids"))
        )
        if evidence_id not in evidence_ids
    })
    uncovered_surfaces = uncovered_attack_surfaces(attack_surface, coverage, workflow_state)
    surface_hypothesis_gap_list = surface_hypothesis_gaps(attack_surface, hypotheses, workflow_state)
    unlinked_coverage = coverage_without_hypothesis_links(coverage, hypotheses)
    hypothesis_gap_list = hypothesis_gaps(hypotheses, {
        str(item.get("coverage_id")): item
        for item in coverage
        if str(item.get("coverage_id") or "").strip()
    }, evidence_by_id)
    discovered_surface_gaps = discovered_inventory_gaps(workflow_state, attack_surface)
    sitemap_pagination_gaps = sitemap_pagination_gaps_from_state(workflow_state)
    sitemap_expansion_gaps = sitemap_expansion_gaps_from_state(workflow_state)
    invalid_validations = invalid_vulnerability_validations(vulnerabilities, agents, evidence_by_id)
    unreported_confirmed = confirmed_coverage_without_reports(coverage, vulnerabilities)
    reasons: list[str] = []
    if not workflow_sitemap_gate.get("ok"):
        reasons.append(str(workflow_sitemap_gate.get("reason") or "sitemap workflow gate failed"))
    if unfinished:
        reasons.append(f"{len(unfinished)} unresolved task(s)")
    if not attack_surface:
        reasons.append("no attack surface records")
    if attack_surface and not hypotheses:
        reasons.append("no hypothesis/test-matrix records")
    if surface_hypothesis_gap_list:
        reasons.append(f"{len(surface_hypothesis_gap_list)} attack surface record(s) without hypothesis/test-matrix coverage")
    if hypothesis_gap_list:
        reasons.append(f"{len(hypothesis_gap_list)} unresolved hypothesis/test-matrix item(s)")
    if unlinked_coverage:
        reasons.append(f"{len(unlinked_coverage)} coverage record(s) not linked to a hypothesis/test-matrix item")
    if not meaningful_coverage:
        reasons.append("no meaningful coverage records")
    if uncovered_surfaces:
        reasons.append(f"{len(uncovered_surfaces)} attack surface record(s) without coverage")
    if discovered_surface_gaps:
        reasons.append(f"{len(discovered_surface_gaps)} externally discovered endpoint(s) missing from attack surface")
    if sitemap_pagination_gaps:
        reasons.append(f"{len(sitemap_pagination_gaps)} sitemap branch(es) with unenumerated pages")
    if sitemap_expansion_gaps:
        reasons.append(f"{len(sitemap_expansion_gaps)} sitemap branch(es) with descendants not expanded")
    if unevidenced_findings:
        reasons.append(f"{len(unevidenced_findings)} finding(s) without evidence_ids")
    if missing_evidence_refs:
        reasons.append(f"{len(missing_evidence_refs)} missing evidence reference(s)")
    if invalid_validations:
        reasons.append(f"{len(invalid_validations)} finding(s) without independent subagent validation")
    if unreported_confirmed:
        reasons.append(f"{len(unreported_confirmed)} confirmed coverage record(s) without vulnerability report")
    warnings: list[str] = []
    if ignored_unfinished:
        warnings.append(
            f"{len(ignored_unfinished)} unresolved task(s) ignored because their owner agent is terminal"
        )
    return {
        "ok": not reasons,
        "unfinished_todos": unfinished[:20],
        "unfinished_count": len(unfinished),
        "ignored_unfinished_todos": ignored_unfinished[:20],
        "ignored_unfinished_count": len(ignored_unfinished),
        "attack_surface_count": len(attack_surface),
        "hypothesis_count": len(hypotheses),
        "surface_hypothesis_gaps": surface_hypothesis_gap_list[:20],
        "surface_hypothesis_gap_count": len(surface_hypothesis_gap_list),
        "hypothesis_gaps": hypothesis_gap_list[:20],
        "hypothesis_gap_count": len(hypothesis_gap_list),
        "coverage_count": len(coverage),
        "meaningful_coverage_count": len(meaningful_coverage),
        "coverage_without_hypothesis": unlinked_coverage[:20],
        "coverage_without_hypothesis_count": len(unlinked_coverage),
        "uncovered_attack_surfaces": uncovered_surfaces[:20],
        "uncovered_attack_surface_count": len(uncovered_surfaces),
        "external_discovery_count": int(workflow_state.get("external_discovery_count") or 0),
        "external_discovery_gaps": discovered_surface_gaps[:20],
        "external_discovery_gap_count": len(discovered_surface_gaps),
        "sitemap_pagination_gaps": sitemap_pagination_gaps[:20],
        "sitemap_pagination_gap_count": len(sitemap_pagination_gaps),
        "sitemap_expansion_gaps": sitemap_expansion_gaps[:20],
        "sitemap_expansion_gap_count": len(sitemap_expansion_gaps),
        "evidence_count": len(evidence),
        "unevidenced_findings": unevidenced_findings[:20],
        "unevidenced_finding_count": len(unevidenced_findings),
        "missing_evidence_refs": missing_evidence_refs[:20],
        "missing_evidence_ref_count": len(missing_evidence_refs),
        "invalid_vulnerability_validations": invalid_validations[:20],
        "invalid_vulnerability_validation_count": len(invalid_validations),
        "unreported_confirmed_coverage": unreported_confirmed[:20],
        "unreported_confirmed_coverage_count": len(unreported_confirmed),
        "workflow_state": workflow_state,
        "workflow_gate": workflow_sitemap_gate,
        "incomplete_reasons": reasons,
        "completion_warnings": warnings,
    }


def normalize_vulnerabilities_from_run(run_dir: Path) -> list[dict[str, Any]]:
    path = run_dir / "vulnerabilities.json"
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return normalize_vulnerabilities(raw)


def _clean_evidence_ids(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [str(item).strip() for item in raw if str(item).strip()]


def completion_text(finding_count: int, completion_gate: dict[str, Any]) -> str:
    if completion_gate.get("ok"):
        return f"Strix scan report completed with {finding_count} vulnerabilities. The conversation remains attached for follow-up."
    reasons = completion_gate.get("incomplete_reasons")
    reason_text = "; ".join(str(reason) for reason in reasons[:5]) if isinstance(reasons, list) else "quality gates did not pass"
    return (
        f"Strix generated a report with {finding_count} vulnerabilities, but completion gates did not pass "
        f"({reason_text}). The conversation is marked incomplete for follow-up."
    )


def completion_summary(
    status: str,
    run_name: str,
    finding_count: int,
    elapsed_seconds: float,
    completion_gate: dict[str, Any],
) -> str:
    base = (
        f"Node3 Strix scan {'completed' if status == 'completed' else 'incomplete'} "
        f"in {format_duration(elapsed_seconds)}. Run: {run_name}. Findings: {finding_count}."
    )
    if status == "completed":
        return f"{base} Session remains available for follow-up."
    unfinished_count = int(completion_gate.get("unfinished_count") or 0)
    unfinished = completion_gate.get("unfinished_todos") if isinstance(completion_gate.get("unfinished_todos"), list) else []
    titles = [str(todo.get("title") or "Untitled task") for todo in unfinished[:5] if isinstance(todo, dict)]
    reasons = completion_gate.get("incomplete_reasons")
    reason_text = "; ".join(str(reason) for reason in reasons[:5]) if isinstance(reasons, list) else "quality gates did not pass"
    suffix = f" Completion gates: {reason_text}. Unresolved tasks: {unfinished_count}."
    if titles:
        suffix += " Examples: " + "; ".join(titles) + "."
    return base + suffix
