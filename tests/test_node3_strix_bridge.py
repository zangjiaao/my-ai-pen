import asyncio
import importlib
import json
import sys
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
NODE3 = ROOT / "node3"
if str(NODE3) not in sys.path:
    sys.path.insert(0, str(NODE3))

from strix.platform.node_protocol import (  # noqa: E402
    PlatformEventSink,
    agent_graph_from_file,
    checkpoint,
    notes_from_file,
    todos_from_file,
    vulnerabilities_from_file,
)
from agents.tool_context import ToolContext  # noqa: E402
from strix.core.agents import AgentCoordinator  # noqa: E402
from strix.tools.agents_graph import tools as agent_tools  # noqa: E402
from strix.tools.todo import tools as todo_tools  # noqa: E402
from strix.tools.reporting import node3_tool  # noqa: E402
import main as node3_main  # noqa: E402


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, payload: str) -> None:
        self.sent.append(json.loads(payload))


def test_node3_reporting_tool_is_used_by_vendored_strix():
    import strix.agents.factory as factory
    from strix.tools.reporting.node3_tool import create_vulnerability_report

    assert create_vulnerability_report.name == "create_vulnerability_report"
    assert factory.create_vulnerability_report is create_vulnerability_report


def test_bridge_vulnerability_callback_emits_platform_evidence_and_finding():
    async def run_bridge():
        ws = FakeWebSocket()
        task = {
            "task_id": "task-1",
            "conversation_id": "conv-1",
            "target": {"value": "http://target.local"},
            "scope": {},
            "snapshot": {},
        }
        bridge = PlatformEventSink(ws, task)
        pump = asyncio.create_task(bridge.pump())
        bridge.vulnerability_found({
            "id": "vuln-0001",
            "title": "Reflected XSS",
            "severity": "high",
            "target": "http://target.local",
            "endpoint": "/search",
            "description": "Confirmed reflected XSS.",
            "impact": "Session theft.",
            "remediation_steps": "Encode output.",
        })
        await bridge.close()
        await pump
        return ws.sent

    sent = asyncio.run(run_bridge())

    assert [message["type"] for message in sent] == ["evidence_created", "text", "vuln_found"]
    assert sent[0]["evidence_type"] == "strix_vulnerability_report"
    assert "发现并记录漏洞" in sent[1]["content"]["text"]
    assert sent[2]["title"] == "Reflected XSS"
    assert sent[2]["severity"] == "high"
    assert sent[2]["evidence_ids"] == [sent[0]["evidence_id"]]


def test_bridge_tool_output_includes_platform_card_fields():
    class RawCall:
        call_id = "call-1"
        name = "exec_command"
        arguments = json.dumps({"cmd": "id"})

    class RawOutput:
        call_id = "call-1"

    class CallItem:
        type = "tool_call_item"
        raw_item = RawCall()

    class OutputItem:
        type = "tool_call_output_item"
        raw_item = RawOutput()
        output = "Process exited with code 0\nOutput:\nuid=1000(pentester)\n"

    class Event:
        type = "run_item_stream_event"

        def __init__(self, item):
            self.item = item

    async def run_bridge():
        ws = FakeWebSocket()
        task = {
            "task_id": "task-1",
            "conversation_id": "conv-1",
            "target": {"value": "http://target.local"},
            "scope": {},
            "snapshot": {},
        }
        bridge = PlatformEventSink(ws, task)
        pump = asyncio.create_task(bridge.pump())
        bridge.sdk_event("agent-1", Event(CallItem()))
        bridge.sdk_event("agent-1", Event(OutputItem()))
        await bridge.close()
        await pump
        return ws.sent

    sent = asyncio.run(run_bridge())

    assert [message["type"] for message in sent] == ["tool_output", "tool_output"]
    assert sent[0]["display_title"] == "Exec Command"
    assert sent[0]["category"] == "command"
    assert sent[0]["command"] == "id"
    assert sent[0]["args"] == {"cmd": "id"}
    assert sent[1]["status"] == "done"
    assert "uid=1000" in sent[1]["line"]


