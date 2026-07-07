from __future__ import annotations

import asyncio
import contextlib
import os
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

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
    emit_final_artifacts,
    extract_target,
    normalize_vulnerabilities,
    runtime_checkpoint,
    send,
    text,
)
from strix.profiles import infer_target_profile, load_target_profile
from strix.report.state import ReportState, set_global_report_state
from strix.runtime import session_manager


HOST_GATEWAY_HOSTNAME = "host.docker.internal"


def stable_platform_run_name(conversation_id: str) -> str:
    safe = "".join(ch if ch.isalnum() else "-" for ch in str(conversation_id).strip().lower())
    safe = "-".join(part for part in safe.split("-") if part)
    return f"conversation-{safe[:36] or 'session'}"


def merge_task_context(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    for key in ("instruction", "scan_mode", "target_profile"):
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
            delivered = await self.coordinator.send(
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
            if delivered:
                await send(self.ws, text(self.task, "Node3 paused the current Strix action; session state is preserved."))
                return
        if self.run_task and not self.run_task.done():
            self.run_task.cancel()
        await send(self.ws, text(self.task, "Node3 interrupted Strix before the root session was ready."))

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
        target_profile = load_target_profile(infer_target_profile(self.task, target or ""))
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
        if target_profile is not None:
            scan_config["target_profile"] = {
                "name": target_profile.name,
                "title": target_profile.title,
                "content": target_profile.content,
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

    async def _on_scan_completed(self) -> None:
        if self.report_state is None:
            return
        await self.sink.flush()
        await emit_final_artifacts(self.ws, self.task, self.run_name, self.report_state)
        finding_count = len(self.report_state.vulnerability_reports)
        await self._send_checkpoint("scan_completed")
        await send(self.ws, text(
            self.task,
            f"Strix scan report completed with {finding_count} vulnerabilities. The conversation remains attached for follow-up.",
        ))
        await send(self.ws, {
            "type": "task_complete",
            "conversation_id": self.conversation_id,
            "task_id": self.task["task_id"],
            "status": "completed",
            "summary": (
                f"Node3 Strix scan completed in {format_duration(time.monotonic() - self.started_at)}. "
                f"Run: {self.run_name}. Findings: {finding_count}. Session remains available for follow-up."
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
            target_profile = load_target_profile(infer_target_profile(task, target))
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
            if target_profile is not None:
                scan_config["target_profile"] = {
                    "name": target_profile.name,
                    "title": target_profile.title,
                    "content": target_profile.content,
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
            await send_runtime_checkpoint(ws, task, sink, report_state, run_name)
            await send(ws, text(task, f"Strix 扫描完成，已记录 {finding_count} 个漏洞。报告、证据和运行状态已同步到平台。"))
            await send(ws, {
                "type": "task_complete",
                "conversation_id": task["conversation_id"],
                "task_id": task["task_id"],
                "status": "completed",
                "summary": f"Node3 Strix scan completed in {format_duration(time.monotonic() - started_at)}. Run: {run_name}. Findings: {finding_count}.",
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
        "Run in benchmark-friendly mode: prioritize confirmed, reproducible web vulnerabilities; include endpoint, method, parameter, proof of concept, impact, and remediation for each finding.",
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
