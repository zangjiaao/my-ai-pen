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
from pentest_node.agent.state import Phase  # noqa: E402
from pentest_node.evidence.store import EvidenceStore  # noqa: E402
from pentest_node.tools.browser import make_browser_tool  # noqa: E402
from pentest_node.tools.execute import make_execute_tool  # noqa: E402
from pentest_node.tools.http import make_http_tool  # noqa: E402
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


class PrematureCompleteLLM:
    def __init__(self) -> None:
        self.seen_tools: list[list[str]] = []
        self.calls = 0

    async def chat(self, messages, tools=None):
        self.calls += 1
        self.seen_tools.append([tool["function"]["name"] for tool in (tools or [])])
        return {
            "content": "",
            "finish_reason": "tool_calls",
            "tool_calls": [{
                "id": f"premature-complete-{self.calls}",
                "function": {"name": "task_complete", "arguments": "{}"},
            }],
        }


class TextOnlyLLM:
    async def chat(self, messages, tools=None):
        return {"content": "建议执行 `curl https://example.com/`", "tool_calls": [], "finish_reason": "stop"}


class DvwaReconLLM:
    def __init__(self) -> None:
        self.phase_calls: dict[str, int] = {}

    async def chat(self, messages, tools=None):
        phase = "unknown"
        content = "\n".join(str(m.get("content", "")) for m in messages)
        for candidate in ("intake", "recon", "analysis", "verify", "report", "complete"):
            if f"Current phase: {candidate}" in content:
                phase = candidate
                break
        self.phase_calls[phase] = self.phase_calls.get(phase, 0) + 1
        tool_id = f"{phase}-{self.phase_calls[phase]}"
        if phase in {"intake", "analysis", "verify", "report"}:
            name = "phase_transition"
            args = '{"phase_summary":"ok"}'
        elif phase == "recon":
            if self.phase_calls[phase] == 1:
                name = "execute"
                args = '{"command":"curl -sI http://host.docker.internal:8080/login.php","reason":"dvwa recon"}'
            else:
                name = "phase_transition"
                args = '{"phase_summary":"recon done"}'
        else:
            name = "task_complete"
            args = "{}"
        return {"content": "", "finish_reason": "tool_calls", "tool_calls": [{"id": tool_id, "function": {"name": name, "arguments": args}}]}


def _phase_label(phase: str) -> str:
    return {
        "precheck": "预检",
        "plan": "计划",
        "recon": "信息收集",
        "scan": "漏洞扫描",
        "verify": "漏洞验证",
        "report": "报告",
    }.get(phase, phase)


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
    event = [e for e in loop.platform.events if e.get("type") == "intake_update" and e.get("active_tool") == "intake"][-1]
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


async def assert_host_port_intake() -> None:
    task = {
        "instruction": "test host.docker.internal:8080",
        "target": {"value": "host.docker.internal:8080"},
        "scope": {"allow": ["host.docker.internal"], "deny": []},
    }
    loop = make_loop(task, intake=FakeIntake())
    intake = await loop._intake()
    assert intake.ok, intake.reason
    assert loop.task["node_task"]["host"] == "host.docker.internal"
    assert loop.task["node_task"]["port"] == 8080


async def assert_host_port_scope() -> None:
    sandbox = FakeSandbox()
    execute = make_execute_tool(sandbox, scope={"allow": ["host.docker.internal"]})
    allowed = await execute.handler(
        command="curl -sI http://host.docker.internal:8080/login.php",
        reason="dvwa scope regression",
    )
    assert allowed["status"] == "done"
    assert sandbox.commands == ["curl -sI http://host.docker.internal:8080/login.php"]

    port_scoped = make_execute_tool(FakeSandbox(), scope={"allow": ["host.docker.internal:9090"]})
    blocked = await port_scoped.handler(
        command="curl -sI http://host.docker.internal:8080/login.php",
        reason="port boundary regression",
    )
    assert blocked["status"] == "blocked"
    assert blocked["stderr"] == "scope denied"