def test_bridge_checkpoint_includes_normalized_strix_agent_graph(tmp_path):
    agents_path = tmp_path / ".state" / "agents.json"
    agents_path.parent.mkdir()
    agents_path.write_text(json.dumps({
        "statuses": {"root": "running", "child": "waiting"},
        "parent_of": {"root": None, "child": "root"},
        "names": {"root": "strix", "child": "SQL Injection Specialist"},
        "metadata": {
            "root": {"task": "Test http://target.local", "skills": []},
            "child": {"task": "Validate SQL injection", "skills": ["sql_injection"]},
        },
        "pending_counts": {"root": 0, "child": 1},
    }), encoding="utf-8")
    task = {"task_id": "task-1", "conversation_id": "conv-1"}

    payload = checkpoint(task, "run-1", str(tmp_path), agents=agent_graph_from_file(agents_path))

    agents = payload["checkpoint"]["node3_strix"]["agents"]
    assert agents[0]["id"] == "root"
    assert agents[0]["role"] == "main"
    assert agents[1]["parent_id"] == "root"
    assert agents[1]["skills"] == ["sql_injection"]
    assert agents[1]["pending_count"] == 1


def test_bridge_checkpoint_includes_strix_state_artifacts(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "todos.json").write_text(json.dumps({
        "root": {
            "todo-1": {
                "title": "Test SQL injection on login.php",
                "description": "Test login form for SQL injection vulnerabilities",
                "priority": "high",
                "status": "pending",
                "created_at": "2026-07-06T10:00:00Z",
                "updated_at": "2026-07-06T10:00:00Z",
            },
        },
    }), encoding="utf-8")
    (state_dir / "notes.json").write_text(json.dumps({
        "note-1": {
            "title": "Additional Vulns Assessment Summary",
            "content": "## Assessment Results\nConfirmed SQL injection.",
            "category": "findings",
            "tags": ["dvwa", "sqli"],
        },
    }), encoding="utf-8")
    (tmp_path / "vulnerabilities.json").write_text(json.dumps([{
        "id": "vuln-0001",
        "title": "SQL Injection in /login.php",
        "severity": "critical",
        "target": "http://host.docker.internal:8080/login.php",
        "endpoint": "/login.php",
        "method": "POST",
        "cwe": "CWE-89",
        "cvss": 9.8,
        "cvss_breakdown": {"attack_vector": "N"},
        "description": "Authentication query is injectable.",
        "impact": "Authentication bypass.",
        "technical_analysis": "Input is concatenated into SQL.",
        "poc_description": "Submit an OR 1=1 payload.",
        "poc_script_code": "print('poc')",
        "remediation_steps": "Use parameterized queries.",
        "agent_id": "child",
        "agent_name": "SQL Injection Specialist",
    }]), encoding="utf-8")
    task = {"task_id": "task-1", "conversation_id": "conv-1"}

    payload = checkpoint(
        task,
        "run-1",
        str(tmp_path),
        todos=todos_from_file(state_dir / "todos.json"),
        notes=notes_from_file(state_dir / "notes.json"),
        vulnerabilities=vulnerabilities_from_file(tmp_path / "vulnerabilities.json"),
    )

    node3 = payload["checkpoint"]["node3_strix"]
    assert node3["todos"][0]["agent_id"] == "root"
    assert node3["todos"][0]["priority"] == "high"
    assert node3["notes"][0]["category"] == "findings"
    assert node3["vulnerabilities"][0]["endpoint"] == "/login.php"
    assert node3["vulnerabilities"][0]["technical_analysis"] == "Input is concatenated into SQL."


def test_todo_tool_schema_accepts_array_inputs():
    import strix.agents.factory as factory

    schema = factory._normalize_chat_completions_schema(todo_tools.create_todo.params_json_schema)
    todos_schema = schema["properties"]["todos"]
    todo_ids_schema = factory._normalize_chat_completions_schema(
        todo_tools.mark_todo_done.params_json_schema,
    )["properties"]["todo_ids"]

    assert "anyOf" in todos_schema
    assert any(option.get("type") == "array" for option in todos_schema["anyOf"])
    assert "anyOf" in todo_ids_schema
    assert any(option.get("type") == "array" for option in todo_ids_schema["anyOf"])


