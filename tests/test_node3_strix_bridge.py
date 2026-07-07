import asyncio
import importlib
import json
import sys
from types import SimpleNamespace
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
    tool_status_value,
    tool_result_summary,
    todos_from_file,
    vulnerabilities_from_file,
)
from strix.platform.node_runner import merge_task_context, send_runtime_checkpoint, stable_platform_run_name  # noqa: E402
from strix.core.inputs import build_root_task, build_scope_context  # noqa: E402
from strix.profiles import infer_target_profile, load_target_profile  # noqa: E402
from agents.tool_context import ToolContext  # noqa: E402
from strix.core.agents import AgentCoordinator  # noqa: E402
from strix.tools.agents_graph import tools as agent_tools  # noqa: E402
from strix.tools.finish.tool import finish_scan  # noqa: E402
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


def test_bridge_hides_successful_write_stdin_tool_output():
    class RawCall:
        call_id = "call-stdin"
        name = "write_stdin"
        arguments = json.dumps({"session_id": 123, "chars": "y\n"})

    class RawOutput:
        call_id = "call-stdin"

    class CallItem:
        type = "tool_call_item"
        raw_item = RawCall()

    class OutputItem:
        type = "tool_call_output_item"
        raw_item = RawOutput()
        output = "Process exited with code 0\nOutput:\n"

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

    assert asyncio.run(run_bridge()) == []


def test_bridge_keeps_failed_write_stdin_tool_output():
    class RawCall:
        call_id = "call-stdin"
        name = "write_stdin"
        arguments = json.dumps({"session_id": 123, "chars": "y\n"})

    class RawOutput:
        call_id = "call-stdin"

    class CallItem:
        type = "tool_call_item"
        raw_item = RawCall()

    class OutputItem:
        type = "tool_call_output_item"
        raw_item = RawOutput()
        output = json.dumps({"success": False, "error": "session not found"})

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

    assert len(sent) == 1
    assert sent[0]["tool_name"] == "write_stdin"
    assert sent[0]["display_title"] == "Command Input"
    assert sent[0]["status"] == "failed"
    assert "session not found" in sent[0]["line"]


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


def test_runtime_checkpoint_sends_interrupted_run_status(tmp_path):
    (tmp_path / "run.json").write_text(json.dumps({
        "run_id": "run-1",
        "run_name": "run-1",
        "status": "interrupted",
        "start_time": "2026-07-07T07:39:05Z",
        "end_time": "2026-07-07T08:15:20Z",
        "scan_mode": "quick",
        "targets_info": [],
        "llm_usage": {},
    }), encoding="utf-8")

    class FakeReportState:
        vulnerability_reports = []

        def get_run_dir(self):
            return tmp_path

    async def run_bridge():
        task = {"task_id": "task-1", "conversation_id": "conv-1"}
        ws = FakeWebSocket()
        sink = PlatformEventSink(ws, task)
        await send_runtime_checkpoint(ws, task, sink, FakeReportState(), "run-1")
        return ws.sent

    sent = asyncio.run(run_bridge())

    assert sent[0]["type"] == "checkpoint_update"
    assert sent[0]["checkpoint"]["node3_strix"]["run"]["status"] == "interrupted"


def test_stable_platform_run_name_is_deterministic():
    conversation_id = "8e4c637b-8431-48c8-b021-a9ece4c58c4d"

    assert stable_platform_run_name(conversation_id) == "conversation-8e4c637b-8431-48c8-b021-a9ece4c58c4d"
    assert stable_platform_run_name(conversation_id) == stable_platform_run_name(conversation_id.upper())
    assert stable_platform_run_name("") == "conversation-session"


def test_runtime_checkpoint_includes_session_metadata(tmp_path):
    (tmp_path / "run.json").write_text(json.dumps({
        "run_id": "run-1",
        "run_name": "run-1",
        "status": "running",
        "start_time": "2026-07-07T07:39:05Z",
        "end_time": None,
        "scan_mode": "quick",
        "targets_info": [],
        "llm_usage": {},
    }), encoding="utf-8")

    class FakeReportState:
        vulnerability_reports = []

        def get_run_dir(self):
            return tmp_path

    async def run_bridge():
        task = {"task_id": "task-1", "conversation_id": "conv-1"}
        ws = FakeWebSocket()
        sink = PlatformEventSink(ws, task)
        await send_runtime_checkpoint(
            ws,
            task,
            sink,
            FakeReportState(),
            "run-1",
            session_metadata={"conversation_id": "conv-1", "status": "scan_completed"},
        )
        return ws.sent

    sent = asyncio.run(run_bridge())

    assert sent[0]["checkpoint"]["node3_strix"]["session"] == {
        "conversation_id": "conv-1",
        "status": "scan_completed",
    }


