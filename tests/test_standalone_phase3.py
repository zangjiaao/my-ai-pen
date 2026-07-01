import asyncio
import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.config import NodeConfig  # noqa: E402
from pentest_node.db import NodeDB  # noqa: E402
from pentest_node.events.sink import LocalFirstEventSink  # noqa: E402
from pentest_node.tui.logging_config import configure_tui_logging  # noqa: E402
from pentest_node.standalone.runner import StandaloneOptions, run_standalone  # noqa: E402
from pentest_node.tools.registry import ToolSpec  # noqa: E402
from pentest_node.tui.commands import options_from_command  # noqa: E402


def make_fake_http_tool(target: str) -> ToolSpec:
    async def handler(**kwargs):
        method = str(kwargs.get("method") or "GET").upper()
        url = str(kwargs.get("url") or target)
        body = """
        <html>
          <body>
            <a href="/login">Login</a>
            <form action="/search" method="GET">
              <input name="q" />
            </form>
          </body>
        </html>
        """.strip()
        request = f"{method} {url} HTTP/1.1\nHost: 192.0.2.1"
        response = "HTTP 200\ncontent-type: text/html\n\n" + body
        return {
            "status": "done",
            "status_code": 200,
            "headers": {"content-type": "text/html"},
            "body": body,
            "request": request,
            "response": response,
            "url": url,
            "method": method,
            "risk_level": "safe",
        }

    return ToolSpec(
        name="http_request",
        description="Fake HTTP request tool for standalone runner tests.",
        parameters={"type": "object", "properties": {}, "required": []},
        risk_level="safe",
        handler=handler,
    )


class FakeSandbox:
    def __init__(self):
        self.started = False
        self.destroyed = False

    async def start(self, session_id):
        self.started = True

    async def destroy(self):
        self.destroyed = True

    async def execute(self, command, timeout=600):
        return {"exit_code": 0, "stdout": "ok", "stderr": ""}


