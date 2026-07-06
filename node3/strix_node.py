from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import sys
import time
import types
from collections.abc import AsyncIterator
from pathlib import PurePosixPath
from pathlib import Path
from typing import Any

from agents import RunContextWrapper
from strix.config import load_settings
from strix.core.agents import AgentCoordinator
from strix.report.state import ReportState, set_global_report_state
from strix.runtime import session_manager


HOST_GATEWAY_HOSTNAME = "host.docker.internal"
MAX_TOOL_OUTPUT_CHARS = 4000
logger = logging.getLogger(__name__)

_CVSS_VALID = {
    "attack_vector": ["N", "A", "L", "P"],
    "attack_complexity": ["L", "H"],
    "privileges_required": ["N", "L", "H"],
    "user_interaction": ["N", "R"],
    "scope": ["U", "C"],
    "confidentiality": ["N", "L", "H"],
    "integrity": ["N", "L", "H"],
    "availability": ["N", "L", "H"],
}

_CODE_LOCATION_FIELDS = (
    "file",
    "start_line",
    "end_line",
    "snippet",
    "label",
    "fix_before",
    "fix_after",
)

_REQUIRED_REPORT_FIELDS = {
    "title": "Title cannot be empty",
    "description": "Description cannot be empty",
    "impact": "Impact cannot be empty",
    "target": "Target cannot be empty",
    "technical_analysis": "Technical analysis cannot be empty",
    "poc_description": "PoC description cannot be empty",
    "poc_script_code": "PoC script/code is REQUIRED - provide the actual exploit/payload",
    "remediation_steps": "Remediation steps cannot be empty",
}


async def run_embedded_scan(ws: Any, task: dict[str, Any], config: Any) -> None:
    """Run Strix in-process and bridge its native events to the platform protocol."""
    from strix.core.runner import run_strix_scan

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
    bridge = StrixPlatformBridge(ws, task)
    coordinator = AgentCoordinator()
    run_name = ""
    report_state: ReportState | None = None
    pump_task = asyncio.create_task(bridge.pump())

    try:
        async with working_directory(config.strix_project_dir):
            from strix.interface.utils import (
                clone_repository,
                collect_local_sources,
                generate_run_name,
            )

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
            report_state.set_scan_config(scan_config)
            report_state.save_run_data()
            report_state.vulnerability_found_callback = bridge.vulnerability_found
            set_global_report_state(report_state)

            image = load_settings().runtime.image
            if not image:
                raise RuntimeError("STRIX_IMAGE is not configured")

            await send(ws, status(task, "running", "strix_scan", f"Starting embedded Strix {task['scan_mode']} scan against {target}"))
            await ensure_sandbox_image(ws, task, image, int(config.heartbeat_seconds))
            await run_strix_scan(
                scan_config=scan_config,
                scan_id=run_name,
                image=image,
                local_sources=local_sources,
                coordinator=coordinator,
                interactive=False,
                cleanup_on_exit=True,
                event_sink=bridge.sdk_event,
            )

            await bridge.flush()
            await emit_final_artifacts(ws, task, run_name, report_state)
            finding_count = len(report_state.vulnerability_reports)
            run_dir = str(report_state.get_run_dir())
            await send(ws, status(task, "completed", "strix_scan", f"Embedded Strix imported {finding_count} finding(s)."))
            await send(ws, {
                "type": "task_complete",
                "conversation_id": task["conversation_id"],
                "task_id": task["task_id"],
                "status": "completed",
                "summary": f"Node3 embedded Strix scan completed in {format_duration(time.monotonic() - started_at)}. Run: {run_name}. Findings: {finding_count}.",
            })
            await send(ws, checkpoint(task, run_name, run_dir))
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
            "message": "Node3 embedded Strix scan was interrupted.",
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
        await bridge.close()
        await pump_task


def _validate_file_path(path: str) -> str | None:
    if not path or not path.strip():
        return "file path cannot be empty"
    p = PurePosixPath(path)
    if p.is_absolute():
        return f"file path must be relative, got absolute: '{path}'"
    if ".." in p.parts:
        return f"file path must not contain '..': '{path}'"
    return None