def test_finish_scan_keeps_root_waiting_in_platform_conversation(monkeypatch, tmp_path):
    class FakeReportState:
        vulnerability_reports = []

        def update_scan_final_fields(self, **kwargs):
            self.final_fields = kwargs

    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        todo_tools.hydrate_todos_from_disk(tmp_path)
        monkeypatch.setattr("strix.report.state.get_global_report_state", lambda: FakeReportState())
        ctx = ToolContext(
            context={
                "agent_id": "root",
                "parent_id": None,
                "coordinator": coordinator,
                "keep_alive_after_finish": True,
            },
            tool_name="finish_scan",
            tool_call_id="call-finish",
            tool_arguments="{}",
        )

        result = await finish_scan.on_invoke_tool(
            ctx,
            json.dumps({
                "executive_summary": "Summary",
                "methodology": "Methodology",
                "technical_analysis": "Technical analysis",
                "recommendations": "Recommendations",
            }),
        )
        _, statuses, _ = await coordinator.graph_snapshot()
        return json.loads(result), statuses

    result, statuses = asyncio.run(run())

    assert result["success"] is True
    assert result["scan_completed"] is True
    assert statuses["root"] == "waiting"


def test_finish_scan_completes_root_without_keep_alive(monkeypatch, tmp_path):
    class FakeReportState:
        vulnerability_reports = []

        def update_scan_final_fields(self, **kwargs):
            self.final_fields = kwargs

    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        todo_tools.hydrate_todos_from_disk(tmp_path)
        monkeypatch.setattr("strix.report.state.get_global_report_state", lambda: FakeReportState())
        ctx = ToolContext(
            context={"agent_id": "root", "parent_id": None, "coordinator": coordinator},
            tool_name="finish_scan",
            tool_call_id="call-finish",
            tool_arguments="{}",
        )

        result = await finish_scan.on_invoke_tool(
            ctx,
            json.dumps({
                "executive_summary": "Summary",
                "methodology": "Methodology",
                "technical_analysis": "Technical analysis",
                "recommendations": "Recommendations",
            }),
        )
        _, statuses, _ = await coordinator.graph_snapshot()
        return json.loads(result), statuses

    result, statuses = asyncio.run(run())

    assert result["success"] is True
    assert statuses["root"] == "completed"


def test_node3_user_steer_delivers_to_existing_strix_session():
    class FakeConfig:
        scan_mode = "quick"
        strix_project_dir = ROOT

    class FakeSession:
        def __init__(self):
            self.updated: list[dict] = []
            self.delivered: list[dict] = []

        def update_task_context(self, task):
            self.updated.append(task)

        async def send_user_message(self, task):
            self.delivered.append(task)
            return True

    async def run():
        runtime = node3_main.Node3Runtime(FakeConfig())
        runtime.ws = FakeWebSocket()
        session = FakeSession()
        runtime.sessions["conv-1"] = session
        await runtime.handle_message({
            "type": "user_steer",
            "conversation_id": "conv-1",
            "task_id": "task-followup",
            "text": "继续测试登录接口",
        })
        return session, runtime.ws.sent

    session, sent = asyncio.run(run())

    assert session.updated[0]["instruction"] == "继续测试登录接口"
    assert session.delivered[0]["instruction"] == "继续测试登录接口"
    assert sent == []


def test_merge_task_context_keeps_original_task_id():
    merged = merge_task_context(
        {
            "task_id": "task-original",
            "instruction": "scan",
            "scan_mode": "quick",
            "target": {"value": "http://target.local"},
        },
        {
            "task_id": "task-followup",
            "instruction": "continue",
            "scan_mode": "standard",
            "scope": {"allow": ["http://target.local"]},
        },
    )

    assert merged["task_id"] == "task-original"
    assert merged["instruction"] == "continue"
    assert merged["scan_mode"] == "standard"
    assert merged["scope"] == {"allow": ["http://target.local"]}


def test_target_profile_loader_infers_dvwa_high():
    profile_name = infer_target_profile(
        {"instruction": "Run DVWA Docker in High security level"},
        "http://host.docker.internal:8080",
    )
    profile = load_target_profile(profile_name)

    assert profile_name == "dvwa_high"
    assert profile is not None
    assert "security=high" in profile.content


def test_target_profile_loader_infers_juice_shop():
    profile_name = infer_target_profile(
        {"instruction": "Assess OWASP Juice Shop"},
        "http://host.docker.internal:3000",
    )
    profile = load_target_profile(profile_name)

    assert profile_name == "juice_shop"
    assert profile is not None
    assert "single-page application" in profile.content


