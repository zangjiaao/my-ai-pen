from __future__ import annotations

import asyncio
import json
import os
import queue
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

import websockets
from agents.model_settings import ModelSettings
from agents.models.interface import ModelTracing
from openai.types.responses import ResponseOutputMessage

from strix.config import load_settings
from strix.config.models import DEFAULT_MODEL_RETRY, StrixProvider, configure_sdk_model_defaults


ROOT = Path(__file__).resolve().parent
DEFAULT_STRIX_PROJECT = (ROOT.parent / "research" / "strix").resolve()

TARGET_RE = re.compile(r"https?://[^\s,;)\]}>'\"]+", re.IGNORECASE)
MAX_CHAT_TURNS = 12


class Node3Config:
    def __init__(self) -> None:
        load_dotenv(ROOT / ".env")
        self.node_name = os.getenv("NODE_NAME", "pentest-strix-01")
        self.node_token = os.getenv("NODE_TOKEN", "")
        self.platform_ws_url = os.getenv("PLATFORM_WS_URL", "ws://localhost:8000/ws")
        self.strix_project_dir = resolve_config_path(os.getenv("STRIX_PROJECT_DIR"), DEFAULT_STRIX_PROJECT)
        self.scan_mode = normalize_scan_mode(os.getenv("STRIX_SCAN_MODE", "quick"))
        self.extra_args = split_args(os.getenv("STRIX_EXTRA_ARGS", ""))
        self.max_output_chars = positive_int(os.getenv("NODE3_MAX_OUTPUT_CHARS"), 120_000)
        self.chat_timeout = positive_int(os.getenv("NODE3_CHAT_TIMEOUT_SECONDS"), 60)
        self.heartbeat_seconds = positive_int(os.getenv("NODE3_HEARTBEAT_SECONDS"), 20)