async def assert_network_tool_scope_and_risk_gates() -> None:
    scope = {"allow": ["https://example.com"], "deny": ["https://blocked.example.com"]}
    http_tool = make_http_tool(scope=scope, approval_callback=lambda **kwargs: asyncio.sleep(0, result="cancel"))
    outside = await http_tool.handler(method="GET", url="https://evil.example/", reason="scope regression")
    assert outside["status"] == "blocked"
    assert outside["stderr"] == "scope denied"

    denied = await http_tool.handler(method="GET", url="https://blocked.example.com/", reason="deny regression")
    assert denied["status"] == "blocked"
    assert denied["stderr"] == "scope denied"

    destructive = await http_tool.handler(method="DELETE", url="https://example.com/item/1", reason="approval regression")
    assert destructive["status"] == "blocked"
    assert destructive["stderr"] == "not authorized"

    browser_tool = make_browser_tool(scope=scope)
    browser_outside = await browser_tool.handler(action="navigate", url="https://evil.example/")
    assert browser_outside["status"] == "blocked"
    assert browser_outside["stderr"] == "scope denied"

    task = {
        "instruction": "test https://example.com",
        "target": {"value": "https://example.com"},
        "scope": scope,
    }
    loop = make_loop(task)
    workflow_tools = {tool.name: tool for tool in make_workflow_tools(loop)}
    approval = await workflow_tools["request_approval"].handler(
        risk_level="destructive",
        question="outside?",
        proposed_action="DELETE https://evil.example/item/1",
        target="https://evil.example/item/1",
    )
    assert approval["status"] == "blocked"


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

async def assert_phase_tool_guard() -> None:
    platform = FakePlatform()
    llm = PrematureCompleteLLM()
    task = {
        "instruction": "test https://example.com",
        "target": {"value": "https://example.com"},
        "scope": {"allow": ["example.com"]},
    }
    loop = make_loop(task, platform=platform, llm=llm)
    for tool in make_workflow_tools(loop):
        loop.tools.register(tool)

    await loop._run_phase(Phase.INTAKE)
    assert llm.seen_tools, "LLM was not called"
    assert "task_complete" not in llm.seen_tools[0]
    assert not loop._aborted
    assert any(
        e.get("type") == "tool_output"
        and e.get("status") == "blocked"
        and "not allowed in intake" in e.get("line", "")
        for e in platform.events
    )


async def assert_text_only_supervision() -> None:
    platform = FakePlatform()
    task = {
        "instruction": "test https://example.com",
        "target": {"value": "https://example.com"},
        "scope": {"allow": ["example.com"]},
    }
    loop = make_loop(task, platform=platform, llm=TextOnlyLLM())
    loop.tools.register(make_execute_tool(FakeSandbox(), scope=task["scope"]))
    for tool in make_workflow_tools(loop):
        loop.tools.register(tool)

    await loop._run_phase(Phase.RECON)
    system_messages = [m.get("content", "") for m in loop.history if m.get("role") == "system"]
    assert any("Reflector" in m for m in system_messages)
    assert any("Watchdog" in m for m in system_messages)
    assert any("Mentor" in m for m in system_messages)
async def assert_watchdog_command_safety() -> None:
    task = {
        "instruction": "test https://example.com",
        "target": {"value": "https://example.com"},
        "scope": {"allow": ["example.com"]},
    }
    loop = make_loop(task)
    safe = loop._extract_safe_watchdog_commands("```bash\ncurl https://example.com/\n```")
    assert safe == ["curl https://example.com/"]
    assert loop._extract_safe_watchdog_commands("```bash\nrm -rf /\n```") == []
    assert loop._extract_safe_watchdog_commands("```bash\ncurl https://example.com/`whoami`\n```") == []
    assert loop._extract_safe_watchdog_commands("```bash\ncurl https://example.com/$(whoami)\n```") == []

