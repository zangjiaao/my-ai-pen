"""MVP Alpha smoke checks for the pentest node safety/control loop.

This avoids Docker and network calls. It exercises the deterministic intake,
scope gate, destructive approval wait, and workflow event emission with fakes.
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.agent.loop import PentestAgentLoop  # noqa: E402
from pentest_node.evidence.store import EvidenceStore  # noqa: E402
from pentest_node.tools.execute import make_execute_tool  # noqa: E402
from pentest_node.tools.registry import ToolRegistry  # noqa: E402
from pentest_node.tools.workflow import make_workflow_tools  # noqa: E402


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


async def assert_intake(loop: PentestAgentLoop) -> None:
    intake = await loop._intake()
    assert intake.ok, intake.reason
    assert intake.target == "https://example.com"
    assert any(e.get("type") == "status_update" and e.get("active_tool") == "intake" for e in loop.platform.events)


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
        loop = PentestAgentLoop(task, tools, sandbox, ExecuteOnceLLM(), platform, evidence_store=EvidenceStore(Path(tmp)))
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
    loop = PentestAgentLoop(task, ToolRegistry(), sandbox, FakeLLM(), platform)

    await assert_intake(loop)
    await assert_scope_and_approval(loop, sandbox)
    await assert_workflow_events(loop)
    await assert_agent_records_evidence()
    print("node alpha smoke ok")


if __name__ == "__main__":
    asyncio.run(main())