def test_target_profile_is_injected_into_root_task_and_scope_context():
    profile = load_target_profile("dvwa_high")
    assert profile is not None
    scan_config = {
        "targets": [{
            "type": "web_application",
            "details": {"target_url": "http://host.docker.internal:8080"},
        }],
        "target_profile": {
            "name": profile.name,
            "title": profile.title,
            "content": profile.content,
        },
    }

    root_task = build_root_task(scan_config)
    scope_context = build_scope_context(scan_config)

    assert "Target Profile:" in root_task
    assert "DVWA High Profile" in root_task
    assert scope_context["target_profile"]["name"] == "dvwa_high"
    assert "security=high" in scope_context["target_profile"]["content"]


def test_agent_prompt_includes_target_profile(monkeypatch):
    from strix.agents import factory

    profile = load_target_profile("dvwa_high")
    assert profile is not None
    monkeypatch.setattr(
        factory,
        "load_settings",
        lambda: SimpleNamespace(integrations=SimpleNamespace(perplexity_api_key="")),
    )

    agent = factory.build_strix_agent(
        is_root=True,
        chat_completions_tools=True,
        system_prompt_context={
            "scope_source": "test",
            "authorization_source": "test",
            "authorized_targets": [{"type": "web_application", "value": "http://target.local"}],
            "target_profile": {
                "name": profile.name,
                "title": profile.title,
                "content": profile.content,
            },
        },
    )

    assert "TARGET PROFILE:" in agent.instructions
    assert "DVWA High Profile" in agent.instructions
    assert "security=high" in agent.instructions


def test_node3_normalize_task_preserves_explicit_profile():
    class FakeConfig:
        scan_mode = "quick"

    task = node3_main.normalize_task(
        {
            "conversation_id": "conv-1",
            "target": {"value": "http://target.local"},
            "target_profile": "juice_shop",
        },
        FakeConfig(),
    )

    assert task["target_profile"] == "juice_shop"


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


def test_agent_hides_web_search_without_perplexity_key(monkeypatch):
    from strix.agents import factory

    monkeypatch.setattr(
        factory,
        "load_settings",
        lambda: SimpleNamespace(integrations=SimpleNamespace(perplexity_api_key="")),
    )

    agent = factory.build_strix_agent(is_root=True, chat_completions_tools=True)
    tool_names = {tool.name for tool in agent.tools}

    assert "web_search" not in tool_names
    assert "do not call web_search" in agent.instructions


def test_agent_includes_web_search_with_perplexity_key(monkeypatch):
    from strix.agents import factory

    monkeypatch.setattr(
        factory,
        "load_settings",
        lambda: SimpleNamespace(integrations=SimpleNamespace(perplexity_api_key="pplx-key")),
    )

    agent = factory.build_strix_agent(is_root=True, chat_completions_tools=True)
    tool_names = {tool.name for tool in agent.tools}

    assert "web_search" in tool_names
    assert "with the web_search tool" in agent.instructions


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


def test_stopped_agent_pending_messages_do_not_block_finish_gate():
    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        await coordinator.register("child", "child", "root")
        await coordinator.request_stop("child")
        coordinator.pending_counts["child"] = 5

        return await coordinator.unresolved_agents_except("root")

    assert asyncio.run(run()) == []


def test_request_stop_clears_pending_messages_and_rejects_late_sends():
    class FakeSession:
        def __init__(self):
            self.items = []

        async def add_items(self, items):
            self.items.extend(items)

    async def run():
        coordinator = AgentCoordinator()
        session = FakeSession()
        await coordinator.register("root", "root", None)
        await coordinator.register("child", "child", "root")
        await coordinator.attach_runtime("child", session=session)
        coordinator.pending_counts["child"] = 4

        await coordinator.request_stop("child")
        delivered = await coordinator.send("child", {"from": "root", "content": "wrap up"})

        return delivered, coordinator.pending_counts["child"], session.items

    delivered, pending_count, items = asyncio.run(run())

    assert delivered is False
    assert pending_count == 0
    assert items == []


def test_running_agent_pending_messages_still_block_finish_gate():
    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        await coordinator.register("child", "child", "root")
        coordinator.pending_counts["child"] = 2

        return await coordinator.unresolved_agents_except("root")

    unresolved = asyncio.run(run())

    assert unresolved == [{
        "agent_id": "child",
        "name": "child",
        "status": "running",
        "parent_id": "root",
        "pending_count": 2,
    }]


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