async def assert_dvwa_reaches_recon() -> None:
    platform = FakePlatform()
    sandbox = FakeSandbox()
    task = {
        "instruction": "test http://host.docker.internal:8080/login.php",
        "target": {"value": "http://host.docker.internal:8080/login.php"},
        "scope": {"allow": ["host.docker.internal"], "deny": []},
    }
    tools = ToolRegistry()
    loop = PentestAgentLoop(task, tools, sandbox, DvwaReconLLM(), platform, intake=FakeIntake())
    tools.register(make_execute_tool(sandbox, approval_callback=loop.wait_for_approval, scope=task["scope"]))
    for tool in make_workflow_tools(loop):
        tools.register(tool)

    result = await loop.run()
    assert result.status == "completed"
    assert "curl -sI http://host.docker.internal:8080/login.php" in sandbox.commands
    phases = {event.get("phase") for event in platform.events if event.get("type") in {"intake_update", "status_update"}}
    assert {"intake", "recon", "analysis"} <= phases

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
        loop.task["resolved_target"] = "https://example.com/"
        await loop._run_phase(Phase.RECON)
        assert any(e.get("type") == "evidence_created" for e in platform.events)


async def assert_confirm_finding_requires_known_evidence() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        platform = FakePlatform()
        task = {
            "instruction": "test https://example.com",
            "target": {"value": "https://example.com"},
            "scope": {"allow": ["example.com"]},
        }
        loop = PentestAgentLoop(
            task,
            ToolRegistry(),
            FakeSandbox(),
            FakeLLM(),
            platform,
            evidence_store=EvidenceStore(Path(tmp)),
            intake=FakeIntake(),
        )
        tools = {tool.name: tool for tool in make_workflow_tools(loop)}
        finding = await tools["create_candidate_finding"].handler(
            title="Evidence gated finding",
            vuln_type="info_disclosure",
            severity="low",
            affected_asset="https://example.com",
            location="/headers",
            confidence=0.7,
            evidence_summary="headers exposed",
        )
        missing = await tools["confirm_finding"].handler(
            candidate_finding_id=finding["finding_id"],
            reproduction_steps="curl https://example.com/headers",
            impact="header exposure",
            remediation="remove header",
            evidence_ids=[],
        )
        assert missing["status"] == "error"
        unknown = await tools["confirm_finding"].handler(
            candidate_finding_id=finding["finding_id"],
            reproduction_steps="curl https://example.com/headers",
            impact="header exposure",
            remediation="remove header",
            evidence_ids=["ev-missing"],
        )
        assert unknown["status"] == "error"
        evidence = await loop.evidence_store.collect_http_trace("tool-confirm", "GET https://example.com/headers HTTP/1.1", "HTTP/1.1 200 OK")
        assert evidence is not None
        confirmed = await tools["confirm_finding"].handler(
            candidate_finding_id=finding["finding_id"],
            target_url="https://example.com/headers",
            reproduction_steps="curl https://example.com/headers",
            reproduction_request="GET https://example.com/headers HTTP/1.1",
            response_proof="HTTP/1.1 200 OK",
            impact="header exposure",
            remediation="remove header",
            evidence_ids=[evidence.evidence_id],
        )
        assert confirmed["status"] == "ok"
        sent = [e for e in platform.events if e.get("type") == "vuln_found" and e.get("status") == "confirmed"]
        assert sent and sent[-1]["evidence_ids"] == [evidence.evidence_id]


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
    await assert_host_port_intake()
    await assert_host_port_scope()
    await assert_network_tool_scope_and_risk_gates()
    await assert_workflow_events(loop)
    await assert_phase_tool_guard()
    await assert_text_only_supervision()
    await assert_watchdog_command_safety()
    await assert_dvwa_reaches_recon()
    await assert_agent_records_evidence()
    await assert_confirm_finding_requires_known_evidence()
    print("node alpha smoke ok")


if __name__ == "__main__":
    asyncio.run(main())