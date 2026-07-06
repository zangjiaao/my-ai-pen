from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import shlex
import signal
import sys
import uuid
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import websockets
from agents.model_settings import ModelSettings
from agents.models.interface import ModelTracing
from openai.types.responses import ResponseOutputMessage

from strix.config import load_settings
from strix.config.models import DEFAULT_MODEL_RETRY, StrixProvider, configure_sdk_model_defaults
from strix_node import run_embedded_scan


DEFAULT_STRIX_PROJECT = (ROOT / "workspace" / "strix_runtime").resolve()

TARGET_RE = re.compile(r"https?://[^\s,;)\]}>'\"]+", re.IGNORECASE)
MAX_CHAT_TURNS = 12
DEFAULT_STANDALONE_OUTPUT = ROOT / "workspace" / "standalone"


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
            if self.current_task and not self.current_task.done():
                self.current_task.cancel()
            await send(ws, {
                "type": "text",
                "conversation_id": str(message.get("conversation_id") or ""),
                "content": {"text": "Node3 received interrupt; stopping embedded Strix scan."},
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
        try:
            await run_embedded_scan(ws, task, self.config)
        except asyncio.CancelledError:
            raise
        finally:
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


def normalize_scan_mode(value: Any) -> str:
    normalized = str(value or "quick").strip().lower()
    return normalized if normalized in {"quick", "standard", "deep"} else "quick"


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


async def run_platform_main() -> None:
    runtime = Node3Runtime(Node3Config())
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, runtime.stop_event.set)
        except NotImplementedError:
            pass
    await runtime.run()


def main() -> None:
    parser = argparse.ArgumentParser(description="Node3 Strix penetration node")
    subparsers = parser.add_subparsers(dest="command")

    standalone = subparsers.add_parser("standalone", help="Run a standalone Strix session")
    standalone.add_argument("--target", default="", help="Target URL/IP/repository/local path. Required unless --resume is used.")
    standalone.add_argument("--scope", action="append", default=None, help="Authorized scope allow entry. Can be repeated.")
    standalone.add_argument("--output", default=None, help="Standalone output directory. Defaults to node3/workspace/standalone.")
    standalone.add_argument("--instruction", default="", help="Optional task instruction.")
    standalone.add_argument("--resume", default=None, help="Resume a Strix run name from the output directory.")
    standalone.add_argument("--scan-mode", default=None, choices=["quick", "standard", "deep"], help="Strix scan mode.")
    standalone.add_argument("--tui", action="store_true", help="Open the Strix Textual TUI.")
    standalone.add_argument("--no-tui", action="store_true", help="Run non-interactively and print Strix CLI output.")

    parser.add_argument("--standalone", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--target", default="", help=argparse.SUPPRESS)
    parser.add_argument("--scope", action="append", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--output", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--resume", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--tui", action="store_true", help=argparse.SUPPRESS)

    args = parser.parse_args()
    if args.command == "standalone" or args.standalone:
        run_standalone_strix(args, parser)
        return
    asyncio.run(run_platform_main())


def run_standalone_strix(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    target = str(args.target or "").strip()
    resume = str(args.resume or "").strip()
    if not target and not resume:
        parser.error("standalone requires --target or --resume")

    config = Node3Config()
    output_dir = resolve_config_path(args.output, DEFAULT_STANDALONE_OUTPUT)
    output_dir.mkdir(parents=True, exist_ok=True)
    scan_mode = normalize_scan_mode(args.scan_mode or config.scan_mode)
    cli_args: list[str] = []
    if resume:
        cli_args.extend(["--resume", resume])
    if target:
        cli_args.extend(["--target", target])
    if scan_mode:
        cli_args.extend(["--scan-mode", scan_mode])
    instruction = standalone_instruction(str(args.instruction or "").strip(), args.scope)
    if instruction:
        cli_args.extend(["--instruction", instruction])
    if args.no_tui:
        cli_args.append("-n")
    cli_args.extend(config.extra_args)

    print(f"[node3] standalone Strix source: {ROOT / 'strix'}", flush=True)
    print(f"[node3] standalone workspace: {output_dir}", flush=True)
    print(f"[node3] strix {' '.join(cli_args)}", flush=True)

    previous_argv = sys.argv[:]
    previous_cwd = Path.cwd()
    sys.argv = ["strix", *cli_args]
    os.chdir(output_dir)
    try:
        from strix.interface.main import main as strix_main

        strix_main()
    finally:
        sys.argv = previous_argv
        with contextlib.suppress(Exception):
            os.chdir(previous_cwd)


def standalone_instruction(instruction: str, scope: list[str] | None) -> str:
    entries = [str(item).strip() for item in scope or [] if str(item).strip()]
    if not entries:
        return instruction
    scope_text = "Authorized scope allow-list:\n" + "\n".join(f"- {item}" for item in entries)
    return "\n\n".join(part for part in (instruction, scope_text) if part)


if __name__ == "__main__":
    main()
