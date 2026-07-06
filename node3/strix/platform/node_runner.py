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
from strix.report.state import ReportState, set_global_report_state
from strix.runtime import session_manager


HOST_GATEWAY_HOSTNAME = "host.docker.internal"


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
            final_checkpoint = runtime_checkpoint(
                task,
                run_name,
                run_dir,
                fallback_agents=list(sink.agents_by_id.values()),
            )
            node3_strix = final_checkpoint.get("checkpoint", {}).get("node3_strix", {})
            if isinstance(node3_strix, dict) and not node3_strix.get("vulnerabilities") and report_state.vulnerability_reports:
                node3_strix["vulnerabilities"] = normalize_vulnerabilities(report_state.vulnerability_reports)
            await send(ws, final_checkpoint)
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
        await send(ws, {
            "type": "task_error",
            "conversation_id": task["conversation_id"],
            "task_id": task["task_id"],
            "message": str(exc),
        })
    finally:
        await sink.close()
        await pump_task


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