def _normalize_code_locations(raw: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    if not raw:
        return None
    cleaned: list[dict[str, Any]] = []
    for loc in raw:
        normalized: dict[str, Any] = {}
        for field in _CODE_LOCATION_FIELDS:
            if field not in loc or loc[field] is None:
                continue
            value = loc[field]
            if field in ("start_line", "end_line"):
                try:
                    normalized[field] = int(value)
                except (TypeError, ValueError):
                    continue
            else:
                text = (
                    str(value).strip("\n")
                    if field in ("snippet", "fix_before", "fix_after")
                    else str(value).strip()
                )
                if text:
                    normalized[field] = text
        if normalized.get("file") and normalized.get("start_line") is not None:
            cleaned.append(normalized)
    return cleaned or None


def _validate_code_locations(locations: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    for i, loc in enumerate(locations):
        path_err = _validate_file_path(loc.get("file", ""))
        if path_err:
            errors.append(f"code_locations[{i}]: {path_err}")
        start = loc.get("start_line")
        if not isinstance(start, int) or start < 1:
            errors.append(f"code_locations[{i}]: start_line must be a positive integer")
        end = loc.get("end_line")
        if end is None:
            errors.append(f"code_locations[{i}]: end_line is required")
        elif not isinstance(end, int) or end < 1:
            errors.append(f"code_locations[{i}]: end_line must be a positive integer")
        elif isinstance(start, int) and end < start:
            errors.append(f"code_locations[{i}]: end_line ({end}) must be >= start_line ({start})")
    return errors


def _extract_cve(cve: str) -> str:
    match = re.search(r"CVE-\d{4}-\d{4,}", cve)
    return match.group(0) if match else cve.strip()


def _validate_cve(cve: str) -> str | None:
    if not re.match(r"^CVE-\d{4}-\d{4,}$", cve):
        return f"invalid CVE format: '{cve}' (expected 'CVE-YYYY-NNNNN')"
    return None


def _extract_cwe(cwe: str) -> str:
    match = re.search(r"CWE-\d+", cwe)
    return match.group(0) if match else cwe.strip()


def _validate_cwe(cwe: str) -> str | None:
    if not re.match(r"^CWE-\d+$", cwe):
        return f"invalid CWE format: '{cwe}' (expected 'CWE-NNN')"
    return None


def _calculate_cvss(breakdown: dict[str, str]) -> tuple[float, str, str]:
    try:
        from cvss import CVSS3

        vector = (
            f"CVSS:3.1/AV:{breakdown['attack_vector']}/AC:{breakdown['attack_complexity']}/"
            f"PR:{breakdown['privileges_required']}/UI:{breakdown['user_interaction']}/"
            f"S:{breakdown['scope']}/C:{breakdown['confidentiality']}/"
            f"I:{breakdown['integrity']}/A:{breakdown['availability']}"
        )
        c = CVSS3(vector)
        score = c.scores()[0]
        severity = c.severities()[0].lower()
    except Exception:
        logger.exception("Failed to calculate CVSS")
        return 7.5, "high", ""
    return score, severity, vector


async def _do_create_vulnerability_report(
    *,
    title: str,
    description: str,
    impact: str,
    target: str,
    technical_analysis: str,
    poc_description: str,
    poc_script_code: str,
    remediation_steps: str,
    cvss_breakdown: dict[str, str],
    endpoint: str | None,
    method: str | None,
    cve: str | None,
    cwe: str | None,
    code_locations: list[dict[str, Any]] | None,
    agent_id: str | None = None,
    agent_name: str | None = None,
) -> dict[str, Any]:
    errors: list[str] = []
    fields = {
        "title": title,
        "description": description,
        "impact": impact,
        "target": target,
        "technical_analysis": technical_analysis,
        "poc_description": poc_description,
        "poc_script_code": poc_script_code,
        "remediation_steps": remediation_steps,
    }
    for name, msg in _REQUIRED_REPORT_FIELDS.items():
        if not str(fields.get(name) or "").strip():
            errors.append(msg)

    if not isinstance(cvss_breakdown, dict) or not cvss_breakdown:
        errors.append("cvss_breakdown: must be an object with the 8 CVSS metrics")
        cvss_breakdown = {}
    else:
        for name, valid in _CVSS_VALID.items():
            value = cvss_breakdown.get(name)
            if value not in valid:
                errors.append(f"Invalid {name}: {value}. Must be one of: {valid}")

    parsed_locations = _normalize_code_locations(code_locations)
    if parsed_locations:
        errors.extend(_validate_code_locations(parsed_locations))
    if cve:
        cve = _extract_cve(cve)
        cve_err = _validate_cve(cve)
        if cve_err:
            errors.append(cve_err)
    if cwe:
        cwe = _extract_cwe(cwe)
        cwe_err = _validate_cwe(cwe)
        if cwe_err:
            errors.append(cwe_err)

    if errors:
        return {"success": False, "error": "Validation failed", "errors": errors}

    cvss_score, severity, _vector = _calculate_cvss(cvss_breakdown)
    report_state = ReportStateShim.current_report_state()
    if report_state is None:
        logger.warning("No global report state; vulnerability report not persisted")
        return {
            "success": True,
            "message": f"Vulnerability report '{title}' created (not persisted)",
            "warning": "Report could not be persisted - report state unavailable",
        }

    try:
        from strix.report.dedupe import check_duplicate

        existing = report_state.get_existing_vulnerabilities()
        candidate = {
            "title": title,
            "description": description,
            "impact": impact,
            "target": target,
            "technical_analysis": technical_analysis,
            "poc_description": poc_description,
            "poc_script_code": poc_script_code,
            "endpoint": endpoint,
            "method": method,
        }
        dedupe = await check_duplicate(candidate, existing)
        if dedupe.get("is_duplicate"):
            duplicate_id = dedupe.get("duplicate_id", "")
            duplicate_title = next(
                (r.get("title", "Unknown") for r in existing if r.get("id") == duplicate_id),
                "",
            )
            return {
                "success": False,
                "error": (
                    f"Potential duplicate of '{duplicate_title}' "
                    f"(id={duplicate_id[:8]}...) - do not re-report the same vulnerability"
                ),
                "duplicate_of": duplicate_id,
                "duplicate_title": duplicate_title,
                "confidence": dedupe.get("confidence", 0.0),
                "reason": dedupe.get("reason", ""),
            }

        report_id = report_state.add_vulnerability_report(
            title=title,
            description=description,
            severity=severity,
            impact=impact,
            target=target,
            technical_analysis=technical_analysis,
            poc_description=poc_description,
            poc_script_code=poc_script_code,
            remediation_steps=remediation_steps,
            cvss=cvss_score,
            cvss_breakdown=cvss_breakdown,
            endpoint=endpoint,
            method=method,
            cve=cve,
            cwe=cwe,
            code_locations=parsed_locations,
            agent_id=agent_id if isinstance(agent_id, str) else None,
            agent_name=agent_name if isinstance(agent_name, str) else None,
        )
    except (ImportError, AttributeError) as exc:
        logger.exception("create_vulnerability_report persistence failed")
        return {"success": False, "error": f"Failed to create vulnerability report: {exc!s}"}

    logger.info(
        "Vulnerability report created: id=%s severity=%s cvss=%.1f title=%s",
        report_id,
        severity,
        cvss_score,
        title,
    )
    return {
        "success": True,
        "message": f"Vulnerability report '{title}' created successfully",
        "report_id": report_id,
        "severity": severity,
        "cvss_score": cvss_score,
    }


class StrixPlatformBridge:
    def __init__(self, ws: Any, task: dict[str, Any]) -> None:
        self.ws = ws
        self.task = task
        self.queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self.sent_vulnerability_ids: set[str] = set()
        self.tool_names_by_call_id: dict[str, str] = {}
        self.forward_raw_messages = truthy(os.getenv("NODE3_FORWARD_STRIX_MESSAGES"))
        self._closed = False

    async def pump(self) -> None:
        while True:
            message = await self.queue.get()
            if message is None:
                return
            await send(self.ws, message)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self.queue.put(None)

    async def flush(self) -> None:
        while not self.queue.empty():
            await asyncio.sleep(0)

    def emit(self, message: dict[str, Any]) -> None:
        if not self._closed:
            self.queue.put_nowait(message)

    def sdk_event(self, agent_id: str, event: Any) -> None:
        event_type = getattr(event, "type", "")
        if event_type != "run_item_stream_event":
            return

        item = getattr(event, "item", None)
        item_type = getattr(item, "type", "")
        if item_type == "message_output_item":
            content = sdk_message_text(item).strip()
            if content and self.forward_raw_messages:
                self.emit(text(self.task, content, metadata={"agent_id": agent_id}))
            return
        if item_type == "tool_call_item":
            call = sdk_tool_call_data(item)
            call_id = call["call_id"]
            self.tool_names_by_call_id[call_id] = call["tool_name"]
            self.emit(tool_output(
                self.task,
                tool_name=call["tool_name"],
                tool_run_id=call_id,
                status_value="running",
                line=tool_call_summary(call["tool_name"], call["args"]),
                metadata={"agent_id": agent_id, "args": call["args"]},
            ))
            return
        if item_type == "tool_call_output_item":
            output = sdk_tool_output_data(item)
            call_id = output["call_id"]
            tool_name = self.tool_names_by_call_id.get(call_id) or output["tool_name"]
            parsed_output = parse_json_value(output["output"])
            status_value = "failed" if isinstance(parsed_output, dict) and parsed_output.get("success") is False else "done"
            self.emit(tool_output(
                self.task,
                tool_name=tool_name,
                tool_run_id=call_id,
                status_value=status_value,
                line=tool_result_summary(tool_name, parsed_output),
                metadata={"agent_id": agent_id, "result": parsed_output},
            ))

    def vulnerability_found(self, report: dict[str, Any]) -> None:
        vuln_id = str(report.get("id") or "")
        if vuln_id and vuln_id in self.sent_vulnerability_ids:
            return
        if vuln_id:
            self.sent_vulnerability_ids.add(vuln_id)
        evidence_id = f"strix-{safe_id(self.task.get('task_id', 'task'))}-{safe_id(vuln_id or report.get('title') or 'finding')}"
        target = str(report.get("target") or extract_target(self.task) or "unknown")
        self.emit({
            "type": "evidence_created",
            "conversation_id": self.task["conversation_id"],
            "task_id": self.task["task_id"],
            "evidence_id": evidence_id,
            "evidence_type": "strix_vulnerability_report",
            "source_tool": "strix",
            "content": json.dumps(report, ensure_ascii=False, indent=2),
            "metadata": {"strix_vulnerability": report},
        })
        self.emit({
            "type": "vuln_found",
            "conversation_id": self.task["conversation_id"],
            "task_id": self.task["task_id"],
            "vulnerability_id": evidence_id,
            "title": str(report.get("title") or "Strix vulnerability"),
            "severity": normalize_severity(report.get("severity")),
            "status": "confirmed",
            "target": target,
            "url": target,
            "location": str(report.get("endpoint") or target),
            "affected_asset": target,
            "description": first_text(report, "description", "technical_analysis", "impact", "poc_description"),
            "impact": str(report.get("impact") or ""),
            "remediation": first_text(report, "remediation", "remediation_steps"),
            "evidence_ids": [evidence_id],
            "cvss": report.get("cvss"),
            "cve_id": report.get("cve"),
        })


def build_targets_info(target: str) -> list[dict[str, Any]]:
    from strix.interface.utils import (
        assign_workspace_subdirs,
        infer_target_type,
        rewrite_localhost_targets,
    )

    target_type, target_details = infer_target_type(target)
    display_target = target_details.get("target_path", target) if target_type == "local_code" else target
    targets_info = [{"type": target_type, "details": target_details, "original": display_target}]
    assign_workspace_subdirs(targets_info)
    rewrite_localhost_targets(targets_info, HOST_GATEWAY_HOSTNAME)
    return targets_info


def install_reporting_tool_shim() -> None:
    """Provide Strix's reporting tool when the vendored source file is missing.

    Node3 carries its own Strix source tree, so the real tool should normally
    import. This shim remains as a last-resort fallback for broken local copies.
    """
    if "strix.tools.reporting.tool" in sys.modules:
        return
    try:
        __import__("strix.tools.reporting.tool", fromlist=["create_vulnerability_report"])
    except ModuleNotFoundError as exc:
        if exc.name != "strix.tools.reporting.tool":
            raise
    else:
        return

    module = types.ModuleType("strix.tools.reporting.tool")
    module.create_vulnerability_report = make_create_vulnerability_report_tool()
    sys.modules["strix.tools.reporting.tool"] = module


def make_create_vulnerability_report_tool() -> Any:
    from agents import function_tool

    @function_tool(timeout=180, strict_mode=False)
    async def create_vulnerability_report(
        ctx: RunContextWrapper,
        title: str,
        description: str,
        impact: str,
        target: str,
        technical_analysis: str,
        poc_description: str,
        poc_script_code: str,
        remediation_steps: str,
        cvss_breakdown: dict[str, str],
        endpoint: str | None = None,
        method: str | None = None,
        cve: str | None = None,
        cwe: str | None = None,
        code_locations: list[dict[str, Any]] | None = None,
    ) -> str:
        inner = ctx.context if isinstance(ctx.context, dict) else {}
        agent_id = inner.get("agent_id") if isinstance(inner.get("agent_id"), str) else None
        agent_name = None
        coordinator = inner.get("coordinator")
        if agent_id is not None and coordinator is not None:
            names = getattr(coordinator, "names", {})
            if isinstance(names, dict) and isinstance(names.get(agent_id), str):
                agent_name = names[agent_id]

        result = await _do_create_vulnerability_report(
            title=title,
            description=description,
            impact=impact,
            target=target,
            technical_analysis=technical_analysis,
            poc_description=poc_description,
            poc_script_code=poc_script_code,
            remediation_steps=remediation_steps,
            cvss_breakdown=cvss_breakdown,
            endpoint=endpoint,
            method=method,
            cve=cve,
            cwe=cwe,
            code_locations=code_locations,
            agent_id=agent_id,
            agent_name=agent_name,
        )
        return json.dumps(result, ensure_ascii=False, default=str)

    return create_vulnerability_report


class ReportStateShim:
    @staticmethod
    def current_report_state() -> ReportState | None:
        from strix.report.state import get_global_report_state

        return get_global_report_state()


async def emit_final_artifacts(ws: Any, task: dict[str, Any], run_name: str, report_state: ReportState) -> None:
    run_dir = report_state.get_run_dir()
    report_path = run_dir / "penetration_test_report.md"
    content = ""
    if report_path.exists():
        content = report_path.read_text(encoding="utf-8", errors="replace")
    elif report_state.final_scan_result:
        content = report_state.final_scan_result
    if content:
        await send(ws, {
            "type": "evidence_created",
            "conversation_id": task["conversation_id"],
            "task_id": task["task_id"],
            "evidence_id": f"strix-{safe_id(run_name)}-report",
            "evidence_type": "strix_report",
            "source_tool": "strix",
            "content": content,
            "metadata": {"run_name": run_name, "run_dir": str(run_dir)},
        })


async def ensure_sandbox_image(ws: Any, task: dict[str, Any], image: str, heartbeat_seconds: int) -> None:
    if await docker_image_exists(image):
        await send(ws, status(task, "running", "sandbox_image", f"Strix sandbox image is ready: {image}"))
        return
    await send(ws, status(task, "running", "sandbox_image", f"Pulling Strix sandbox image: {image}"))
    process = await asyncio.create_subprocess_exec(
        "docker",
        "pull",
        image,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    started_at = time.monotonic()
    next_heartbeat_at = started_at + heartbeat_seconds
    last_progress = ""
    assert process.stdout is not None
    while True:
        try:
            raw_line = await asyncio.wait_for(process.stdout.readline(), timeout=2.0)
        except TimeoutError:
            raw_line = None
        if raw_line:
            last_progress = raw_line.decode("utf-8", errors="replace").strip()
            if should_forward_docker_pull_line(last_progress):
                await send(ws, text(task, f"[sandbox image] {last_progress}"))
        elif raw_line == b"":
            break
        now = time.monotonic()
        if process.returncode is None and now >= next_heartbeat_at:
            summary = f"Still pulling Strix sandbox image after {format_duration(now - started_at)}"
            if last_progress:
                summary += f". Last progress: {last_progress}"
            await send(ws, status(task, "running", "sandbox_image", summary))
            next_heartbeat_at = now + heartbeat_seconds
        if raw_line is None and process.returncode is None:
            await asyncio.sleep(0)
    exit_code = await process.wait()
    if exit_code != 0:
        raise RuntimeError(f"docker pull {image} failed with code {exit_code}. Last output: {last_progress}")
    await send(ws, status(task, "running", "sandbox_image", f"Strix sandbox image pulled: {image}"))


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


def extract_target(task: dict[str, Any]) -> str | None:
    target = task.get("target") if isinstance(task.get("target"), dict) else {}
    for key in ("value", "url", "address", "original"):
        value = string_value(target.get(key))
        if value:
            return value
    scope = task.get("scope") if isinstance(task.get("scope"), dict) else {}
    allow = scope.get("allow")
    if isinstance(allow, list):
        for item in allow:
            value = string_value(item)
            if value:
                return value
    snapshot = task.get("snapshot") if isinstance(task.get("snapshot"), dict) else {}
    checkpoint = snapshot.get("checkpoint") if isinstance(snapshot.get("checkpoint"), dict) else {}
    checkpoint_task = checkpoint.get("task") if isinstance(checkpoint.get("task"), dict) else {}
    checkpoint_target = checkpoint_task.get("target") if isinstance(checkpoint_task.get("target"), dict) else checkpoint.get("target")
    if isinstance(checkpoint_target, dict):
        value = string_value(checkpoint_target.get("value"))
        if value:
            return value
    for source in (checkpoint_task, checkpoint):
        if isinstance(source, dict):
            value = string_value(source.get("target_url") or source.get("target"))
            if value:
                return value
    match = re.search(r"https?://[^\s,;)\]}>'\"]+", str(task.get("instruction") or ""), re.IGNORECASE)
    return match.group(0).rstrip(".)]}") if match else None


def build_instruction(task: dict[str, Any]) -> str:
    pieces = [
        str(task.get("instruction") or "").strip(),
        "Run in benchmark-friendly mode: prioritize confirmed, reproducible web vulnerabilities; include endpoint, method, parameter, proof of concept, impact, and remediation for each finding.",
        "Avoid reporting negative or speculative findings as vulnerabilities.",
    ]
    return "\n\n".join(piece for piece in pieces if piece)


def status(task: dict[str, Any], state: str, stage: str, summary: str) -> dict[str, Any]:
    return {
        "type": "status_update",
        "conversation_id": task["conversation_id"],
        "task_id": task["task_id"],
        "status": state,
        "workflow_stage": stage,
        "phase": stage,
        "active_tool": "strix",
        "summary": summary,
        "message": summary,
    }


def text(task: dict[str, Any], value: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    content: dict[str, Any] = {"text": value}
    if metadata:
        content["metadata"] = metadata
    return {
        "type": "text",
        "conversation_id": task["conversation_id"],
        "task_id": task["task_id"],
        "content": content,
    }


def tool_output(
    task: dict[str, Any],
    *,
    tool_name: str,
    tool_run_id: str,
    status_value: str,
    line: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "type": "tool_output",
        "conversation_id": task["conversation_id"],
        "task_id": task["task_id"],
        "tool_name": tool_name,
        "tool_run_id": tool_run_id,
        "status": status_value,
        "line": line,
        "stdout": line if status_value != "running" else "",
        "metadata": metadata or {},
    }


def checkpoint(task: dict[str, Any], run_name: str, run_dir: str) -> dict[str, Any]:
    return {
        "type": "checkpoint_update",
        "conversation_id": task["conversation_id"],
        "task_id": task["task_id"],
        "checkpoint": {"node3_strix": {"run_name": run_name, "run_dir": run_dir}},
    }


async def send(ws: Any, message: dict[str, Any]) -> None:
    await ws.send(json.dumps(message, ensure_ascii=False))


def sdk_tool_call_data(item: Any) -> dict[str, Any]:
    raw = getattr(item, "raw_item", None)
    call_id = str(raw_field(raw, "call_id") or raw_field(raw, "id") or id(item))
    tool_name = str(raw_field(raw, "name") or raw_field(raw, "type") or getattr(item, "title", None) or "tool")
    return {"call_id": call_id, "tool_name": tool_name, "args": parse_json_object(raw_field(raw, "arguments"))}


def sdk_tool_output_data(item: Any) -> dict[str, Any]:
    raw = getattr(item, "raw_item", None)
    call_id = str(raw_field(raw, "call_id") or raw_field(raw, "id") or id(item))
    return {
        "call_id": call_id,
        "tool_name": str(raw_field(raw, "name") or raw_field(raw, "type") or "tool"),
        "output": getattr(item, "output", raw_field(raw, "output")),
    }


def sdk_message_text(item: Any) -> str:
    raw = getattr(item, "raw_item", None)
    return message_content_text(raw_field(raw, "content", []))


def message_content_text(content: Any) -> str:
    parts: list[str] = []
    content_items = content if isinstance(content, list) else [content]
    for part in content_items:
        if isinstance(part, str):
            parts.append(part)
            continue
        text_value = raw_field(part, "text")
        if isinstance(text_value, str):
            parts.append(text_value)
    return "".join(parts)


def raw_field(raw: Any, key: str, default: Any = None) -> Any:
    if isinstance(raw, dict):
        return raw.get(key, default)
    return getattr(raw, key, default)


def parse_json_object(value: Any) -> dict[str, Any]:
    parsed = parse_json_value(value)
    return parsed if isinstance(parsed, dict) else {}


def parse_json_value(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def short_json(value: Any) -> str:
    if not value:
        return ""
    return short_value(value)


def short_value(value: Any) -> str:
    if isinstance(value, str):
        text_value = value
    else:
        text_value = json.dumps(value, ensure_ascii=False, default=str)
    return text_value[:MAX_TOOL_OUTPUT_CHARS]


def tool_call_summary(tool_name: str, args: dict[str, Any]) -> str:
    name = friendly_tool_name(tool_name)
    if tool_name in {"list_requests", "list_sitemap", "scope_rules", "view_agent_graph", "list_todos", "list_notes"}:
        return f"{name} started"
    target = first_present(args, "url", "target", "endpoint", "path", "query", "command", "task", "message")
    if target:
        return f"{name}: {target}"
    return f"{name} started"


def tool_result_summary(tool_name: str, result: Any) -> str:
    name = friendly_tool_name(tool_name)
    if isinstance(result, dict):
        if result.get("success") is False:
            return f"{name} failed: {first_present(result, 'error', 'message', 'reason') or 'see details'}"
        if tool_name == "create_vulnerability_report":
            title = first_present(result, "message", "report_id")
            return f"Finding reported: {title}" if title else "Finding reported"
        if tool_name == "finish_scan":
            return "Final report generated"
        if tool_name == "create_agent":
            return f"Sub-agent created: {first_present(result, 'agent_id', 'name') or 'agent'}"
        if tool_name == "send_message_to_agent":
            return "Message sent to sub-agent"
        if tool_name == "wait_for_message":
            return first_present(result, "message", "wait_outcome") or "Sub-agent response received"
        summary = first_present(result, "message", "summary", "status", "title")
        if summary:
            return f"{name}: {summary}"
    if isinstance(result, str) and result.strip():
        parsed = parse_json_value(result)
        if parsed is not result:
            return tool_result_summary(tool_name, parsed)
        return f"{name}: {result.strip()[:240]}"
    return f"{name} completed"


def friendly_tool_name(tool_name: str) -> str:
    return {
        "think": "Planning",
        "load_skill": "Loading skill",
        "web_search": "Web search",
        "list_requests": "Reviewing traffic",
        "view_request": "Inspecting request",
        "repeat_request": "Repeating request",
        "list_sitemap": "Reviewing sitemap",
        "view_sitemap_entry": "Inspecting sitemap entry",
        "scope_rules": "Checking scope",
        "create_vulnerability_report": "Reporting finding",
        "finish_scan": "Finishing scan",
        "create_agent": "Creating sub-agent",
        "send_message_to_agent": "Messaging sub-agent",
        "wait_for_message": "Waiting for sub-agent",
        "view_agent_graph": "Reviewing agent graph",
        "create_todo": "Updating plan",
        "update_todo": "Updating plan",
        "mark_todo_done": "Updating plan",
        "list_todos": "Reviewing plan",
        "create_note": "Writing note",
        "update_note": "Updating note",
        "list_notes": "Reviewing notes",
    }.get(tool_name, tool_name.replace("_", " ").strip().title() or "Tool")


def first_present(mapping: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = mapping.get(key)
        if value is None:
            continue
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False, default=str)
        text_value = str(value).strip()
        if text_value:
            return text_value[:240]
    return ""


def normalize_severity(value: Any) -> str:
    normalized = str(value or "medium").strip().lower()
    return normalized if normalized in {"critical", "high", "medium", "low", "info"} else "medium"


def first_text(mapping: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, list):
            value = "\n".join(str(item) for item in value)
        if value:
            return str(value)
    return ""


def string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def safe_id(value: Any) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(value)).strip("-")[:80] or "item"


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


def truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def format_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes = int(seconds // 60)
    rest = int(seconds % 60)
    return f"{minutes}m {rest}s"
