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
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import websockets

from strix.platform.node_runner import StrixPlatformConversationSession, stable_platform_run_name


DEFAULT_STRIX_PROJECT = (ROOT / "workspace" / "strix_runtime").resolve()

TARGET_RE = re.compile(r"https?://[^\s,;)\]}>'\"]+", re.IGNORECASE)
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
        self.ws: Any | None = None
        self.sessions: dict[str, StrixPlatformConversationSession] = {}
        self.stop_event = asyncio.Event()

    async def run(self) -> None:
        if not self.config.node_token:
            print("[node3] NODE_TOKEN is empty; platform websocket authentication will fail.", flush=True)
        print(f"[node3] {self.config.node_name} starting. Platform: {self.config.platform_ws_url}", flush=True)
        print(f"[node3] Strix project: {self.config.strix_project_dir}", flush=True)
        try:
            while not self.stop_event.is_set():
                try:
                    ws_url = f"{self.config.platform_ws_url}?token={self.config.node_token}"
                    async with websockets.connect(ws_url) as ws:
                        self.ws = ws
                        print(f"[node3] websocket connected: {self.config.platform_ws_url}", flush=True)
                        async for raw in ws:
                            await self.handle_message(json.loads(raw))
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    print(f"[node3] websocket error: {exc}", flush=True)
                    await asyncio.sleep(3)
                finally:
                    self.ws = None
        finally:
            await self.close_sessions()

    async def handle_message(self, message: dict[str, Any]) -> None:
        msg_type = str(message.get("type") or "")
        if msg_type == "task_assign":
            task = normalize_task(message, self.config)
            await self.start_or_update_session(task)
        elif msg_type == "user_steer":
            task = normalize_task(message, self.config)
            session = await self.start_or_update_session(task, allow_saved_session=True)
            if session is not None:
                delivered = await session.send_user_message(task)
                if not delivered:
                    await self.send({
                        "type": "task_error",
                        "conversation_id": task["conversation_id"],
                        "task_id": task["task_id"],
                        "message": "Node3 could not deliver the message to the Strix conversation.",
                    })
        elif msg_type == "user_interrupt":
            conv_id = str(message.get("conversation_id") or "")
            session = self.sessions.get(conv_id)
            if session is not None:
                await session.interrupt(str(message.get("action") or "interrupt"))
            else:
                await self.send({
                    "type": "text",
                    "conversation_id": conv_id,
                    "content": {"text": "Node3 has no active Strix session to interrupt for this conversation."},
                })
        elif msg_type == "user_input":
            await self.send({
                "type": "text",
                "conversation_id": str(message.get("conversation_id") or ""),
                "content": {"text": "Node3 has not enabled Strix approval prompt handling yet."},
            })

    async def start_or_update_session(
        self,
        task: dict[str, Any],
        *,
        allow_saved_session: bool = False,
    ) -> StrixPlatformConversationSession | None:
        conv_id = task["conversation_id"]
        session = self.sessions.get(conv_id)
        if session is not None:
            session.update_task_context(task)
            return session
        if not extract_target(task) and not (allow_saved_session and self.saved_session_exists(conv_id)):
            await self.send({
                "type": "task_error",
                "conversation_id": conv_id,
                "task_id": task["task_id"],
                "message": "Node3 requires a target URL/IP for a new Strix conversation, or an existing saved Strix session.",
            })
            return None
        session = StrixPlatformConversationSession(self, task, self.config)
        self.sessions[conv_id] = session
        await session.start()
        return session

    def saved_session_exists(self, conversation_id: str) -> bool:
        run_name = stable_platform_run_name(conversation_id)
        state_dir = self.config.strix_project_dir / "strix_runs" / run_name / ".state"
        return (state_dir / "agents.db").exists() and (state_dir / "agents.json").exists()

    async def close_sessions(self) -> None:
        sessions = list(self.sessions.values())
        self.sessions.clear()
        if sessions:
            await asyncio.gather(*(session.close() for session in sessions), return_exceptions=True)

    async def send(self, message: dict[str, Any] | str) -> None:
        payload = message if isinstance(message, str) else json.dumps(message, ensure_ascii=False)
        while not self.stop_event.is_set():
            ws = self.ws
            if ws is not None:
                try:
                    await ws.send(payload)
                    return
                except Exception as exc:
                    print(f"[node3] websocket send failed; waiting for reconnect: {exc}", flush=True)
                    self.ws = None
            await asyncio.sleep(1)

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
        "Run in coverage-first mode: map the authorized attack surface and plan endpoint/business-flow coverage before deep vulnerability validation.",
        "Avoid reporting negative or speculative findings as vulnerabilities.",
    ]
    return "\n\n".join(piece for piece in pieces if piece)


async def send(ws: Any, message: dict[str, Any]) -> None:
    await ws.send(json.dumps(message, ensure_ascii=False))


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
    if os.name == "nt" and value.replace("\\", "/").startswith("/workspace/"):
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
    standalone.add_argument("--tui", action="store_true", help="Open the Strix Textual TUI. This is the default.")
    standalone.add_argument("--no-tui", action="store_true", help="Run non-interactively and print Strix CLI output.")

    parser.add_argument("--standalone", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--target", default="", help=argparse.SUPPRESS)
    parser.add_argument("--scope", action="append", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--output", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--instruction", default="", help=argparse.SUPPRESS)
    parser.add_argument("--resume", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--scan-mode", default=None, choices=["quick", "standard", "deep"], help=argparse.SUPPRESS)
    parser.add_argument("--tui", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--no-tui", action="store_true", help=argparse.SUPPRESS)

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
    if args.tui and args.no_tui:
        parser.error("standalone cannot combine --tui and --no-tui")
    if "--tui" in target or "--no-tui" in target:
        parser.error("standalone target contains a TUI flag; add a space before --tui/--no-tui")

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
    tui_enabled = not args.no_tui
    if tui_enabled:
        cli_args.append("--tui")
    else:
        cli_args.append("-n")
    cli_args.extend(config.extra_args)

    print(f"[node3] standalone Strix source: {ROOT / 'strix'}", flush=True)
    print(f"[node3] standalone workspace: {output_dir}", flush=True)
    print(f"[node3] standalone mode: {'tui' if tui_enabled else 'headless'}", flush=True)
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