class FakeLLM:
    def __init__(self, target: str):
        self.target = target
        self.calls = []

    async def chat(self, messages, tools=None):
        phase = "unknown"
        for message in messages:
            content = str(message.get("content") or "")
            if "Current phase:" in content:
                phase = content.split("Current phase:", 1)[1].split()[0].strip(".")
        self.calls.append(phase)
        if phase == "recon" and self.calls.count("recon") == 1:
            return self._tool("call-http", "http_request", {"method": "GET", "url": self.target, "reason": "seed surface"})
        if phase == "analysis":
            return self._tools([
                ("call-coverage", "mark_coverage", {"endpoint": f"GET {self.target}", "parameter": "<none>", "vuln_type": "xss", "status": "tried", "notes": "baseline tried"}),
                ("call-analysis-next", "phase_transition", {"phase_summary": "coverage planned"}),
            ])
        if phase in {"recon", "verify", "report"}:
            return self._tool(f"call-{phase}-next", "phase_transition", {"phase_summary": f"{phase} done"})
        if phase == "complete":
            return self._tool("call-complete", "task_complete", {})
        return {"content": "", "tool_calls": [], "finish_reason": "stop"}

    def _tool(self, call_id, name, args):
        return self._tools([(call_id, name, args)])

    def _tools(self, calls):
        return {
            "content": "",
            "finish_reason": "tool_calls",
            "tool_calls": [
                {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
                for call_id, name, args in calls
            ],
        }


class StandalonePhase3Tests(unittest.TestCase):
    def test_node_db_persists_event_projection(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                db = NodeDB(Path(tmp) / "node.sqlite3")
                await db.init()
                await db.create_session(
                    session_id="s1",
                    task_id="t1",
                    target={"type": "url", "value": "http://192.0.2.1/"},
                    scope={"allow": ["http://192.0.2.1/"], "deny": []},
                    instruction="test",
                    output_dir=tmp,
                    status="running",
                )
                await db.save_event("s1", {"type": "request_decision", "request_id": "req-1", "risk_level": "destructive", "question": "Allow?", "proposed_action": "sqlmap"})
                await db.save_user_decision_message("s1", "req-1", "authorize")
                await db.save_event("s1", {"type": "tool_output", "tool_name": "http_request", "tool_run_id": "tool-1", "status": "done", "line": "HTTP 200", "evidence_id": "ev-111111111111"})
                await db.save_event("s1", {"type": "evidence_created", "evidence_id": "ev-111111111111", "evidence_type": "http_trace", "source_tool": "http_request", "tool_run_id": "tool-1", "summary": "HTTP trace"})
                await db.save_event("s1", {"type": "asset_discovered", "address": "http://192.0.2.1/", "asset_type": "web"})
                await db.save_event("s1", {"type": "coverage_marked", "coverage": {"coverage_id": "cov-1", "endpoint": "GET http://192.0.2.1/", "parameter": "<none>", "vuln_type": "xss", "status": "tried"}})
                await db.save_event("s1", {"type": "checkpoint_update", "checkpoint": {"phase": "verify", "iteration": 3, "state": {"phase": "verify", "iteration": 3}}})
                snap = await db.snapshot("s1")
                await db.close()
                return snap

        snap = asyncio.run(scenario())

        self.assertEqual(snap["session"]["status"], "running")
        self.assertEqual(len(snap["messages"]), 3)
        self.assertEqual(len(snap["tool_runs"]), 1)
        self.assertEqual(len(snap["evidence"]), 1)
        self.assertEqual(len(snap["assets"]), 1)
        self.assertEqual(len(snap["coverage"]), 1)
        self.assertEqual(snap["approvals"][0]["decision"], "authorize")
        self.assertEqual(snap["checkpoint"]["phase"], "verify")

    def test_tui_logging_routes_to_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_logger = logging.getLogger()
            old_handlers = list(root_logger.handlers)
            stream = logging.StreamHandler()
            root_logger.addHandler(stream)
            try:
                log_path = configure_tui_logging(Path(tmp))
                handlers = list(root_logger.handlers)
                self.assertEqual(len(handlers), 1)
                self.assertIsInstance(handlers[0], logging.FileHandler)
                self.assertEqual(Path(handlers[0].baseFilename), log_path)
                self.assertTrue(log_path.parent.exists())
            finally:
                for handler in list(root_logger.handlers):
                    root_logger.removeHandler(handler)
                    handler.close()
                for handler in old_handlers:
                    root_logger.addHandler(handler)
    def test_tui_command_creates_standalone_options_from_natural_language(self):
        base = StandaloneOptions(output=Path("node/workspace/standalone"), check_connectivity=False)

        options, error = options_from_command(base, "test http://host.docker.internal:8080/login.php for web vulnerabilities")

        self.assertIsNone(error)
        self.assertEqual(options.target, "http://host.docker.internal:8080/login.php")
        self.assertEqual(options.scope, ["http://host.docker.internal:8080"])
        self.assertIn("web vulnerabilities", options.instruction)
        self.assertFalse(options.check_connectivity)

    def test_tui_command_supports_resume(self):
        base = StandaloneOptions(output=Path("node/workspace/standalone"))

        options, error = options_from_command(base, "/resume session-123")

        self.assertIsNone(error)
        self.assertEqual(options.resume, "session-123")
        self.assertEqual(options.target, "")

    def test_local_first_sink_persists_before_forwarding(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                db = NodeDB(Path(tmp) / "node.sqlite3")
                await db.init()
                await db.create_session(
                    session_id="s1",
                    task_id="t1",
                    target={"type": "url", "value": "http://192.0.2.1/"},
                    scope={"allow": ["http://192.0.2.1/"], "deny": []},
                    instruction="test",
                    output_dir=tmp,
                    status="running",
                )
                forwarded = []

                async def forwarder(event):
                    snap = await db.snapshot("s1")
                    forwarded.append({"event": dict(event), "message_count_at_forward": len(snap["messages"])})

                sink = LocalFirstEventSink(db, "s1", task_id="t1", event_forwarder=forwarder)
                await sink.send({"type": "text", "content": {"text": "hello"}})
                await sink.send({"type": "request_decision", "request_id": "approval-1", "risk_level": "destructive", "question": "Allow?", "proposed_action": "sqlmap"})
                decision = await sink.record_user_decision("approval-1", "authorize")
                snap = await db.snapshot("s1")
                await db.close()
                return forwarded, decision, snap

        forwarded, decision, snap = asyncio.run(scenario())

        self.assertEqual(decision, "authorize")
        self.assertEqual(forwarded[0]["event"]["conversation_id"], "s1")
        self.assertEqual(forwarded[0]["event"]["task_id"], "t1")
        self.assertGreaterEqual(forwarded[0]["message_count_at_forward"], 1)
        self.assertEqual(snap["approvals"][0]["decision"], "authorize")

    def test_standalone_runner_completes_without_platform(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                target = "http://192.0.2.1/"
                options = StandaloneOptions(
                    target=target,
                    output=Path(tmp),
                    session_id="standalone-test",
                    check_connectivity=False,
                )
                events = []
                loops = []
                result = await run_standalone(
                    options,
                    config=NodeConfig(llm_api_key="test-key"),
                    event_callback=lambda event: events.append(event),
                    approval_handler=lambda event: "authorize",
                    sandbox_factory=lambda config, output: FakeSandbox(),
                    llm=FakeLLM(target),
                    tool_overrides={"http_request": make_fake_http_tool(target)},
                    agent_loop_callback=lambda loop: loops.append(loop),
                )
                db = NodeDB(result.db_path)
                await db.init()
                snap = await db.snapshot(result.session_id)
                await db.close()
                summary_path = result.output_dir / f"session-{result.session_id}" / "summary.json"
                summary_exists = summary_path.exists()
                return result, events, snap, summary_exists, loops

        result, events, snap, summary_exists, loops = asyncio.run(scenario())

        self.assertEqual(result.status, "completed")
        self.assertTrue(summary_exists)
        self.assertTrue(any(event.get("type") == "task_complete" for event in events))
        self.assertGreaterEqual(len(snap["attack_surface"]), 1)
        self.assertGreaterEqual(len(snap["coverage"]), 1)
        self.assertEqual(snap["session"]["status"], "completed")
        self.assertEqual(len(loops), 1)


if __name__ == "__main__":
    unittest.main()