def test_chat_completions_tool_schemas_have_typed_properties():
    from agents.tool import FunctionTool
    from strix.agents.factory import build_strix_agent

    agent = build_strix_agent(is_root=True, chat_completions_tools=True)

    for tool in agent.tools:
        if not isinstance(tool, FunctionTool):
            continue
        schema = tool.params_json_schema
        assert any(key in schema for key in ("type", "anyOf", "$ref")), tool.name
        for prop_name, prop_schema in schema.get("properties", {}).items():
            assert any(
                key in prop_schema for key in ("type", "anyOf", "$ref", "oneOf", "allOf", "enum", "const")
            ), f"{tool.name}.{prop_name}"
        if schema.get("type") == "object":
            assert schema.get("properties"), tool.name


def test_empty_argument_tools_get_deepseek_placeholder():
    from agents.tool import FunctionTool
    from strix.agents.factory import build_strix_agent

    agent = build_strix_agent(is_root=True, chat_completions_tools=True)
    graph_tool = next(tool for tool in agent.tools if isinstance(tool, FunctionTool) and tool.name == "view_agent_graph")

    assert graph_tool.params_json_schema["properties"] == {
        "_noop": {
            "type": "string",
            "description": "Optional ignored placeholder for providers that reject empty parameter objects.",
        },
    }
    assert graph_tool.params_json_schema["required"] == ["_noop"]


def test_create_todo_is_atomic_and_accepts_medium_priority(tmp_path):
    todo_tools.hydrate_todos_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="create_todo",
        tool_call_id="call-1",
        tool_arguments="{}",
    )

    bad = asyncio.run(todo_tools.create_todo.on_invoke_tool(
        ctx,
        json.dumps({"todos": [
            {"title": "First task", "priority": "critical"},
            {"title": "Bad task", "priority": "urgent"},
        ]}),
    ))
    assert json.loads(bad)["success"] is False
    assert not (tmp_path / "todos.json").exists()

    good = asyncio.run(todo_tools.create_todo.on_invoke_tool(
        ctx,
        json.dumps({"todos": [
            {"title": "Medium task", "priority": "medium"},
        ]}),
    ))
    payload = json.loads(good)

    assert payload["success"] is True
    assert payload["created"][0]["priority"] == "normal"
    persisted = json.loads((tmp_path / "todos.json").read_text(encoding="utf-8"))
    assert len(persisted["root"]) == 1
    assert next(iter(persisted["root"].values()))["priority"] == "normal"


def test_stop_agent_requires_force_for_active_child():
    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        await coordinator.register("child", "child", "root")
        ctx = ToolContext(
            context={"agent_id": "root", "coordinator": coordinator},
            tool_name="stop_agent",
            tool_call_id="call-1",
            tool_arguments="{}",
        )

        denied = await agent_tools.stop_agent.on_invoke_tool(
            ctx,
            json.dumps({"target_agent_id": "child", "reason": "wrap up"}),
        )
        _, statuses, _ = await coordinator.graph_snapshot()

        forced = await agent_tools.stop_agent.on_invoke_tool(
            ctx,
            json.dumps({"target_agent_id": "child", "reason": "duplicate work", "force": True}),
        )
        _, forced_statuses, _ = await coordinator.graph_snapshot()

        return json.loads(denied), statuses, json.loads(forced), forced_statuses

    denied, statuses, forced, forced_statuses = asyncio.run(run())

    assert denied["success"] is False
    assert "force=true" in denied["error"]
    assert statuses["child"] == "running"
    assert forced["success"] is True
    assert forced_statuses["child"] == "stopped"


def test_agent_finish_blocks_unresolved_todos(tmp_path):
    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        await coordinator.register("child", "child", "root")
        todo_tools.hydrate_todos_from_disk(tmp_path)
        todo_ctx = ToolContext(
            context={"agent_id": "child"},
            tool_name="create_todo",
            tool_call_id="call-todo",
            tool_arguments="{}",
        )
        await todo_tools.create_todo.on_invoke_tool(
            todo_ctx,
            json.dumps({"todos": [{"title": "Validate endpoint", "priority": "high"}]}),
        )

        finish_ctx = ToolContext(
            context={"agent_id": "child", "parent_id": "root", "coordinator": coordinator},
            tool_name="agent_finish",
            tool_call_id="call-finish",
            tool_arguments="{}",
        )
        result = await agent_tools.agent_finish.on_invoke_tool(
            finish_ctx,
            json.dumps({"result_summary": "done"}),
        )
        _, statuses, _ = await coordinator.graph_snapshot()
        return json.loads(result), statuses

    result, statuses = asyncio.run(run())

    assert result["success"] is False
    assert result["agent_completed"] is False
    assert result["unfinished_todos"][0]["title"] == "Validate endpoint"
    assert statuses["child"] == "running"


