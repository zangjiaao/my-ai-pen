"""MVP Alpha smoke checks for the pentest node safety/control loop.

This avoids Docker and network calls. It exercises deterministic intake,
scope gate, destructive approval wait, and workflow event emission with fakes.
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.agent.intake import TaskIntake  # noqa: E402
from pentest_node.agent.loop import PentestAgentLoop  # noqa: E402
from pentest_node.evidence.store import EvidenceStore  # noqa: E402
from pentest_node.tools.execute import make_execute_tool  # noqa: E402
from pentest_node.tools.registry import ToolRegistry  # noqa: E402
from pentest_node.tools.workflow import make_workflow_tools  # noqa: E402


class FakeIntake(TaskIntake):
    def __init__(self, *, dns_ok: bool = True, tcp_ok: bool = True):
        super().__init__(check_connectivity=True)
        self.dns_ok = dns_ok
        self.tcp_ok = tcp_ok

    async def _resolve_host(self, host: str) -> list[str]:
        return ["93.184.216.34"] if self.dns_ok else []

    async def _tcp_connect(self, host: str, port: int) -> bool:
        return self.tcp_ok


class FakePlatform:
    def __init__(self) -> None:
        self.events: list[dict] = []

    async def send(self, msg: dict) -> None:
        self.events.append(dict(msg))


class FakeSandbox:
    def __init__(self) -> None:
        self.commands: list[str] = []

    async def execute(self, command: str, timeout: int = 600) -> dict:
        self.commands.append(command)
        return {"stdout": f"ran: {command}", "stderr": "", "exit_code": 0}


class FakeLLM:
    async def chat(self, messages, tools=None):
        return {"content": "", "tool_calls": [], "finish_reason": "stop"}


class ExecuteOnceLLM:
    def __init__(self) -> None:
        self.called = False

    async def chat(self, messages, tools=None):
        if self.called:
            return {"content": "", "tool_calls": [], "finish_reason": "stop"}
        self.called = True
        return {
            "content": "",
            "finish_reason": "tool_calls",
            "tool_calls": [{
                "id": "tool-smoke",
                "function": {
                    "name": "execute",
                    "arguments": '{"command":"curl https://example.com/","reason":"recon"}',
                },
            }],
        }


def make_loop(task: dict, *, intake: TaskIntake | None = None, platform: FakePlatform | None = None, sandbox: FakeSandbox | None = None, llm=None) -> PentestAgentLoop:
    return PentestAgentLoop(
        task,
        ToolRegistry(),
        sandbox or FakeSandbox(),
        llm or FakeLLM(),
        platform or FakePlatform(),
        intake=intake or FakeIntake(),
    )


async def assert_intake(loop: PentestAgentLoop) -> None:
    intake = await loop._intake()
    assert intake.ok, intake.reason
    assert intake.target == "https://example.com/"
    event = [e for e in loop.platform.events if e.get("type") == "status_update" and e.get("active_tool") == "intake"][-1]
    assert event["status"] == "done"
    assert event["intake_result"]["dns_addresses"] == ["93.184.216.34"]
    assert event["intake_result"]["connectivity"]["ok"] is True
    assert loop.task["node_task"]["host"] == "example.com"


async def assert_intake_failures() -> None:
    base = {
        "instruction": "test https://example.com",
        "target": {"value": "https://example.com"},
        "scope": {"allow": ["example.com"], "deny": []},
    }

    dns_result = await make_loop(base, intake=FakeIntake(dns_ok=False))._intake()
    assert not dns_result.ok
    assert "DNS" in dns_result.reason

    down_result = await make_loop(base, intake=FakeIntake(tcp_ok=False))._intake()
    assert not down_result.ok
    assert "不可达" in down_result.reason

    localhost_task = {
        "instruction": "test http://localhost:8080/login.php",
        "target": {"value": "http://localhost:8080/login.php"},
        "scope": {"allow": ["localhost"], "deny": []},
    }
    localhost_result = await make_loop(localhost_task)._intake()
    assert not localhost_result.ok
    assert "host.docker.internal" in localhost_result.reason

    denied_task = {
        "instruction": "test https://example.com",
        "target": {"value": "https://example.com"},
        "scope": {"allow": ["example.com"], "deny": ["example.com"]},
    }
    denied_result = await make_loop(denied_task)._intake()
    assert not denied_result.ok
    assert "deny scope" in denied_result.reason

    outside_task = {
        "instruction": "test https://evil.example",
        "target": {"value": "https://evil.example"},
        "scope": {"allow": ["example.com"], "deny": []},
    }
    outside_result = await make_loop(outside_task)._intake()
    assert not outside_result.ok
    assert "不在授权 scope" in outside_result.reason


async def assert_scope_and_approval(loop: PentestAgentLoop, sandbox: FakeSandbox) -> None:
    execute = make_execute_tool(
        sandbox,
        approval_callback=loop.wait_for_approval,
        scope=loop.task["scope"],
    )

    outside = await execute.handler(command="curl https://evil.example/", reason="scope test")
    assert outside["status"] == "blocked"
    assert outside["stderr"] == "scope denied"
    assert sandbox.commands == []

    approval_task = asyncio.create_task(
        execute.handler(command="sqlmap -u https://example.com/item?id=1 --dump", reason="approval test")
    )
    await asyncio.sleep(0)
    approval_events = [e for e in loop.platform.events if e.get("type") == "request_decision"]
    assert approval_events, "destructive command did not request approval"
    request_id = approval_events[-1]["request_id"]
    loop.receive_user_input(request_id, "authorize")
    approved = await approval_task
    assert approved["status"] == "done"
    assert sandbox.commands == ["sqlmap -u https://example.com/item?id=1 --dump"]

    deny_task = asyncio.create_task(
        execute.handler(command="sqlmap -u https://example.com/item?id=2 --dump", reason="deny test")
    )
    await asyncio.sleep(0)
    request_id = [e for e in loop.platform.events if e.get("type") == "request_decision"][-1]["request_id"]
    loop.receive_user_input(request_id, "cancel")
    denied = await deny_task
    assert denied["status"] == "blocked"
    assert denied["stderr"] == "not authorized"


async def assert_workflow_events(loop: PentestAgentLoop) -> None:
    tools = {tool.name: tool for tool in make_workflow_tools(loop)}
    asset = await tools["report_asset"].handler(
        address="https://example.com",
        asset_type="web",
        open_ports=[443],
        services=[{"port": 443, "name": "https"}],
    )
    assert asset["status"] == "ok"
    finding = await tools["create_candidate_finding"].handler(
        title="Alpha candidate",
        vuln_type="info_disclosure",
        severity="low",
        affected_asset="https://example.com",
        location="/headers",
        confidence=0.7,
        evidence_summary="headers exposed",
    )
    assert finding["status"] == "ok"
    assert any(e.get("type") == "asset_discovered" for e in loop.platform.events)
    assert any(e.get("type") == "vuln_found" for e in loop.platform.events)


async def assert_agent_records_evidence() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        platform = FakePlatform()
        sandbox = FakeSandbox()
        task = {
            "instruction": "test https://example.com",
            "target": {"value": "https://example.com"},
            "scope": {"allow": ["example.com"]},
        }
        tools = ToolRegistry()
        loop = PentestAgentLoop(
            task,
            tools,
            sandbox,
            ExecuteOnceLLM(),
            platform,
            evidence_store=EvidenceStore(Path(tmp)),
            intake=FakeIntake(),
        )
        tools.register(make_execute_tool(sandbox, approval_callback=loop.wait_for_approval, scope=task["scope"]))
        await loop._run_phase(loop.state.phase)
        assert any(e.get("type") == "evidence_created" for e in platform.events)


async def main() -> None:
    platform = FakePlatform()
    sandbox = FakeSandbox()
    task = {
        "instruction": "test https://example.com",
        "target": {"value": "https://example.com"},
        "scope": {"allow": ["example.com"]},
    }
    loop = make_loop(task, platform=platform, sandbox=sandbox)

    await assert_intake(loop)
    await assert_intake_failures()
    await assert_scope_and_approval(loop, sandbox)
    await assert_workflow_events(loop)
    await assert_agent_records_evidence()
    print("node alpha smoke ok")


if __name__ == "__main__":
    asyncio.run(main())