class Node3Runtime:
    def __init__(self, config: Node3Config) -> None:
        self.config = config
        self.current_process: subprocess.Popen[str] | None = None
        self.current_task: asyncio.Task[None] | None = None
        self.chat_history: dict[str, deque[tuple[str, str]]] = defaultdict(lambda: deque(maxlen=MAX_CHAT_TURNS))
        self.stop_event = asyncio.Event()

    async def run(self) -> None:
        if not self.config.node_token:
            print("[node3] NODE_TOKEN is empty; platform websocket authentication will fail.", flush=True)
        print(f"[node3] {self.config.node_name} starting. Platform: {self.config.platform_ws_url}", flush=True)
        print(f"[node3] Strix project: {self.config.strix_project_dir}", flush=True)
        while not self.stop_event.is_set():
            try:
                ws_url = f"{self.config.platform_ws_url}?token={self.config.node_token}"
                async with websockets.connect(ws_url) as ws:
                    print(f"[node3] websocket connected: {self.config.platform_ws_url}", flush=True)
                    async for raw in ws:
                        await self.handle_message(ws, json.loads(raw))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"[node3] websocket error: {exc}", flush=True)
                await asyncio.sleep(3)

    async def handle_message(self, ws: Any, message: dict[str, Any]) -> None:
        msg_type = str(message.get("type") or "")
        if msg_type == "task_assign":
            task = normalize_task(message, self.config)
            await self.start_scan(ws, task)
        elif msg_type == "user_steer":
            task = normalize_task(message, self.config)
            if extract_target(task):
                await self.start_scan(ws, task)
            else:
                await self.answer_chat(ws, task)
        elif msg_type == "user_interrupt":
            if self.current_process and self.current_process.poll() is None:
                self.current_process.terminate()
            await send(ws, {
                "type": "text",
                "conversation_id": str(message.get("conversation_id") or ""),
                "content": {"text": "Node3 received interrupt; stopping current scan."},
            })
        elif msg_type == "user_input":
            await send(ws, {
                "type": "text",
                "conversation_id": str(message.get("conversation_id") or ""),
                "content": {"text": "Node3 runs Strix in non-interactive mode and does not handle approval prompts yet."},
            })

    async def start_scan(self, ws: Any, task: dict[str, Any]) -> None:
        if self.current_task and not self.current_task.done():
            await send(ws, {
                "type": "task_error",
                "conversation_id": task["conversation_id"],
                "task_id": task["task_id"],
                "message": "Node3 Strix adapter is busy",
            })
            return
        self.current_task = asyncio.create_task(self.run_scan(ws, task))

    async def run_scan(self, ws: Any, task: dict[str, Any]) -> None:
        target = extract_target(task)
        if not target:
            await send(ws, {
                "type": "task_error",
                "conversation_id": task["conversation_id"],
                "task_id": task["task_id"],
                "message": "Node3 requires a target URL, host, repository, or local path.",
            })
            return

        before_runs = snapshot_run_dirs(self.config.strix_project_dir)
        started_at = time.monotonic()
        command = [
            sys.executable,
            "-m",
            "strix.interface.main",
            "-n",
            "--target",
            target,
            "--scan-mode",
            task["scan_mode"],
            "--instruction",
            build_instruction(task),
            *self.config.extra_args,
        ]
        await send(ws, status(task, "running", "strix_scan", f"Starting Strix {task['scan_mode']} scan against {target}"))
        await send(ws, text(task, f"Node3 Python Strix adapter starting: {redact_command(command)}"))

        output = ""
        try:
            await ensure_sandbox_image(ws, task, self.config.heartbeat_seconds)
            self.current_process = subprocess.Popen(
                command,
                cwd=str(self.config.strix_project_dir),
                env=os.environ.copy(),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            assert self.current_process.stdout is not None
            output_queue: queue.Queue[Any] = queue.Queue()
            reader_done = object()
            threading.Thread(
                target=read_process_output,
                args=(self.current_process.stdout, output_queue, reader_done),
                daemon=True,
            ).start()
            last_output_at = time.monotonic()
            next_heartbeat_at = last_output_at + self.config.heartbeat_seconds
            while True:
                item = await asyncio.to_thread(queue_get, output_queue, 2.0)
                if item is reader_done:
                    if self.current_process.poll() is not None:
                        break
                    continue
                if isinstance(item, Exception):
                    raise item
                if isinstance(item, str) and item:
                    last_output_at = time.monotonic()
                    output = append_output(output, item, self.config.max_output_chars)
                    await send(ws, text(task, item.rstrip()))
                    continue
                now = time.monotonic()
                if self.current_process.poll() is not None:
                    break
                if now >= next_heartbeat_at:
                    await send(ws, status(
                        task,
                        "running",
                        "strix_scan",
                        f"Strix is still running. Elapsed: {format_duration(now - started_at)}. Last output: {format_duration(now - last_output_at)} ago.",
                    ))
                    next_heartbeat_at = now + self.config.heartbeat_seconds
            exit_code = self.current_process.wait()
            artifacts = load_latest_artifacts(self.config.strix_project_dir, before_runs)
            await import_artifacts(ws, task, artifacts, output)
            if exit_code not in (0, 2):
                raise RuntimeError(f"Strix exited with code {exit_code}.")
            finding_count = len(artifacts.get("vulnerabilities") or []) if artifacts else 0
            run_name = artifacts.get("run_name") if artifacts else "unknown"
            await send(ws, status(task, "completed", "artifact_import", f"Imported {finding_count} Strix finding(s)."))
            await send(ws, {
                "type": "task_complete",
                "conversation_id": task["conversation_id"],
                "task_id": task["task_id"],
                "status": "completed",
                "summary": f"Node3 Strix scan completed in {format_duration(time.monotonic() - started_at)}. Run: {run_name}. Findings: {finding_count}.",
            })
        except Exception as exc:
            await send(ws, {
                "type": "task_error",
                "conversation_id": task["conversation_id"],
                "task_id": task["task_id"],
                "message": str(exc),
            })
        finally:
            self.current_process = None
            self.current_task = None

    async def answer_chat(self, ws: Any, task: dict[str, Any]) -> None:
        conv_id = task["conversation_id"]
        user_text = str(task.get("instruction") or "").strip()
        self.chat_history[conv_id].append(("user", user_text))
        try:
            answer = await asyncio.wait_for(self.call_strix_model(conv_id), timeout=self.config.chat_timeout)
            self.chat_history[conv_id].append(("assistant", answer))
            await send(ws, {
                "type": "text",
                "conversation_id": conv_id,
                "task_id": task["task_id"],
                "content": {"text": answer or "Node3 model returned an empty response."},
            })
        except Exception as exc:
            await send(ws, {
                "type": "task_error",
                "conversation_id": conv_id,
                "task_id": task["task_id"],
                "message": f"Node3 model chat failed: {exc}",
            })

    async def call_strix_model(self, conv_id: str) -> str:
        settings = load_settings()
        model_name = (settings.llm.model or "").strip()
        if not model_name:
            raise RuntimeError("STRIX_LLM is not configured")
        configure_sdk_model_defaults(settings)
        model = StrixProvider().get_model(model_name)
        transcript = "\n".join(f"{role}: {content}" for role, content in self.chat_history[conv_id])
        system = (
            "You are Node3, a Strix-based penetration testing agent connected to a security testing platform. "
            "Answer normal conversation directly and concisely. "
            "For security testing requests, ask for an authorized target URL/IP and scope if missing. "
            "Do not claim that a scan has started unless a target was provided."
        )
        response = await model.get_response(
            system_instructions=system,
            input=transcript,
            model_settings=ModelSettings(retry=DEFAULT_MODEL_RETRY, include_usage=True),
            tools=[],
            output_schema=None,
            handoffs=[],
            tracing=ModelTracing.DISABLED,
            previous_response_id=None,
            conversation_id=conv_id,
            prompt=None,
        )
        return extract_response_text(response)


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def normalize_task(message: dict[str, Any], config: Node3Config) -> dict[str, Any]:
    task_id = str(message.get("task_id") or uuid.uuid4())
    conversation_id = str(message.get("conversation_id") or task_id)
    return {
        "task_id": task_id,
        "conversation_id": conversation_id,
        "instruction": str(message.get("initial_instruction") or message.get("text") or ""),
        "scan_mode": normalize_scan_mode(message.get("scan_mode") or message.get("scanMode") or config.scan_mode),
        "target": message.get("target") if isinstance(message.get("target"), dict) else {},
        "scope": message.get("scope") if isinstance(message.get("scope"), dict) else {},
        "snapshot": message.get("snapshot") if isinstance(message.get("snapshot"), dict) else {},
    }


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
    match = TARGET_RE.search(str(task.get("instruction") or ""))
    return match.group(0).rstrip(".)]}") if match else None


def build_instruction(task: dict[str, Any]) -> str:
    pieces = [
        str(task.get("instruction") or "").strip(),
        "Run in benchmark-friendly mode: prioritize confirmed, reproducible web vulnerabilities; include endpoint, method, parameter, proof of concept, impact, and remediation for each finding.",
        "Avoid reporting negative or speculative findings as vulnerabilities.",
    ]
    return "\n\n".join(piece for piece in pieces if piece)


async def import_artifacts(ws: Any, task: dict[str, Any], artifacts: dict[str, Any] | None, output: str) -> None:
    if not artifacts:
        await send(ws, {
            "type": "tool_output",
            "conversation_id": task["conversation_id"],
            "task_id": task["task_id"],
            "tool_name": "strix",
            "status": "done",
            "stdout": output,
        })
        return
    run_name = str(artifacts.get("run_name") or "unknown")
    run_dir = str(artifacts.get("run_dir") or "")
    report = artifacts.get("report_markdown")
    if report:
        evidence_id = f"strix-{safe_id(run_name)}-report"
        await send(ws, {
            "type": "evidence_created",
            "conversation_id": task["conversation_id"],
            "task_id": task["task_id"],
            "evidence_id": evidence_id,
            "evidence_type": "strix_report",
            "source_tool": "strix",
            "content": report,
            "metadata": {"run_name": run_name, "run_dir": run_dir},
        })
    for index, vuln in enumerate(artifacts.get("vulnerabilities") or []):
        if not isinstance(vuln, dict):
            continue
        vuln_id = str(vuln.get("id") or f"vuln-{index + 1}")
        evidence_id = f"strix-{safe_id(run_name)}-{safe_id(vuln_id)}"
        title = str(vuln.get("title") or vuln.get("name") or "Strix vulnerability")
        severity = normalize_severity(vuln.get("severity"))
        target = str(vuln.get("target") or extract_target(task) or "unknown")
        description = first_text(vuln, "description", "technical_analysis", "impact", "poc_description")
        await send(ws, {
            "type": "evidence_created",
            "conversation_id": task["conversation_id"],
            "task_id": task["task_id"],
            "evidence_id": evidence_id,
            "evidence_type": "strix_vulnerability_report",
            "source_tool": "strix",
            "content": json.dumps(vuln, ensure_ascii=False, indent=2),
            "metadata": {"run_name": run_name, "run_dir": run_dir, "strix_vulnerability": vuln},
        })
        await send(ws, {
            "type": "vuln_found",
            "conversation_id": task["conversation_id"],
            "task_id": task["task_id"],
            "vulnerability_id": evidence_id,
            "title": title,
            "severity": severity,
            "status": "confirmed",
            "target": target,
            "url": target,
            "location": str(vuln.get("endpoint") or target),
            "affected_asset": target,
            "description": description,
            "impact": str(vuln.get("impact") or ""),
            "remediation": first_text(vuln, "remediation", "remediation_steps"),
            "evidence_ids": [evidence_id],
        })
    await send(ws, {
        "type": "checkpoint_update",
        "conversation_id": task["conversation_id"],
        "task_id": task["task_id"],
        "checkpoint": {"node3_strix": {"run_name": run_name, "run_dir": run_dir}},
    })


async def ensure_sandbox_image(ws: Any, task: dict[str, Any], heartbeat_seconds: int) -> None:
    image = load_settings().runtime.image
    if not image:
        raise RuntimeError("STRIX_IMAGE is not configured")
    if await docker_image_exists(image):
        await send(ws, status(task, "running", "sandbox_image", f"Strix sandbox image is ready: {image}"))
        return
    await send(ws, status(task, "running", "sandbox_image", f"Pulling Strix sandbox image: {image}"))
    command = ["docker", "pull", image]
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert process.stdout is not None
    output_queue: queue.Queue[Any] = queue.Queue()
    reader_done = object()
    threading.Thread(
        target=read_process_output,
        args=(process.stdout, output_queue, reader_done),
        daemon=True,
    ).start()
    started_at = time.monotonic()
    next_heartbeat_at = started_at + heartbeat_seconds
    last_progress = ""
    while True:
        item = await asyncio.to_thread(queue_get, output_queue, 2.0)
        if item is reader_done:
            if process.poll() is not None:
                break
            continue
        if isinstance(item, Exception):
            raise item
        if isinstance(item, str) and item:
            last_progress = item.strip()
            if should_forward_docker_pull_line(last_progress):
                await send(ws, text(task, f"[sandbox image] {last_progress}"))
            continue
        now = time.monotonic()
        if process.poll() is not None:
            break
        if now >= next_heartbeat_at:
            summary = f"Still pulling Strix sandbox image after {format_duration(now - started_at)}"
            if last_progress:
                summary += f". Last progress: {last_progress}"
            await send(ws, status(task, "running", "sandbox_image", summary))
            next_heartbeat_at = now + heartbeat_seconds
    exit_code = process.wait()
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


def read_process_output(stream: Any, output_queue: queue.Queue[Any], done_marker: object) -> None:
    try:
        for line in stream:
            output_queue.put(line)
    except Exception as exc:
        output_queue.put(exc)
    finally:
        output_queue.put(done_marker)


def queue_get(output_queue: queue.Queue[Any], timeout: float) -> Any:
    try:
        return output_queue.get(timeout=timeout)
    except queue.Empty:
        return None


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


def load_latest_artifacts(project_dir: Path, before_runs: set[str]) -> dict[str, Any] | None:
    runs_dir = project_dir / "strix_runs"
    if not runs_dir.exists():
        return None
    candidates = [item for item in runs_dir.iterdir() if item.is_dir() and item.name not in before_runs]
    if not candidates:
        candidates = [item for item in runs_dir.iterdir() if item.is_dir()]
    if not candidates:
        return None
    run_dir = max(candidates, key=lambda item: item.stat().st_mtime)
    vulnerabilities = read_json(run_dir / "vulnerabilities.json")
    if not isinstance(vulnerabilities, list):
        vulnerabilities = []
    report_path = run_dir / "penetration_test_report.md"
    return {
        "run_name": run_dir.name,
        "run_dir": str(run_dir),
        "vulnerabilities": vulnerabilities,
        "report_markdown": report_path.read_text(encoding="utf-8", errors="replace") if report_path.exists() else "",
    }


def snapshot_run_dirs(project_dir: Path) -> set[str]:
    runs_dir = project_dir / "strix_runs"
    if not runs_dir.exists():
        return set()
    return {item.name for item in runs_dir.iterdir() if item.is_dir()}


def extract_response_text(response: Any) -> str:
    parts: list[str] = []
    for item in response.output:
        if not isinstance(item, ResponseOutputMessage):
            continue
        for chunk in item.content:
            text_value = getattr(chunk, "text", None)
            if text_value:
                parts.append(str(text_value))
    return "".join(parts).strip()


async def send(ws: Any, message: dict[str, Any]) -> None:
    await ws.send(json.dumps(message, ensure_ascii=False))


def status(task: dict[str, Any], state: str, stage: str, summary: str) -> dict[str, Any]:
    return {
        "type": "status_update",
        "conversation_id": task["conversation_id"],
        "task_id": task["task_id"],
        "status": state,
        "workflow_stage": stage,
        "active_tool": "strix",
        "summary": summary,
    }


def text(task: dict[str, Any], value: str) -> dict[str, Any]:
    return {
        "type": "text",
        "conversation_id": task["conversation_id"],
        "task_id": task["task_id"],
        "content": {"text": value},
    }


def read_json(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None


def normalize_scan_mode(value: Any) -> str:
    normalized = str(value or "quick").strip().lower()
    return normalized if normalized in {"quick", "standard", "deep"} else "quick"


def normalize_severity(value: Any) -> str:
    normalized = str(value or "medium").strip().lower()
    return normalized if normalized in {"critical", "high", "medium", "low", "info"} else "medium"


def positive_int(value: str | None, fallback: int) -> int:
    try:
        parsed = int(value or "")
        return parsed if parsed > 0 else fallback
    except ValueError:
        return fallback


def split_args(value: str) -> list[str]:
    return shlex.split(value or "")


def resolve_config_path(value: str | None, fallback: Path) -> Path:
    if not value:
        return fallback.resolve()
    path = Path(value)
    if path.is_absolute():
        return path.resolve()
    return (ROOT / path).resolve()


def string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def first_text(mapping: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, list):
            value = "\n".join(str(item) for item in value)
        if value:
            return str(value)
    return ""


def append_output(current: str, chunk: str, limit: int) -> str:
    merged = current + chunk
    return merged[-limit:] if len(merged) > limit else merged


def safe_id(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", value).strip("-")[:80] or "item"


def redact_command(command: list[str]) -> str:
    return " ".join(command)


def format_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes = int(seconds // 60)
    rest = int(seconds % 60)
    return f"{minutes}m {rest}s"


async def main() -> None:
    runtime = Node3Runtime(Node3Config())
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, runtime.stop_event.set)
        except NotImplementedError:
            pass
    await runtime.run()


if __name__ == "__main__":
    asyncio.run(main())