def test_reporting_shim_calculates_cvss_and_persists(monkeypatch):
    class FakeReportState:
        def __init__(self) -> None:
            self.reports: list[dict] = []

        def get_existing_vulnerabilities(self) -> list[dict]:
            return []

        def add_vulnerability_report(self, **kwargs):
            self.reports.append(kwargs)
            return "vuln-0001"

    state = FakeReportState()
    async def fake_check_duplicate(candidate, existing):
        return {
            "is_duplicate": False,
            "duplicate_id": "",
            "confidence": 1.0,
            "reason": "test",
        }

    monkeypatch.setattr("strix.report.dedupe.check_duplicate", fake_check_duplicate)
    monkeypatch.setattr("strix.report.state.get_global_report_state", lambda: state)

    result = asyncio.run(node3_tool._do_create(
        title="Unauthenticated RCE",
        description="Remote command execution is confirmed.",
        impact="An attacker can execute arbitrary commands.",
        target="http://target.local",
        technical_analysis="The endpoint passes user input to a shell.",
        poc_description="Send the payload and observe command output.",
        poc_script_code="print('poc')",
        remediation_steps="Avoid shell invocation and validate input.",
        cvss_breakdown={
            "attack_vector": "N",
            "attack_complexity": "L",
            "privileges_required": "N",
            "user_interaction": "N",
            "scope": "U",
            "confidentiality": "H",
            "integrity": "H",
            "availability": "H",
        },
        endpoint="/run",
        method="POST",
        cve=None,
        cwe="CWE-78",
        code_locations=None,
    ))

    assert result["success"] is True
    assert result["severity"] == "critical"
    assert result["cvss_score"] == 9.8
    assert state.reports[0]["severity"] == "critical"
    assert state.reports[0]["cvss"] == 9.8


def test_standalone_defaults_to_explicit_tui(monkeypatch, tmp_path):
    captured: dict[str, list[str]] = {}

    def fake_strix_main() -> None:
        captured["argv"] = sys.argv[:]

    class FakeConfig:
        scan_mode = "quick"
        extra_args: list[str] = []

    strix_main_module = importlib.import_module("strix.interface.main")
    monkeypatch.setattr(node3_main, "Node3Config", FakeConfig)
    monkeypatch.setattr(strix_main_module, "main", fake_strix_main)

    args = node3_main.argparse.Namespace(
        target="http://host.docker.internal:8080/login.php",
        resume="",
        output=str(tmp_path),
        scan_mode=None,
        instruction="",
        scope=None,
        tui=True,
        no_tui=False,
    )

    node3_main.run_standalone_strix(args, node3_main.argparse.ArgumentParser())

    assert captured["argv"] == [
        "strix",
        "--target",
        "http://host.docker.internal:8080/login.php",
        "--scan-mode",
        "quick",
        "--tui",
    ]


def test_standalone_rejects_tui_flag_glued_to_target(monkeypatch, tmp_path):
    class FakeConfig:
        scan_mode = "quick"
        extra_args: list[str] = []

    monkeypatch.setattr(node3_main, "Node3Config", FakeConfig)
    args = node3_main.argparse.Namespace(
        target="http://host.docker.internal:8080/login.php--tui",
        resume="",
        output=str(tmp_path),
        scan_mode=None,
        instruction="",
        scope=None,
        tui=False,
        no_tui=False,
    )

    with patch.object(node3_main.argparse.ArgumentParser, "exit", side_effect=RuntimeError):
        try:
            node3_main.run_standalone_strix(args, node3_main.argparse.ArgumentParser())
        except RuntimeError:
            pass
        else:
            raise AssertionError("expected parser.error to exit")