def test_reporting_shim_accepts_cvss_short_keys(monkeypatch):
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
        return {"is_duplicate": False}

    monkeypatch.setattr("strix.report.dedupe.check_duplicate", fake_check_duplicate)
    monkeypatch.setattr("strix.report.state.get_global_report_state", lambda: state)

    result = asyncio.run(node3_tool._do_create(
        title="Command Injection",
        description="Remote command execution is confirmed.",
        impact="An attacker can execute arbitrary commands.",
        target="http://target.local",
        technical_analysis="The endpoint passes user input to a shell.",
        poc_description="Send the payload and observe command output.",
        poc_script_code="print('poc')",
        remediation_steps="Avoid shell invocation and validate input.",
        cvss_breakdown={"AV": "N", "AC": "L", "PR": "N", "UI": "N", "S": "U", "C": "H", "I": "H", "A": "H", "score": "9.8"},
        endpoint="/run",
        method="POST",
        cve=None,
        cwe="CWE-78",
        code_locations=None,
    ))

    assert result["success"] is True
    assert result["cvss_score"] == 9.8
    assert state.reports[0]["cvss_breakdown"]["attack_vector"] == "N"


def test_reporting_shim_accepts_cvss_vector_and_json_wrapper(monkeypatch):
    class FakeReportState:
        def __init__(self) -> None:
            self.reports: list[dict] = []

        def get_existing_vulnerabilities(self) -> list[dict]:
            return []

        def add_vulnerability_report(self, **kwargs):
            self.reports.append(kwargs)
            return f"vuln-{len(self.reports):04d}"

    state = FakeReportState()

    async def fake_check_duplicate(candidate, existing):
        return {"is_duplicate": False}

    monkeypatch.setattr("strix.report.dedupe.check_duplicate", fake_check_duplicate)
    monkeypatch.setattr("strix.report.state.get_global_report_state", lambda: state)

    base = {
        "title": "SQL Injection",
        "description": "SQL injection is confirmed.",
        "impact": "An attacker can read database contents.",
        "target": "http://target.local",
        "technical_analysis": "The endpoint concatenates SQL.",
        "poc_description": "Send a UNION payload.",
        "poc_script_code": "print('poc')",
        "remediation_steps": "Use prepared statements.",
        "endpoint": "/sqli",
        "method": "GET",
        "cve": None,
        "cwe": "CWE-89",
        "code_locations": None,
    }
    vector_result = asyncio.run(node3_tool._do_create(
        **base,
        cvss_breakdown='CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    ))
    wrapped_args = dict(base)
    wrapped_args["title"] = "SQL Injection 2"
    wrapped_result = asyncio.run(node3_tool._do_create(
        **wrapped_args,
        cvss_breakdown={"_json": '{"AV":"N","AC":"L","PR":"N","UI":"N","S":"U","C":"H","I":"H","A":"H"}'},
    ))

    assert vector_result["success"] is True
    assert wrapped_result["success"] is True
    assert [report["cvss"] for report in state.reports] == [9.8, 9.8]


def test_reporting_shim_duplicate_is_skipped_not_failed(monkeypatch):
    class FakeReportState:
        def get_existing_vulnerabilities(self) -> list[dict]:
            return [{"id": "vuln-0001", "title": "Existing SQLi"}]

    async def fake_check_duplicate(candidate, existing):
        return {
            "is_duplicate": True,
            "duplicate_id": "vuln-0001",
            "confidence": 0.99,
            "reason": "same endpoint and parameter",
        }

    monkeypatch.setattr("strix.report.dedupe.check_duplicate", fake_check_duplicate)
    monkeypatch.setattr("strix.report.state.get_global_report_state", lambda: FakeReportState())

    result = asyncio.run(node3_tool._do_create(
        title="Duplicate SQLi",
        description="SQL injection is confirmed.",
        impact="An attacker can read database contents.",
        target="http://target.local",
        technical_analysis="The endpoint concatenates SQL.",
        poc_description="Send a UNION payload.",
        poc_script_code="print('poc')",
        remediation_steps="Use prepared statements.",
        cvss_breakdown={"AV": "N", "AC": "L", "PR": "N", "UI": "N", "S": "U", "C": "H", "I": "H", "A": "H"},
        endpoint="/sqli",
        method="GET",
        cve=None,
        cwe="CWE-89",
        code_locations=None,
    ))

    assert result["success"] is True
    assert result["status"] == "skipped_duplicate"
    assert "Existing SQLi" in result["message"]


def test_tool_result_summary_includes_validation_errors():
    summary = tool_result_summary("create_vulnerability_report", {
        "success": False,
        "error": "Validation failed",
        "errors": ["Invalid attack_vector: None", "Invalid attack_complexity: None"],
    })

    assert "Validation failed" in summary
    assert "Invalid attack_vector" in summary


def test_tool_status_value_treats_duplicate_as_skipped():
    assert tool_status_value({"success": True, "status": "skipped_duplicate"}) == "skipped"
    assert tool_status_value({"success": False, "status": "skipped_duplicate"}) == "failed"


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
