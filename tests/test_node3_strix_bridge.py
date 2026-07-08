import asyncio
import importlib
import json
import sqlite3
import sys
from datetime import datetime, timedelta
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
    merge_agent_activity,
    notes_from_file,
    runtime_checkpoint,
    tool_status_value,
    tool_result_summary,
    todos_from_file,
    vulnerabilities_from_file,
)
from strix.platform.node_runner import StrixPlatformConversationSession, build_instruction, completion_gate_for_run, merge_task_context, send_runtime_checkpoint, stable_platform_run_name  # noqa: E402
from strix.core.inputs import build_root_task, build_scope_context  # noqa: E402
from agents.tool_context import ToolContext  # noqa: E402
from strix.core.agents import AgentCoordinator  # noqa: E402
from strix.tools.agents_graph import tools as agent_tools  # noqa: E402
from strix.tools.finish.tool import finish_scan  # noqa: E402
from strix.tools.todo import tools as todo_tools  # noqa: E402
from strix.tools.reporting import node3_tool  # noqa: E402
from strix.report.writer import write_vulnerabilities  # noqa: E402
import main as node3_main  # noqa: E402


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, payload: str) -> None:
        self.sent.append(json.loads(payload))


def write_closed_hypothesis(
    state_dir: Path,
    *,
    hypothesis_id: str = "hyp-1",
    coverage_id: str = "cov-1",
    evidence_id: str = "ev-1",
    endpoint: str = "GET http://target.local/",
    vuln_type: str = "baseline",
    phase: str | None = None,
) -> None:
    item = {
        "hypothesis_id": hypothesis_id,
        "endpoint": endpoint,
        "parameter": "<none>",
        "vuln_type": vuln_type,
        "status": "tested",
        "hypothesis": f"{endpoint} should be checked for {vuln_type}",
        "test_strategy": "Execute the relevant test and compare evidence-backed behavior.",
        "evidence_ids": [evidence_id],
        "coverage_ids": [coverage_id],
        "created_at": "2026-07-08T00:00:00+00:00",
        "updated_at": "2026-07-08T00:00:01+00:00",
    }
    if phase:
        item["phase"] = phase
    (state_dir / "hypotheses.json").write_text(json.dumps([item]), encoding="utf-8")


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


def test_bridge_emits_referenced_memory_evidence_before_finding(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    async def run_bridge():
        state_dir = tmp_path / ".state"
        state_dir.mkdir()
        memory_tools.hydrate_memory_from_disk(state_dir)
        evidence_ctx = ToolContext(
            context={"agent_id": "validator", "state_dir": str(state_dir)},
            tool_name="record_evidence",
            tool_call_id="call-1",
            tool_arguments="{}",
        )
        evidence_id = json.loads(await memory_tools.record_evidence.on_invoke_tool(
            evidence_ctx,
            json.dumps({
                "evidence_type": "http_trace",
                "summary": "Validator reproduced SQL injection",
                "target": "http://target.local/search",
            }),
        ))["evidence_id"]

        ws = FakeWebSocket()
        task = {
            "task_id": "task-1",
            "conversation_id": "conv-1",
            "target": {"value": "http://target.local"},
            "scope": {},
            "snapshot": {},
        }
        bridge = PlatformEventSink(ws, task)
        bridge.set_run_context("run-1", str(tmp_path))
        pump = asyncio.create_task(bridge.pump())
        bridge.vulnerability_found({
            "id": "vuln-0001",
            "title": "SQL Injection",
            "severity": "high",
            "target": "http://target.local",
            "endpoint": "/search",
            "description": "Confirmed SQL injection.",
            "impact": "Data exposure.",
            "remediation_steps": "Use prepared statements.",
            "evidence_ids": [evidence_id],
            "validation_agent_id": "validator",
            "validation_evidence_ids": [evidence_id],
            "agent_id": "root",
        })
        await bridge.close()
        await pump
        return ws.sent, evidence_id

    sent, evidence_id = asyncio.run(run_bridge())
    evidence_messages = [message for message in sent if message["type"] == "evidence_created"]
    assert evidence_messages[0]["evidence_id"].startswith("strix-task-1-vuln-0001")
    assert evidence_messages[1]["evidence_id"] == evidence_id
    assert evidence_messages[1]["summary"] == "Validator reproduced SQL injection"
    assert sent[-1]["type"] == "vuln_found"
    assert sent[-1]["evidence_ids"] == [evidence_id]
    assert sent[-1]["validation_agent_id"] == "validator"
    assert sent[-1]["validation_evidence_ids"] == [evidence_id]


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


def test_bridge_forwards_agent_progress_text_by_default(monkeypatch):
    monkeypatch.delenv("NODE3_FORWARD_STRIX_MESSAGES", raising=False)

    class MessageItem:
        type = "message_output_item"
        raw_item = SimpleNamespace(content=[SimpleNamespace(text="I am mapping the application before testing endpoints.")])

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
        bridge.sdk_event("agent-1", Event(MessageItem()))
        await bridge.close()
        await pump
        return ws.sent

    sent = asyncio.run(run_bridge())

    assert [message["type"] for message in sent] == ["text"]
    assert sent[0]["content"]["text"] == "I am mapping the application before testing endpoints."
    assert sent[0]["content"]["metadata"] == {"agent_id": "agent-1"}


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


def test_tool_failure_does_not_mark_agent_failed():
    task = {
        "task_id": "task-1",
        "conversation_id": "conv-1",
        "target": {"value": "http://target.local"},
        "scope": {},
        "snapshot": {},
    }
    bridge = PlatformEventSink(FakeWebSocket(), task)

    bridge.update_agent_activity(
        "agent-1",
        "create_vulnerability_report",
        {"title": "SQL Injection"},
        "failed",
        {"success": False, "error": "Validation failed"},
    )

    agent = bridge.agents_by_id["agent-1"]
    assert agent["status"] == "running"
    assert agent["current_tool"] == "create_vulnerability_report"
    assert "Validation failed" in agent["current_action"]

    bridge.update_agent_activity(
        "agent-1",
        "agent_finish",
        {},
        "done",
        {"success": True, "summary": "validated login endpoint"},
    )

    assert bridge.agents_by_id["agent-1"]["status"] == "completed"


def test_merge_agent_activity_ignores_fallback_failed_status_for_running_snapshot():
    merged = merge_agent_activity(
        [{
            "id": "agent-1",
            "name": "SQL Agent",
            "status": "running",
            "current_tool": "",
            "current_action": "Starting task",
        }],
        [{
            "id": "agent-1",
            "status": "failed",
            "current_tool": "create_vulnerability_report",
            "current_action": "Reporting finding failed: Validation failed",
        }],
    )

    assert merged[0]["status"] == "running"
    assert merged[0]["current_tool"] == "create_vulnerability_report"
    assert "Validation failed" in merged[0]["current_action"]


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
                "started_at": "2026-07-06T10:01:00Z",
                "linked_agent_id": "child",
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
    assert node3["todos"][0]["started_at"] == "2026-07-06T10:01:00Z"
    assert node3["todos"][0]["linked_agent_id"] == "child"
    assert node3["notes"][0]["category"] == "findings"
    assert node3["vulnerabilities"][0]["endpoint"] == "/login.php"
    assert node3["vulnerabilities"][0]["technical_analysis"] == "Input is concatenated into SQL."


def test_runtime_checkpoint_includes_bound_todo_metadata(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "agents.json").write_text(json.dumps({
        "statuses": {"root": "running", "child": "running"},
        "parent_of": {"root": None, "child": "root"},
        "names": {"root": "strix", "child": "SQL Injection Specialist"},
    }), encoding="utf-8")
    (state_dir / "todos.json").write_text(json.dumps({
        "root": {
            "phase-1": {
                "title": "Phase 1: Validation",
                "priority": "high",
                "status": "in_progress",
                "created_at": "2026-07-06T09:59:00Z",
                "updated_at": "2026-07-06T10:01:00Z",
                "started_at": "2026-07-06T10:01:00Z",
            },
            "todo-1": {
                "title": "Validate child task",
                "priority": "normal",
                "status": "in_progress",
                "created_at": "2026-07-06T10:00:00Z",
                "updated_at": "2026-07-06T10:01:00Z",
                "started_at": "2026-07-06T10:01:00Z",
                "linked_agent_id": "child",
                "parent_todo_id": "phase-1",
                "resolution_reason": "Agent ended with status stopped",
            },
        },
        "child": {
            "todo-2": {
                "title": "Test POST /login for SQLi",
                "priority": "high",
                "status": "in_progress",
                "created_at": "2026-07-06T10:00:30Z",
                "updated_at": "2026-07-06T10:01:30Z",
                "started_at": "2026-07-06T10:01:30Z",
            },
        },
    }), encoding="utf-8")
    task = {"task_id": "task-1", "conversation_id": "conv-1"}

    payload = runtime_checkpoint(task, "run-1", str(tmp_path))

    todos = payload["checkpoint"]["node3_strix"]["todos"]
    assert [todo["id"] for todo in todos] == ["phase-1"]
    assert todos[0]["status"] == "running"
    assert todos[0]["started_at"] == "2026-07-06T10:01:00Z"


def test_checkpoint_keeps_explicit_agent_bound_top_level_todo(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "todos.json").write_text(json.dumps({
        "root": {
            "todo-1": {
                "title": "Validate child task",
                "priority": "normal",
                "status": "in_progress",
                "created_at": "2026-07-06T10:00:00Z",
                "updated_at": "2026-07-06T10:01:00Z",
                "started_at": "2026-07-06T10:01:00Z",
                "linked_agent_id": "child",
            },
        },
    }), encoding="utf-8")

    todos = todos_from_file(state_dir / "todos.json")

    assert len(todos) == 1
    assert todos[0]["id"] == "todo-1"
    assert todos[0]["linked_agent_id"] == "child"


def test_runtime_checkpoint_reconciles_stale_bound_todo_status(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "agents.json").write_text(json.dumps({
        "statuses": {"root": "waiting", "child": "stopped"},
        "parent_of": {"root": None, "child": "root"},
        "names": {"root": "strix", "child": "Validation Agent"},
    }), encoding="utf-8")
    (state_dir / "todos.json").write_text(json.dumps({
        "root": {
            "todo-1": {
                "title": "Validate child task",
                "priority": "normal",
                "status": "in_progress",
                "linked_agent_id": "child",
            },
        },
    }), encoding="utf-8")
    task = {"task_id": "task-1", "conversation_id": "conv-1"}

    payload = runtime_checkpoint(task, "run-1", str(tmp_path))

    assert payload["checkpoint"]["node3_strix"].get("todos", []) == []
    persisted = json.loads((state_dir / "todos.json").read_text(encoding="utf-8"))
    assert persisted["root"]["todo-1"]["status"] == "skipped"
    assert persisted["root"]["todo-1"]["resolution_reason"] == "Agent ended with status stopped"


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


def test_platform_session_interrupt_cancels_run_and_marks_interrupted(tmp_path):
    class FakeConfig:
        pass

    class FakeReportState:
        vulnerability_reports = []

        def __init__(self):
            self.cleaned_status = None

        def get_run_dir(self):
            return tmp_path

        def cleanup(self, status="stopped"):
            self.cleaned_status = status
            (tmp_path / "run.json").write_text(json.dumps({
                "run_id": "run-1",
                "run_name": "run-1",
                "status": status,
                "start_time": "2026-07-07T07:39:05Z",
                "end_time": "2026-07-07T08:15:20Z",
                "scan_mode": "quick",
                "targets_info": [],
                "llm_usage": {},
            }), encoding="utf-8")

    async def run():
        ws = FakeWebSocket()
        session = StrixPlatformConversationSession(
            ws,
            {"task_id": "task-1", "conversation_id": "conv-1", "scan_mode": "quick"},
            FakeConfig(),
        )
        report_state = FakeReportState()
        session.report_state = report_state
        session.run_name = "run-1"
        session.run_dir = str(tmp_path)
        session.sink.set_run_context("run-1", str(tmp_path))
        await session.coordinator.register("root", "root", None)
        session.run_task = asyncio.create_task(asyncio.sleep(60))
        await session.interrupt("user clicked stop")
        return ws.sent, report_state.cleaned_status, session.run_task.done()

    sent, cleaned_status, task_done = asyncio.run(run())

    assert cleaned_status == "interrupted"
    assert task_done is True
    assert any(message["type"] == "checkpoint_update" for message in sent)
    completion = next(message for message in sent if message["type"] == "task_complete")
    assert completion["status"] == "interrupted"
    assert json.loads((tmp_path / "run.json").read_text(encoding="utf-8"))["status"] == "interrupted"


def test_stable_platform_run_name_is_deterministic():
    conversation_id = "8e4c637b-8431-48c8-b021-a9ece4c58c4d"

    assert stable_platform_run_name(conversation_id) == "conversation-8e4c637b-8431-48c8-b021-a9ece4c58c4d"
    assert stable_platform_run_name(conversation_id) == stable_platform_run_name(conversation_id.upper())
    assert stable_platform_run_name("") == "conversation-session"


def test_build_instruction_uses_coverage_first_default():
    instruction = build_instruction({"instruction": "Test http://target.local/"})
    legacy_instruction = node3_main.build_instruction({"instruction": "Test http://target.local/"})

    assert "coverage-first mode" in instruction
    assert "coverage-first mode" in legacy_instruction
    assert "benchmark-friendly" not in instruction
    assert "benchmark-friendly" not in legacy_instruction
    assert "prioritize confirmed" not in instruction
    assert "prioritize confirmed" not in legacy_instruction


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


def test_platform_session_detects_completed_run_record(tmp_path):
    run_record = {
        "run_id": "conversation-conv-1",
        "run_name": "conversation-conv-1",
        "status": "completed",
        "end_time": "2026-07-07T09:32:49Z",
        "scan_results": {
            "scan_completed": True,
            "executive_summary": "Summary",
            "methodology": "Methodology",
            "technical_analysis": "Technical analysis",
            "recommendations": "Recommendations",
        },
    }
    (tmp_path / "run.json").write_text(json.dumps(run_record), encoding="utf-8")

    class FakeConfig:
        pass

    class FakeReportState:
        vulnerability_reports = []
        run_record = {"status": "running"}
        scan_results = None
        final_scan_result = None
        end_time = None

        def get_run_dir(self):
            return tmp_path

        def _format_final_scan_result(self, scan_results):
            return scan_results["executive_summary"]

    session = StrixPlatformConversationSession(
        FakeWebSocket(),
        {"task_id": "task-1", "conversation_id": "conv-1", "scan_mode": "quick"},
        FakeConfig(),
    )
    session.run_dir = str(tmp_path)
    session.report_state = FakeReportState()

    assert session._report_state_scan_completed() is True
    assert session.report_state.run_record["status"] == "completed"
    assert session.report_state.scan_results["scan_completed"] is True
    assert session.report_state.final_scan_result == "Summary"


def test_platform_session_marks_completion_incomplete_when_todos_unresolved(tmp_path):
    run_record = {
        "run_id": "conversation-conv-1",
        "run_name": "conversation-conv-1",
        "status": "completed",
        "end_time": "2026-07-07T09:32:49Z",
        "scan_results": {"scan_completed": True},
    }
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (tmp_path / "run.json").write_text(json.dumps(run_record), encoding="utf-8")
    (tmp_path / "penetration_test_report.md").write_text("Report", encoding="utf-8")
    (state_dir / "todos.json").write_text(json.dumps({
        "root": {
            "todo-1": {"title": "Done task", "status": "done", "priority": "normal"},
            "todo-2": {"title": "Pending auth checks", "status": "pending", "priority": "high"},
        },
    }), encoding="utf-8")

    class FakeConfig:
        pass

    class FakeReportState:
        vulnerability_reports = [{"title": "Finding"}]
        final_scan_result = "Report"

        def __init__(self):
            self.run_record = dict(run_record)

        def get_run_dir(self):
            return tmp_path

    async def run():
        ws = FakeWebSocket()
        session = StrixPlatformConversationSession(
            ws,
            {"task_id": "task-1", "conversation_id": "conv-1", "scan_mode": "quick"},
            FakeConfig(),
        )
        session.run_name = "conversation-conv-1"
        session.run_dir = str(tmp_path)
        session.report_state = FakeReportState()
        await session._on_scan_completed()
        return ws.sent

    sent = asyncio.run(run())
    completion = next(message for message in sent if message["type"] == "task_complete")
    checkpoint_message = next(message for message in sent if message["type"] == "checkpoint_update")

    assert completion["status"] == "incomplete"
    assert "Unresolved tasks: 1" in completion["summary"]
    assert "Pending auth checks" in completion["summary"]
    assert checkpoint_message["checkpoint"]["node3_strix"]["session"]["status"] == "scan_incomplete"


def test_completion_gate_requires_memory_ledgers(tmp_path):
    (tmp_path / "run.json").write_text(json.dumps({"status": "completed"}), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is False
    assert "no attack surface records" in gate["incomplete_reasons"]
    assert "no meaningful coverage records" in gate["incomplete_reasons"]


def test_completion_gate_blocks_caido_runs_until_sitemap_attempted(tmp_path):
    from strix.tools.workflow import initialize_workflow_state, mark_sitemap_attempt

    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    initialize_workflow_state(state_dir, caido_available=True)
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "url", "url": "http://target.local/", "method": "GET", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET http://target.local/", "vuln_type": "baseline", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    write_closed_hypothesis(state_dir, endpoint="GET http://target.local/", vuln_type="baseline")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Baseline response"},
    ]), encoding="utf-8")

    blocked = completion_gate_for_run(tmp_path)
    mark_sitemap_attempt(state_dir, success=False, error="empty sitemap")
    allowed = completion_gate_for_run(tmp_path)

    assert blocked["ok"] is False
    assert "Caido is available but list_sitemap has not been attempted" in blocked["incomplete_reasons"]
    assert allowed["ok"] is True
    assert allowed["workflow_state"]["sitemap_attempted"] is True


def test_completion_gate_passes_with_surface_coverage_and_evidence(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "auth_endpoint", "url": "http://target.local/login", "method": "POST", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "POST /login", "parameter": "username", "vuln_type": "sql_injection", "status": "passed", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    write_closed_hypothesis(
        state_dir,
        endpoint="POST /login",
        vuln_type="sql_injection",
    )
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "SQL error observed", "agent_id": "validator"},
    ]), encoding="utf-8")
    (state_dir / "agents.json").write_text(json.dumps({
        "statuses": {"root": "running", "validator": "completed"},
        "parent_of": {"root": None, "validator": "root"},
        "names": {"root": "strix", "validator": "SQL Validator"},
    }), encoding="utf-8")
    (tmp_path / "vulnerabilities.json").write_text(json.dumps([
        {
            "id": "vuln-1",
            "title": "SQLi",
            "severity": "high",
            "evidence_ids": ["ev-1"],
            "validation_agent_id": "validator",
            "validation_evidence_ids": ["ev-1"],
            "agent_id": "root",
        },
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is True
    assert gate["attack_surface_count"] == 1
    assert gate["meaningful_coverage_count"] == 1
    assert gate["evidence_count"] == 1
    assert gate["uncovered_attack_surface_count"] == 0


def test_completion_gate_rejects_uncovered_attack_surface(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "url", "url": "http://target.local/", "method": "GET", "evidence_ids": ["ev-1"]},
        {"surface_id": "as-2", "kind": "auth_endpoint", "url": "http://target.local/login", "method": "POST", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET http://target.local/", "vuln_type": "baseline", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Baseline response", "agent_id": "root"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is False
    assert "1 attack surface record(s) without coverage" in gate["incomplete_reasons"]
    assert gate["uncovered_attack_surface_count"] == 1
    assert gate["uncovered_attack_surfaces"][0]["surface_id"] == "as-2"


def test_completion_gate_rejects_surface_without_hypothesis_matrix(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "url", "url": "http://target.local/", "method": "GET", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET http://target.local/", "vuln_type": "baseline", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Baseline response", "agent_id": "root"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is False
    assert "no hypothesis/test-matrix records" in gate["incomplete_reasons"]
    assert gate["hypothesis_count"] == 0


def test_completion_gate_rejects_surface_without_linked_hypothesis(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "api_endpoint", "url": "http://target.local/api/users", "method": "GET", "evidence_ids": ["ev-1"]},
        {"surface_id": "as-2", "kind": "api_endpoint", "url": "http://target.local/api/orders", "method": "GET", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET /api/users", "vuln_type": "authorization", "status": "tried", "evidence_ids": ["ev-1"]},
        {"coverage_id": "cov-2", "endpoint": "GET /api/orders", "vuln_type": "authorization", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "hypotheses.json").write_text(json.dumps([
        {
            "hypothesis_id": "hyp-1",
            "surface_id": "as-1",
            "endpoint": "GET /api/users",
            "parameter": "<none>",
            "vuln_type": "authorization",
            "status": "tested",
            "hypothesis": "Users API should enforce authorization.",
            "test_strategy": "Request with a low-privilege token.",
            "evidence_ids": ["ev-1"],
            "coverage_ids": ["cov-1"],
        },
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "API responses"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is False
    assert "1 attack surface record(s) without hypothesis/test-matrix coverage" in gate["incomplete_reasons"]
    assert gate["surface_hypothesis_gap_count"] == 1
    assert gate["surface_hypothesis_gaps"][0]["surface_id"] == "as-2"


def test_completion_gate_rejects_coverage_without_hypothesis_link(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "api_endpoint", "url": "http://target.local/api/users", "method": "GET", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET /api/users", "vuln_type": "authorization", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "hypotheses.json").write_text(json.dumps([
        {
            "hypothesis_id": "hyp-1",
            "surface_id": "as-1",
            "endpoint": "GET /api/users",
            "parameter": "<none>",
            "vuln_type": "authorization",
            "status": "skipped",
            "hypothesis": "Users API should enforce authorization.",
            "test_strategy": "Request with a low-privilege token.",
            "notes": "Deferred to later batch.",
        },
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "API response"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is False
    assert "1 coverage record(s) not linked to a hypothesis/test-matrix item" in gate["incomplete_reasons"]
    assert gate["coverage_without_hypothesis_count"] == 1
    assert gate["coverage_without_hypothesis"][0]["coverage_id"] == "cov-1"


def test_completion_gate_rejects_unresolved_hypothesis_matrix_item(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "url", "url": "http://target.local/", "method": "GET", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "hypotheses.json").write_text(json.dumps([
        {
            "hypothesis_id": "hyp-1",
            "endpoint": "GET http://target.local/",
            "parameter": "<none>",
            "vuln_type": "baseline",
            "status": "planned",
            "hypothesis": "Root route should be tested.",
            "test_strategy": "Request root route and compare response.",
        },
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET http://target.local/", "vuln_type": "baseline", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Baseline response", "agent_id": "root"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is False
    assert "1 unresolved hypothesis/test-matrix item(s)" in gate["incomplete_reasons"]
    assert gate["hypothesis_gap_count"] == 1
    assert "hypothesis is still planned" in gate["hypothesis_gaps"][0]["problems"]


def test_completion_gate_ignores_out_of_scope_attack_surface_when_scope_known(tmp_path):
    from strix.tools.workflow import initialize_workflow_state

    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    initialize_workflow_state(
        state_dir,
        caido_available=False,
        authorized_targets=[{"type": "web_application", "value": "http://target.local"}],
    )
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "url", "url": "http://target.local/", "method": "GET", "evidence_ids": ["ev-1"]},
        {"surface_id": "as-2", "kind": "url", "url": "https://telemetry.example/status", "method": "GET", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET http://target.local/", "vuln_type": "baseline", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    write_closed_hypothesis(state_dir, endpoint="GET http://target.local/", vuln_type="baseline")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Baseline response", "agent_id": "root"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is True
    assert gate["uncovered_attack_surface_count"] == 0


def test_completion_gate_rejects_external_discovered_endpoint_missing_from_attack_surface(tmp_path):
    from strix.tools.workflow import record_external_discoveries

    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    record_external_discoveries(
        state_dir,
        source="caido_requests",
        discoveries=[
            {"method": "GET", "url": "http://target.local/api/Users", "path": "/api/Users"},
            {"method": "GET", "url": "http://target.local/api/Products", "path": "/api/Products"},
        ],
    )
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "api_endpoint", "url": "http://target.local/api/Users", "method": "GET", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET http://target.local/api/Users", "vuln_type": "authorization", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Baseline response"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is False
    assert "1 externally discovered endpoint(s) missing from attack surface" in gate["incomplete_reasons"]
    assert gate["external_discovery_gap_count"] == 1
    assert gate["external_discovery_gaps"][0]["url"] == "http://target.local/api/Products"


def test_external_discovery_filters_out_of_scope_hosts(tmp_path):
    from strix.tools.workflow import initialize_workflow_state, load_workflow_state, record_external_discoveries

    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    initialize_workflow_state(
        state_dir,
        caido_available=True,
        authorized_targets=[{"type": "web_application", "value": "http://target.local"}],
    )
    record_external_discoveries(
        state_dir,
        source="caido_sitemap",
        discoveries=[
            {"method": "GET", "url": "http://target.local/api/Users", "path": "/api/Users"},
            {"method": "GET", "url": "https://telemetry.example/log", "path": "/log"},
        ],
    )

    state = load_workflow_state(state_dir)

    assert state["external_discovery_count"] == 1
    assert state["external_discoveries"][0]["url"] == "http://target.local/api/Users"
    assert state["out_of_scope_external_discovery_count"] == 1
    assert state["out_of_scope_external_discoveries"] == {"telemetry.example": 1}


def test_create_agent_blocks_vulnerability_agent_until_external_inventory_is_recorded(tmp_path):
    from strix.tools.workflow import record_external_discoveries

    async def run():
        state_dir = tmp_path / ".state"
        state_dir.mkdir()
        record_external_discoveries(
            state_dir,
            source="caido_sitemap",
            discoveries=[
                {"method": "GET", "url": "http://target.local/api/Users", "path": "/api/Users"},
                {"method": "GET", "url": "http://target.local/api/Products", "path": "/api/Products"},
            ],
        )
        (state_dir / "attack_surface.json").write_text(json.dumps([
            {"surface_id": "as-1", "kind": "api_endpoint", "url": "http://target.local/api/Users", "method": "GET"},
        ]), encoding="utf-8")
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        todo_tools.hydrate_todos_from_disk(state_dir)

        async def spawner(**kwargs):
            await coordinator.register("child", kwargs["name"], kwargs["parent_ctx"]["agent_id"])
            return {"success": True, "agent_id": "child", "name": kwargs["name"]}

        ctx = ToolContext(
            context={
                "agent_id": "root",
                "parent_id": None,
                "state_dir": str(state_dir),
                "coordinator": coordinator,
                "spawn_child_agent": spawner,
            },
            tool_name="create_agent",
            tool_call_id="call-agent",
            tool_arguments="{}",
        )
        return json.loads(await agent_tools.create_agent.on_invoke_tool(
            ctx,
            json.dumps({"name": "SQLi Validator", "task": "Validate SQLi on /api/Users"}),
        ))

    blocked = asyncio.run(run())

    assert blocked["success"] is False
    assert "Workflow gate blocked create_agent" in blocked["error"]
    assert blocked["workflow_gate"]["reason"] == "Externally discovered endpoints have not been recorded in attack surface memory"
    assert blocked["workflow_gate"]["external_discovery_gaps"][0]["url"] == "http://target.local/api/Products"


def test_create_agent_allows_confirmed_coverage_followup_despite_external_inventory_gap(tmp_path):
    from strix.tools.workflow import record_external_discoveries

    async def run():
        state_dir = tmp_path / ".state"
        state_dir.mkdir()
        record_external_discoveries(
            state_dir,
            source="caido_sitemap",
            discoveries=[
                {"method": "GET", "url": "http://target.local/api/Users", "path": "/api/Users"},
                {"method": "GET", "url": "http://target.local/api/Products", "path": "/api/Products"},
            ],
        )
        (state_dir / "attack_surface.json").write_text(json.dumps([
            {"surface_id": "as-1", "kind": "api_endpoint", "url": "http://target.local/api/Users", "method": "GET"},
        ]), encoding="utf-8")
        (state_dir / "coverage.json").write_text(json.dumps([
            {
                "coverage_id": "cov-1",
                "endpoint": "GET http://target.local/api/Users",
                "parameter": "role",
                "vuln_type": "mass_assignment",
                "status": "passed",
                "result": "Mass assignment confirmed on role",
            },
        ]), encoding="utf-8")
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        todo_tools.hydrate_todos_from_disk(state_dir)

        async def spawner(**kwargs):
            await coordinator.register("child", kwargs["name"], kwargs["parent_ctx"]["agent_id"])
            return {"success": True, "agent_id": "child", "name": kwargs["name"]}

        ctx = ToolContext(
            context={
                "agent_id": "root",
                "parent_id": None,
                "state_dir": str(state_dir),
                "coordinator": coordinator,
                "spawn_child_agent": spawner,
            },
            tool_name="create_agent",
            tool_call_id="call-agent",
            tool_arguments="{}",
        )
        return json.loads(await agent_tools.create_agent.on_invoke_tool(
            ctx,
            json.dumps({
                "name": "Mass Assignment Validation Agent",
                "task": "Validate confirmed mass_assignment on GET /api/Users parameter role and record evidence",
            }),
        ))

    allowed = asyncio.run(run())

    assert allowed["success"] is True
    assert allowed["agent_id"] == "child"


def test_completion_gate_accepts_skipped_surface_with_reason(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "url", "url": "http://target.local/", "method": "GET", "evidence_ids": ["ev-1"]},
        {"surface_id": "as-2", "kind": "admin_endpoint", "url": "http://target.local/admin", "method": "GET", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET http://target.local/", "vuln_type": "baseline", "status": "tried", "evidence_ids": ["ev-1"]},
        {"coverage_id": "cov-2", "endpoint": "GET http://target.local/admin", "vuln_type": "access_control", "status": "skipped", "notes": "Out of scope for current role; admin credentials unavailable", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "hypotheses.json").write_text(json.dumps([
        {
            "hypothesis_id": "hyp-1",
            "endpoint": "GET http://target.local/",
            "parameter": "<none>",
            "vuln_type": "baseline",
            "status": "tested",
            "hypothesis": "Homepage baseline behavior should be checked.",
            "test_strategy": "Request homepage and compare response.",
            "evidence_ids": ["ev-1"],
            "coverage_ids": ["cov-1"],
        },
        {
            "hypothesis_id": "hyp-2",
            "endpoint": "GET http://target.local/admin",
            "parameter": "<none>",
            "vuln_type": "access_control",
            "status": "skipped",
            "hypothesis": "Admin endpoint may expose access-control issues.",
            "test_strategy": "Attempt role-based access checks when credentials are available.",
            "notes": "Out of scope for current role; admin credentials unavailable",
            "evidence_ids": ["ev-1"],
            "coverage_ids": ["cov-2"],
        },
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Baseline response"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is True
    assert gate["uncovered_attack_surface_count"] == 0
    assert gate["meaningful_coverage_count"] == 1


def test_completion_gate_matches_query_surface_to_path_coverage(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "api_endpoint", "url": "http://target.local/rest/products/search?q={keyword}", "method": "GET", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET /rest/products/search", "parameter": "q", "vuln_type": "sql_injection", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    write_closed_hypothesis(
        state_dir,
        endpoint="GET /rest/products/search",
        vuln_type="sql_injection",
    )
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Search SQLi proof"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is True
    assert gate["uncovered_attack_surface_count"] == 0


def test_completion_gate_rejects_confirmed_coverage_without_vulnerability_report(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "api_endpoint", "url": "http://target.local/rest/products/search", "method": "GET", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {
            "coverage_id": "cov-1",
            "endpoint": "GET /rest/products/search",
            "parameter": "q",
            "vuln_type": "sql_injection",
            "status": "passed",
            "evidence_ids": ["ev-1"],
            "result": "SQL injection confirmed",
        },
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Search SQLi proof"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is False
    assert "1 confirmed coverage record(s) without vulnerability report" in gate["incomplete_reasons"]
    assert gate["unreported_confirmed_coverage_count"] == 1
    assert gate["unreported_confirmed_coverage"][0]["coverage_id"] == "cov-1"


def test_completion_gate_matches_multi_method_coverage(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-0", "kind": "url", "url": "http://target.local/", "method": "GET", "evidence_ids": ["ev-1"]},
        {"surface_id": "as-1", "kind": "api_endpoint", "url": "http://target.local/socket.io/", "method": "GET", "evidence_ids": ["ev-1"]},
        {"surface_id": "as-2", "kind": "api_endpoint", "url": "http://target.local/socket.io/", "method": "POST", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-0", "endpoint": "GET http://target.local/", "parameter": "<none>", "vuln_type": "baseline", "status": "tried", "evidence_ids": ["ev-1"]},
        {"coverage_id": "cov-1", "endpoint": "GET /socket.io/, POST /socket.io/", "parameter": "<none>", "vuln_type": "websocket", "status": "skipped", "notes": "Socket.IO was identified but not tested in this run", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "hypotheses.json").write_text(json.dumps([
        {
            "hypothesis_id": "hyp-0",
            "endpoint": "GET http://target.local/",
            "parameter": "<none>",
            "vuln_type": "baseline",
            "status": "tested",
            "hypothesis": "Root route should be checked for baseline reachability.",
            "test_strategy": "Request root route and record response evidence.",
            "evidence_ids": ["ev-1"],
            "coverage_ids": ["cov-0"],
        },
        {
            "hypothesis_id": "hyp-1",
            "endpoint": "GET /socket.io/, POST /socket.io/",
            "parameter": "<none>",
            "vuln_type": "websocket",
            "status": "skipped",
            "hypothesis": "Socket.IO routes may expose websocket risks.",
            "test_strategy": "Inspect websocket handshake and authorization behavior.",
            "notes": "Socket.IO was identified but not tested in this run",
            "evidence_ids": ["ev-1"],
            "coverage_ids": ["cov-1"],
        },
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Socket.IO observed"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is True
    assert gate["uncovered_attack_surface_count"] == 0


def test_completion_gate_ignores_terminal_agent_orphan_todos(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "agents.json").write_text(json.dumps({
        "statuses": {"root": "waiting", "failed-child": "failed"},
        "parent_of": {"root": None, "failed-child": "root"},
        "names": {"root": "strix", "failed-child": "XSS Testing Agent"},
    }), encoding="utf-8")
    (state_dir / "todos.json").write_text(json.dumps({
        "failed-child": {
            "todo-1": {"title": "Legacy XSS task", "status": "pending", "priority": "high"},
        },
    }), encoding="utf-8")
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "url", "url": "http://target.local/", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET http://target.local/", "vuln_type": "baseline", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    write_closed_hypothesis(state_dir, endpoint="GET http://target.local/", vuln_type="baseline")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Baseline response"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is True
    assert gate["unfinished_count"] == 0
    assert gate["ignored_unfinished_count"] == 1
    assert gate["ignored_unfinished_todos"][0]["agent_id"] == "failed-child"
    assert "owner agent is failed" in gate["ignored_unfinished_todos"][0]["ignore_reason"]
    assert gate["completion_warnings"] == [
        "1 unresolved task(s) ignored because their owner agent is terminal"
    ]


def test_completion_gate_ignores_todos_bound_to_terminal_linked_agent(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "agents.json").write_text(json.dumps({
        "statuses": {"root": "waiting", "child": "stopped"},
        "parent_of": {"root": None, "child": "root"},
        "names": {"root": "strix", "child": "Validation Agent"},
    }), encoding="utf-8")
    (state_dir / "todos.json").write_text(json.dumps({
        "root": {
            "todo-1": {
                "title": "Validate endpoint",
                "status": "in_progress",
                "priority": "high",
                "linked_agent_id": "child",
            },
        },
    }), encoding="utf-8")
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "url", "url": "http://target.local/", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET http://target.local/", "vuln_type": "baseline", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    write_closed_hypothesis(state_dir, endpoint="GET http://target.local/", vuln_type="baseline")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Baseline response"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is True
    assert gate["unfinished_count"] == 0
    assert gate["ignored_unfinished_count"] == 1
    assert "linked agent is stopped" in gate["ignored_unfinished_todos"][0]["ignore_reason"]


def test_completion_gate_keeps_running_agent_todos_actionable(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "agents.json").write_text(json.dumps({
        "statuses": {"root": "waiting", "child": "running"},
        "parent_of": {"root": None, "child": "root"},
        "names": {"root": "strix", "child": "Auth Agent"},
    }), encoding="utf-8")
    (state_dir / "todos.json").write_text(json.dumps({
        "child": {
            "todo-1": {"title": "Validate endpoint", "status": "pending", "priority": "high"},
        },
    }), encoding="utf-8")
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "url", "url": "http://target.local/", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET http://target.local/", "vuln_type": "baseline", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Baseline response"},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is False
    assert gate["unfinished_count"] == 1
    assert gate["ignored_unfinished_count"] == 0
    assert gate["unfinished_todos"][0]["title"] == "Validate endpoint"


def test_completion_gate_reads_memory_from_sqlite_without_json_snapshots(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    memory_tools.hydrate_memory_from_disk(state_dir)
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="record_evidence",
        tool_call_id="call-1",
        tool_arguments="{}",
    )
    evidence = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx,
        json.dumps({"evidence_type": "http_trace", "summary": "Baseline response"}),
    )))
    evidence_id = evidence["evidence_id"]
    json.loads(asyncio.run(memory_tools.record_attack_surface.on_invoke_tool(
        ctx,
        json.dumps({"kind": "url", "url": "http://target.local/", "evidence_ids": [evidence_id]}),
    )))
    hypothesis = json.loads(asyncio.run(memory_tools.record_hypothesis.on_invoke_tool(
        ctx,
        json.dumps({
            "endpoint": "GET http://target.local/",
            "vuln_type": "baseline",
            "hypothesis": "Root route should be checked for baseline behavior.",
            "test_strategy": "Request root route and record response evidence.",
        }),
    )))
    json.loads(asyncio.run(memory_tools.record_coverage.on_invoke_tool(
        ctx,
        json.dumps({
            "endpoint": "GET http://target.local/",
            "vuln_type": "baseline",
            "status": "tried",
            "evidence_ids": [evidence_id],
            "hypothesis_id": hypothesis["hypothesis_id"],
        }),
    )))
    for filename in ("attack_surface.json", "hypotheses.json", "coverage.json", "evidence.json"):
        (state_dir / filename).unlink()

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is True
    assert gate["attack_surface_count"] == 1
    assert gate["hypothesis_count"] == 1
    assert gate["meaningful_coverage_count"] == 1
    assert gate["evidence_count"] == 1


def test_completion_gate_rejects_missing_finding_evidence(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "url", "url": "http://target.local/", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET http://target.local/", "parameter": "<none>", "vuln_type": "baseline", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Baseline response"},
    ]), encoding="utf-8")
    (tmp_path / "vulnerabilities.json").write_text(json.dumps([
        {"id": "vuln-1", "title": "Speculative SQLi", "severity": "high"},
        {"id": "vuln-2", "title": "Stored XSS", "severity": "high", "evidence_ids": ["ev-missing"]},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is False
    assert "1 finding(s) without evidence_ids" in gate["incomplete_reasons"]
    assert "1 missing evidence reference(s)" in gate["incomplete_reasons"]
    assert gate["missing_evidence_refs"] == ["ev-missing"]


def test_completion_gate_rejects_finding_without_independent_validation(tmp_path):
    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    (state_dir / "agents.json").write_text(json.dumps({
        "statuses": {"root": "running", "child": "completed"},
        "parent_of": {"root": None, "child": "root"},
        "names": {"root": "strix", "child": "SQL Validator"},
    }), encoding="utf-8")
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "url", "url": "http://target.local/", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "GET http://target.local/", "parameter": "<none>", "vuln_type": "baseline", "status": "tried", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "Baseline response"},
    ]), encoding="utf-8")
    (tmp_path / "vulnerabilities.json").write_text(json.dumps([
        {"id": "vuln-1", "title": "Root self-validated SQLi", "severity": "high", "evidence_ids": ["ev-1"], "validation_agent_id": "root", "validation_evidence_ids": ["ev-1"], "agent_id": "root"},
        {"id": "vuln-2", "title": "Missing validation", "severity": "high", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")

    gate = completion_gate_for_run(tmp_path)

    assert gate["ok"] is False
    assert "2 finding(s) without independent subagent validation" in gate["incomplete_reasons"]
    assert gate["invalid_vulnerability_validation_count"] == 2
    assert "validation_agent_id references root agent" in gate["invalid_vulnerability_validations"][0]["problems"]


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


def test_finish_scan_rejects_missing_memory_ledgers(monkeypatch, tmp_path):
    class FakeReportState:
        vulnerability_reports = []

        def get_run_dir(self):
            return tmp_path

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

    assert result["success"] is False
    assert result["scan_completed"] is False
    assert result["completion_gate"]["ok"] is False
    assert "no attack surface records" in result["completion_gate"]["incomplete_reasons"]
    assert statuses["root"] == "running"


def test_finish_scan_allows_completed_memory_ledgers(monkeypatch, tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    memory_tools.hydrate_memory_from_disk(state_dir)
    ctx_memory = ToolContext(
        context={"agent_id": "root"},
        tool_name="record_evidence",
        tool_call_id="call-memory",
        tool_arguments="{}",
    )
    evidence = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx_memory,
        json.dumps({"evidence_type": "http_trace", "summary": "Baseline response"}),
    )))
    evidence_id = evidence["evidence_id"]
    json.loads(asyncio.run(memory_tools.record_attack_surface.on_invoke_tool(
        ctx_memory,
        json.dumps({"kind": "url", "url": "http://target.local/", "evidence_ids": [evidence_id]}),
    )))
    hypothesis = json.loads(asyncio.run(memory_tools.record_hypothesis.on_invoke_tool(
        ctx_memory,
        json.dumps({
            "endpoint": "GET http://target.local/",
            "vuln_type": "baseline",
            "hypothesis": "Root route should be checked for baseline behavior.",
            "test_strategy": "Request root route and record response evidence.",
        }),
    )))
    json.loads(asyncio.run(memory_tools.record_coverage.on_invoke_tool(
        ctx_memory,
        json.dumps({
            "endpoint": "GET http://target.local/",
            "vuln_type": "baseline",
            "status": "tried",
            "evidence_ids": [evidence_id],
            "hypothesis_id": hypothesis["hypothesis_id"],
        }),
    )))

    class FakeReportState:
        vulnerability_reports = []

        def get_run_dir(self):
            return tmp_path

        def update_scan_final_fields(self, **kwargs):
            self.final_fields = kwargs

    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        todo_tools.hydrate_todos_from_disk(state_dir)
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
    assert result["scan_completed"] is True
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


def test_target_profile_is_not_injected_into_root_task_or_scope_context():
    scan_config = {
        "targets": [{
            "type": "web_application",
            "details": {"target_url": "http://host.docker.internal:8080"},
        }],
        "target_profile": {
            "name": "dvwa_high",
            "title": "DVWA High Profile",
            "content": "This stale profile content must not reach the agent.",
        },
    }

    root_task = build_root_task(scan_config)
    scope_context = build_scope_context(scan_config)

    assert "Target Profile:" not in root_task
    assert "DVWA High Profile" not in root_task
    assert "target_profile" not in scope_context


def test_agent_prompt_excludes_target_profile(monkeypatch):
    from strix.agents import factory

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
                "name": "dvwa_high",
                "title": "DVWA High Profile",
                "content": "This stale profile content must not reach the agent.",
            },
        },
    )

    assert "TARGET PROFILE:" not in agent.instructions
    assert "DVWA High Profile" not in agent.instructions
    assert "stale profile content" not in agent.instructions


def test_node3_normalize_task_drops_explicit_profile():
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

    assert "target_profile" not in task


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


def test_agent_prompt_names_exec_command_not_execute_command(monkeypatch):
    from strix.agents import factory

    monkeypatch.setattr(
        factory,
        "load_settings",
        lambda: SimpleNamespace(integrations=SimpleNamespace(perplexity_api_key="")),
    )

    agent = factory.build_strix_agent(is_root=False, chat_completions_tools=True)

    assert "The shell execution tool is named `exec_command`" in agent.instructions
    assert "`execute_command` tool. Never call `execute_command`." in agent.instructions
    assert "Do not call tools named `agent_browser` or `agent-browser`" in agent.instructions
    assert "record_attack_surface" in agent.instructions
    assert "record_evidence" in agent.instructions
    assert "record_hypothesis" in agent.instructions
    assert "record_coverage" in agent.instructions


def test_agent_prompt_requires_real_progress_text_with_tool_calls(monkeypatch):
    from strix.agents import factory

    monkeypatch.setattr(
        factory,
        "load_settings",
        lambda: SimpleNamespace(integrations=SimpleNamespace(perplexity_api_key="")),
    )

    agent = factory.build_strix_agent(is_root=True, chat_completions_tools=True)

    assert "meaningful phase starts" in agent.instructions
    assert "same assistant message" in agent.instructions
    assert "actual plan and current workflow state" in agent.instructions
    assert "not from the name or arguments of the tool" in agent.instructions


def test_agent_shell_capability_exposes_only_exec_command(monkeypatch):
    from strix.agents import factory

    monkeypatch.setattr(
        factory,
        "load_settings",
        lambda: SimpleNamespace(integrations=SimpleNamespace(perplexity_api_key="")),
    )

    class FakeSandboxSession:
        def supports_pty(self):
            return False

    agent = factory.build_strix_agent(is_root=False, chat_completions_tools=True)
    shell_capability = next(
        capability for capability in agent.capabilities if capability.type == "shell"
    )
    shell_capability.bind(FakeSandboxSession())

    tool_names = {tool.name for tool in shell_capability.tools()}

    assert "exec_command" in tool_names
    assert "execute_command" not in tool_names


def test_agent_exposes_memory_ledger_tools(monkeypatch):
    from strix.agents import factory

    monkeypatch.setattr(
        factory,
        "load_settings",
        lambda: SimpleNamespace(integrations=SimpleNamespace(perplexity_api_key="")),
    )

    agent = factory.build_strix_agent(is_root=False, chat_completions_tools=True)
    tool_names = {tool.name for tool in agent.tools}

    assert {"record_evidence", "record_attack_surface", "record_hypothesis", "record_coverage", "list_memory"} <= tool_names
    assert "agent_browser" in tool_names
    assert "agent-browser" in tool_names


def test_agent_browser_direct_tool_call_returns_recovery_instruction():
    from strix.tools.agent_browser.tool import agent_browser_cli

    result = json.loads(asyncio.run(agent_browser_cli.on_invoke_tool(
        ToolContext(
            context={},
            tool_name="agent-browser",
            tool_call_id="call-browser",
            tool_arguments="{}",
        ),
        json.dumps({"command": "open", "args": ["http://target.local"]}),
    )))

    assert result["success"] is False
    assert "not an SDK function tool" in result["error"]
    assert "exec_command" in result["next_step"]
    assert "agent-browser" in result["next_step"]


def test_failed_child_notifies_parent_to_stop_waiting():
    from strix.core.execution import _notify_parent_on_failure

    class FakeSession:
        def __init__(self) -> None:
            self.items: list[dict] = []

        async def add_items(self, items):
            self.items.extend(items)

        async def get_items(self):
            return list(self.items)

    async def run_case():
        coordinator = AgentCoordinator()
        parent_session = FakeSession()
        await coordinator.register("parent", "Parent Agent", None)
        await coordinator.register("child", "XSS Validation Agent", "parent")
        await coordinator.attach_runtime("parent", session=parent_session)

        await _notify_parent_on_failure(coordinator, "child", "failed")

        return coordinator, parent_session

    coordinator, parent_session = asyncio.run(run_case())

    assert coordinator.pending_counts["parent"] == 1
    assert len(parent_session.items) == 1
    content = parent_session.items[0]["content"]
    assert "type=failure" in content
    assert "[Agent failed]" in content
    assert "XSS Validation Agent" in content
    assert "retry the task with a new agent" in content


def test_list_sitemap_ignores_non_numeric_scope_id():
    from strix.tools.proxy import caido_api

    class FakeGraphQL:
        def __init__(self):
            self.variables = None

        async def query(self, _query, *, variables):
            self.variables = variables
            return {
                "sitemapRootEntries": {
                    "edges": [],
                    "count": {"value": 0},
                },
            }

    class FakeClient:
        def __init__(self):
            self.graphql = FakeGraphQL()

    client = FakeClient()

    result = asyncio.run(
        caido_api.list_sitemap_with_client(
            client,
            scope_id="http://host.docker.internal:3000",
        )
    )

    assert client.graphql.variables == {"scopeId": None}
    assert result["success"] is True
    assert "warning" in result


def test_list_sitemap_serializes_shared_graphql_client():
    from strix.tools.proxy import caido_api

    class FakeGraphQL:
        def __init__(self):
            self.active = 0
            self.max_active = 0

        async def query(self, _query, *, variables):
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            try:
                if self.active > 1:
                    raise AssertionError("concurrent GraphQL query on shared client")
                await asyncio.sleep(0.01)
                return {
                    "sitemapRootEntries": {
                        "edges": [],
                        "count": {"value": 0},
                    },
                }
            finally:
                self.active -= 1

    class FakeClient:
        def __init__(self):
            self.graphql = FakeGraphQL()

    async def run():
        client = FakeClient()
        results = await asyncio.gather(
            caido_api.list_sitemap_with_client(client),
            caido_api.list_sitemap_with_client(client),
        )
        return client.graphql.max_active, results

    max_active, results = asyncio.run(run())

    assert max_active == 1
    assert all(result["success"] is True for result in results)


def test_list_sitemap_records_workflow_attempt(monkeypatch, tmp_path):
    from strix.tools.proxy import tools as proxy_tools
    from strix.tools.workflow import initialize_workflow_state, load_workflow_state

    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    initialize_workflow_state(state_dir, caido_available=True)

    async def fake_list_sitemap_with_client(*_args, **_kwargs):
        return {
            "success": True,
            "entries": [
                {"id": "entry-1", "request": {"method": "GET", "path": "/api/Users", "status_code": 200}},
                {"id": "entry-2"},
            ],
        }

    monkeypatch.setattr(proxy_tools.caido_api, "list_sitemap_with_client", fake_list_sitemap_with_client)
    ctx = ToolContext(
        context={"agent_id": "root", "state_dir": str(state_dir), "caido_client": object()},
        tool_name="list_sitemap",
        tool_call_id="call-sitemap",
        tool_arguments="{}",
    )

    result = json.loads(asyncio.run(proxy_tools.list_sitemap.on_invoke_tool(ctx, json.dumps({}))))
    state = load_workflow_state(state_dir)

    assert result["success"] is True
    assert state["sitemap_attempted"] is True
    assert state["sitemap_success"] is True
    assert state["sitemap_entry_count"] == 2
    assert state["external_discovery_count"] == 1
    assert state["external_discoveries"][0]["path"] == "/api/Users"


def test_list_sitemap_records_discovery_with_parent_origin(monkeypatch, tmp_path):
    from strix.tools.proxy import tools as proxy_tools
    from strix.tools.workflow import initialize_workflow_state, load_workflow_state, sitemap_expansion_gaps_from_state

    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    initialize_workflow_state(
        state_dir,
        caido_available=True,
        authorized_targets=[{"type": "web_application", "value": "http://target.local:3000"}],
    )

    async def fake_list_sitemap_with_client(*_args, **kwargs):
        if kwargs.get("parent_id") == "domain-1":
            return {
                "success": True,
                "entries": [
                    {"id": "request-1", "kind": "REQUEST", "label": "Users", "has_descendants": False, "request": {"method": "GET", "path": "/api/Users", "status_code": 200}},
                    {"id": "request-2", "kind": "REQUEST", "label": "Telemetry", "has_descendants": False, "request": {"method": "GET", "path": "/log", "status_code": 200}},
                ],
            }
        return {
            "success": True,
            "entries": [
                {"id": "domain-1", "kind": "DOMAIN", "label": "target.local", "has_descendants": True, "metadata": {"port": 3000}},
                {"id": "domain-2", "kind": "DOMAIN", "label": "telemetry.example", "has_descendants": True},
            ],
        }

    monkeypatch.setattr(proxy_tools.caido_api, "list_sitemap_with_client", fake_list_sitemap_with_client)
    ctx = ToolContext(
        context={"agent_id": "root", "state_dir": str(state_dir), "caido_client": object()},
        tool_name="list_sitemap",
        tool_call_id="call-sitemap",
        tool_arguments="{}",
    )

    json.loads(asyncio.run(proxy_tools.list_sitemap.on_invoke_tool(ctx, json.dumps({}))))
    root_state = load_workflow_state(state_dir)
    assert [gap["id"] for gap in sitemap_expansion_gaps_from_state(root_state)] == ["domain-1"]

    json.loads(asyncio.run(proxy_tools.list_sitemap.on_invoke_tool(
        ctx,
        json.dumps({"parent_id": "domain-1", "depth": "ALL"}),
    )))
    state = load_workflow_state(state_dir)

    assert sitemap_expansion_gaps_from_state(state) == []
    assert state["external_discovery_count"] == 2
    assert {item["url"] for item in state["external_discoveries"]} == {
        "http://target.local:3000/api/Users",
        "http://target.local:3000/log",
    }


def test_list_sitemap_records_attempt_when_client_missing(tmp_path):
    from strix.tools.proxy import tools as proxy_tools
    from strix.tools.workflow import initialize_workflow_state, load_workflow_state

    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    initialize_workflow_state(state_dir, caido_available=True)
    ctx = ToolContext(
        context={"agent_id": "root", "state_dir": str(state_dir)},
        tool_name="list_sitemap",
        tool_call_id="call-sitemap",
        tool_arguments="{}",
    )

    result = json.loads(asyncio.run(proxy_tools.list_sitemap.on_invoke_tool(ctx, json.dumps({}))))
    state = load_workflow_state(state_dir)

    assert result["success"] is False
    assert state["sitemap_attempted"] is True
    assert state["sitemap_success"] is False
    assert "Caido client not available" in state["sitemap_error"]


def test_memory_tools_persist_attack_surface_coverage_and_evidence(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    memory_tools.hydrate_memory_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="record_evidence",
        tool_call_id="call-1",
        tool_arguments="{}",
    )

    evidence = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx,
        json.dumps({
            "evidence_type": "http_trace",
            "summary": "POST /login returned SQL error for quote payload",
            "content": "request/response",
            "source_tool": "exec_command",
            "target": "http://target.local/login",
        }),
    )))
    evidence_id = evidence["evidence_id"]
    surface = json.loads(asyncio.run(memory_tools.record_attack_surface.on_invoke_tool(
        ctx,
        json.dumps({
            "kind": "auth_endpoint",
            "url": "http://target.local/login",
            "method": "POST",
            "parameters": ["username", "password"],
            "auth_state": "anonymous",
            "evidence_ids": [evidence_id],
        }),
    )))
    coverage = json.loads(asyncio.run(memory_tools.record_coverage.on_invoke_tool(
        ctx,
        json.dumps({
            "endpoint": "POST http://target.local/login",
            "parameter": "username",
            "vuln_type": "sql_injection",
            "status": "passed",
            "evidence_ids": [evidence_id],
            "result": "SQL injection confirmed",
        }),
    )))

    assert surface["success"] is True
    assert coverage["success"] is True
    assert (tmp_path / "run_memory.db").exists()
    assert json.loads((tmp_path / "evidence.json").read_text(encoding="utf-8"))[0]["evidence_id"] == evidence_id
    assert json.loads((tmp_path / "attack_surface.json").read_text(encoding="utf-8"))[0]["parameters"] == ["username", "password"]
    assert json.loads((tmp_path / "coverage.json").read_text(encoding="utf-8"))[0]["evidence_ids"] == [evidence_id]
    with sqlite3.connect(tmp_path / "run_memory.db") as conn:
        assert conn.execute("SELECT COUNT(*) FROM evidence").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM attack_surface").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM coverage").fetchone()[0] == 1


def test_memory_tools_persist_hypothesis_and_close_with_coverage(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    memory_tools.hydrate_memory_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root", "state_dir": str(tmp_path)},
        tool_name="record_hypothesis",
        tool_call_id="call-hyp",
        tool_arguments="{}",
    )
    evidence = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx,
        json.dumps({
            "evidence_type": "http_trace",
            "summary": "Search request returned normal response for SQLi probe",
            "target": "GET http://target.local/rest/products/search?q=test",
            "phase": "Phase 3: Injection Testing",
        }),
    )))
    evidence_id = evidence["evidence_id"]
    hypothesis = json.loads(asyncio.run(memory_tools.record_hypothesis.on_invoke_tool(
        ctx,
        json.dumps({
            "endpoint": "GET http://target.local/rest/products/search",
            "method": "GET",
            "parameter": "q",
            "vuln_type": "sql_injection",
            "phase": "Phase 3: Injection Testing",
            "hypothesis": "Search query may be injectable because q is reflected into product search behavior.",
            "test_strategy": "Send error-based and boolean-differential probes and compare response bodies.",
            "risk_reason": "Successful injection could expose product or user data.",
        }),
    )))
    hypothesis_id = hypothesis["hypothesis_id"]
    coverage = json.loads(asyncio.run(memory_tools.record_coverage.on_invoke_tool(
        ctx,
        json.dumps({
            "endpoint": "GET http://target.local/rest/products/search",
            "parameter": "q",
            "vuln_type": "sql_injection",
            "status": "failed",
            "phase": "Phase 3: Injection Testing",
            "hypothesis_id": hypothesis_id,
            "evidence_ids": [evidence_id],
            "result": "SQLi probes did not alter query semantics.",
        }),
    )))
    gaps = json.loads(asyncio.run(memory_tools.list_memory.on_invoke_tool(
        ctx,
        json.dumps({"kind": "hypothesis_gaps"}),
    )))
    hypotheses = json.loads((tmp_path / "hypotheses.json").read_text(encoding="utf-8"))

    assert hypothesis["success"] is True
    assert coverage["success"] is True
    assert hypotheses[0]["status"] == "tested"
    assert hypotheses[0]["coverage_ids"] == [coverage["coverage"]["coverage_id"]]
    assert hypotheses[0]["evidence_ids"] == [evidence_id]
    assert gaps["total_count"] == 0
    with sqlite3.connect(tmp_path / "run_memory.db") as conn:
        assert conn.execute("SELECT COUNT(*) FROM hypotheses").fetchone()[0] == 1


def test_record_coverage_requires_evidence_for_meaningful_result(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    memory_tools.hydrate_memory_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root", "state_dir": str(tmp_path)},
        tool_name="record_coverage",
        tool_call_id="call-cov",
        tool_arguments="{}",
    )

    result = json.loads(asyncio.run(memory_tools.record_coverage.on_invoke_tool(
        ctx,
        json.dumps({
            "endpoint": "GET http://target.local/",
            "vuln_type": "baseline",
            "status": "failed",
            "result": "No issue observed",
        }),
    )))

    assert result["success"] is False
    assert "requires evidence_ids" in result["error"]


def test_record_attack_surface_skips_out_of_scope_targets(tmp_path):
    from strix.tools.run_memory import tools as memory_tools
    from strix.tools.workflow import initialize_workflow_state

    initialize_workflow_state(
        tmp_path,
        caido_available=False,
        authorized_targets=[{"type": "web_application", "value": "http://target.local"}],
    )
    memory_tools.hydrate_memory_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root", "state_dir": str(tmp_path)},
        tool_name="record_attack_surface",
        tool_call_id="call-1",
        tool_arguments="{}",
    )

    result = json.loads(asyncio.run(memory_tools.record_attack_surface.on_invoke_tool(
        ctx,
        json.dumps({
            "kind": "external_domain",
            "url": "https://telemetry.example/log",
            "method": "GET",
            "notes": "Observed in proxy traffic",
        }),
    )))

    assert result["success"] is True
    assert result["status"] == "skipped_out_of_scope"
    assert json.loads((tmp_path / "attack_surface.json").read_text(encoding="utf-8")) == []


def test_memory_tools_list_coverage_gaps(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    memory_tools.hydrate_memory_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root", "state_dir": str(tmp_path)},
        tool_name="record_attack_surface",
        tool_call_id="call-1",
        tool_arguments="{}",
    )
    surface = json.loads(asyncio.run(memory_tools.record_attack_surface.on_invoke_tool(
        ctx,
        json.dumps({
            "kind": "api_endpoint",
            "url": "http://target.local/api/users",
            "method": "GET",
        }),
    )))

    gaps = json.loads(asyncio.run(memory_tools.list_memory.on_invoke_tool(
        ctx,
        json.dumps({"kind": "coverage_gaps"}),
    )))
    summary = json.loads(asyncio.run(memory_tools.list_memory.on_invoke_tool(
        ctx,
        json.dumps({"kind": "summary"}),
    )))

    assert surface["success"] is True
    assert gaps["success"] is True
    assert gaps["total_count"] == 1
    assert gaps["items"][0]["surface_id"] == surface["surface"]["surface_id"]
    assert summary["uncovered_attack_surface_count"] == 1
    assert summary["coverage_gap_examples"][0]["url"] == "http://target.local/api/users"


def test_record_evidence_normalizes_alias_and_unknown_type(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    memory_tools.hydrate_memory_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="record_evidence",
        tool_call_id="call-1",
        tool_arguments="{}",
    )

    alias_result = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx,
        json.dumps({
            "evidence_type": "request_response",
            "summary": "Login request and response captured",
            "target": "http://target.local/login",
        }),
    )))
    url_type_result = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx,
        json.dumps({
            "evidence_type": "http://host.docker.internal:3000/rest/user/login",
            "summary": "Login endpoint observed",
        }),
    )))

    assert alias_result["success"] is True
    assert alias_result["evidence"]["evidence_type"] == "http_trace"
    assert alias_result["evidence"]["metadata"]["original_evidence_type"] == "request_response"
    assert url_type_result["success"] is True
    assert url_type_result["evidence"]["evidence_type"] == "other"
    assert url_type_result["evidence"]["target"] == "http://host.docker.internal:3000/rest/user/login"
    assert url_type_result["evidence"]["metadata"]["original_evidence_type"] == "http://host.docker.internal:3000/rest/user/login"


def test_memory_tools_normalize_attack_surface_kind_aliases(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    memory_tools.hydrate_memory_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="record_attack_surface",
        tool_call_id="call-1",
        tool_arguments="{}",
    )

    api_surface = json.loads(asyncio.run(memory_tools.record_attack_surface.on_invoke_tool(
        ctx,
        json.dumps({
            "kind": "api",
            "url": "http://target.local/rest/products/search?q=",
            "method": "GET",
        }),
    )))
    rest_surface = json.loads(asyncio.run(memory_tools.record_attack_surface.on_invoke_tool(
        ctx,
        json.dumps({
            "kind": "REST API endpoint",
            "url": "http://target.local/rest/user/login",
            "method": "POST",
        }),
    )))

    assert api_surface["success"] is True
    assert api_surface["surface"]["kind"] == "api_endpoint"
    assert api_surface["surface"]["original_kind"] == "api"
    assert rest_surface["success"] is True
    assert rest_surface["surface"]["kind"] == "api_endpoint"
    assert rest_surface["surface"]["original_kind"] == "REST API endpoint"


def test_memory_tools_deduplicate_attack_surface_in_sqlite_and_json(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    memory_tools.hydrate_memory_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="record_attack_surface",
        tool_call_id="call-1",
        tool_arguments="{}",
    )

    first = json.loads(asyncio.run(memory_tools.record_attack_surface.on_invoke_tool(
        ctx,
        json.dumps({
            "kind": "api_endpoint",
            "url": "http://target.local/rest/user/whoami",
            "method": "GET",
            "parameters": ["token"],
        }),
    )))
    second = json.loads(asyncio.run(memory_tools.record_attack_surface.on_invoke_tool(
        ctx,
        json.dumps({
            "kind": "api_endpoint",
            "url": "http://target.local/rest/user/whoami",
            "method": "GET",
            "parameters": ["Authorization"],
        }),
    )))

    rows = json.loads((tmp_path / "attack_surface.json").read_text(encoding="utf-8"))
    with sqlite3.connect(tmp_path / "run_memory.db") as conn:
        sqlite_count = conn.execute("SELECT COUNT(*) FROM attack_surface").fetchone()[0]

    assert first["status"] == "created"
    assert second["status"] == "updated"
    assert len(rows) == 1
    assert rows[0]["parameters"] == ["Authorization", "token"]
    assert sqlite_count == 1


def test_memory_tools_reject_unknown_evidence_ids(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    memory_tools.hydrate_memory_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="record_attack_surface",
        tool_call_id="call-1",
        tool_arguments="{}",
    )

    surface = json.loads(asyncio.run(memory_tools.record_attack_surface.on_invoke_tool(
        ctx,
        json.dumps({
            "kind": "url",
            "url": "http://target.local/",
            "evidence_ids": ["ev-missing"],
        }),
    )))
    coverage = json.loads(asyncio.run(memory_tools.record_coverage.on_invoke_tool(
        ctx,
        json.dumps({
            "endpoint": "GET http://target.local/",
            "vuln_type": "baseline",
            "status": "tried",
            "evidence_ids": ["ev-missing"],
        }),
    )))

    assert surface["success"] is False
    assert coverage["success"] is False
    assert surface["missing_evidence_ids"] == ["ev-missing"]
    assert coverage["missing_evidence_ids"] == ["ev-missing"]


def test_memory_tools_use_context_state_dir_to_avoid_cross_run_leakage(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    state_a = tmp_path / "run-a" / ".state"
    state_b = tmp_path / "run-b" / ".state"
    state_a.mkdir(parents=True)
    state_b.mkdir(parents=True)
    memory_tools.hydrate_memory_from_disk(state_a)
    memory_tools.hydrate_memory_from_disk(state_b)

    ctx_a = ToolContext(
        context={"agent_id": "root-a", "state_dir": str(state_a)},
        tool_name="record_evidence",
        tool_call_id="call-a",
        tool_arguments="{}",
    )
    ctx_b = ToolContext(
        context={"agent_id": "root-b", "state_dir": str(state_b)},
        tool_name="record_evidence",
        tool_call_id="call-b",
        tool_arguments="{}",
    )

    evidence_a = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx_a,
        json.dumps({"evidence_type": "http_trace", "summary": "Run A proof"}),
    )))["evidence_id"]
    evidence_b = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx_b,
        json.dumps({"evidence_type": "http_trace", "summary": "Run B proof"}),
    )))["evidence_id"]
    surface_a = json.loads(asyncio.run(memory_tools.record_attack_surface.on_invoke_tool(
        ctx_a,
        json.dumps({"kind": "url", "url": "http://run-a.local/", "evidence_ids": [evidence_a]}),
    )))
    coverage_b = json.loads(asyncio.run(memory_tools.record_coverage.on_invoke_tool(
        ctx_b,
        json.dumps({"endpoint": "GET http://run-b.local/", "vuln_type": "baseline", "status": "tried", "evidence_ids": [evidence_b]}),
    )))
    summary_a = json.loads(asyncio.run(memory_tools.list_memory.on_invoke_tool(
        ctx_a,
        json.dumps({"kind": "summary"}),
    )))
    summary_b = json.loads(asyncio.run(memory_tools.list_memory.on_invoke_tool(
        ctx_b,
        json.dumps({"kind": "summary"}),
    )))

    assert surface_a["success"] is True
    assert coverage_b["success"] is True
    assert summary_a["evidence_count"] == 1
    assert summary_a["attack_surface_count"] == 1
    assert summary_a["coverage_count"] == 0
    assert summary_b["evidence_count"] == 1
    assert summary_b["attack_surface_count"] == 0
    assert summary_b["coverage_count"] == 1
    assert json.loads((state_a / "evidence.json").read_text(encoding="utf-8"))[0]["evidence_id"] == evidence_a
    assert json.loads((state_b / "evidence.json").read_text(encoding="utf-8"))[0]["evidence_id"] == evidence_b


def test_runtime_checkpoint_includes_memory_ledgers(tmp_path):
    run_dir = tmp_path
    state_dir = run_dir / ".state"
    state_dir.mkdir()
    (state_dir / "attack_surface.json").write_text(json.dumps([
        {"surface_id": "as-1", "kind": "form", "url": "http://target.local/login", "method": "POST", "parameters": ["username"]},
    ]), encoding="utf-8")
    (state_dir / "coverage.json").write_text(json.dumps([
        {"coverage_id": "cov-1", "endpoint": "POST http://target.local/login", "parameter": "username", "vuln_type": "sql_injection", "status": "passed", "evidence_ids": ["ev-1"]},
    ]), encoding="utf-8")
    (state_dir / "hypotheses.json").write_text(json.dumps([
        {
            "hypothesis_id": "hyp-1",
            "endpoint": "POST http://target.local/login",
            "parameter": "username",
            "vuln_type": "sql_injection",
            "status": "tested",
            "hypothesis": "Login username may be injectable.",
            "test_strategy": "Send quote payload and inspect SQL error behavior.",
            "evidence_ids": ["ev-1"],
            "coverage_ids": ["cov-1"],
        },
    ]), encoding="utf-8")
    (state_dir / "evidence.json").write_text(json.dumps([
        {"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "SQL error observed"},
    ]), encoding="utf-8")

    event = runtime_checkpoint(
        {"conversation_id": "conv-1", "task_id": "task-1"},
        "run-1",
        str(run_dir),
    )
    node3_strix = event["checkpoint"]["node3_strix"]

    assert node3_strix["attack_surface"][0]["surface_id"] == "as-1"
    assert node3_strix["hypotheses"][0]["hypothesis_id"] == "hyp-1"
    assert node3_strix["coverage"][0]["coverage_id"] == "cov-1"
    assert node3_strix["evidence"][0]["evidence_id"] == "ev-1"


def test_runtime_checkpoint_reads_memory_from_sqlite_without_json_snapshots(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    run_dir = tmp_path
    state_dir = run_dir / ".state"
    state_dir.mkdir()
    memory_tools.hydrate_memory_from_disk(state_dir)
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="record_evidence",
        tool_call_id="call-1",
        tool_arguments="{}",
    )
    evidence = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx,
        json.dumps({"evidence_type": "http_trace", "summary": "Baseline response"}),
    )))
    evidence_id = evidence["evidence_id"]
    json.loads(asyncio.run(memory_tools.record_attack_surface.on_invoke_tool(
        ctx,
        json.dumps({"kind": "url", "url": "http://target.local/", "evidence_ids": [evidence_id]}),
    )))
    json.loads(asyncio.run(memory_tools.record_coverage.on_invoke_tool(
        ctx,
        json.dumps({"endpoint": "GET http://target.local/", "vuln_type": "baseline", "status": "tried", "evidence_ids": [evidence_id]}),
    )))
    for filename in ("attack_surface.json", "coverage.json", "evidence.json"):
        (state_dir / filename).unlink()

    event = runtime_checkpoint(
        {"conversation_id": "conv-1", "task_id": "task-1"},
        "run-1",
        str(run_dir),
    )
    node3_strix = event["checkpoint"]["node3_strix"]

    assert node3_strix["attack_surface"][0]["url"] == "http://target.local/"
    assert node3_strix["coverage"][0]["evidence_ids"] == [evidence_id]
    assert node3_strix["evidence"][0]["evidence_id"] == evidence_id


def test_vulnerability_markdown_renders_evidence_summary_from_sqlite(tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    run_dir = tmp_path
    state_dir = run_dir / ".state"
    state_dir.mkdir()
    memory_tools.hydrate_memory_from_disk(state_dir)
    ctx = ToolContext(
        context={"agent_id": "root", "state_dir": str(state_dir)},
        tool_name="record_evidence",
        tool_call_id="call-1",
        tool_arguments="{}",
    )
    evidence = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx,
        json.dumps({
            "evidence_type": "http_trace",
            "summary": "POST /login returned a database syntax error for a quote payload.",
            "content": "RAW_HTTP_TRACE_SHOULD_NOT_BE_RENDERED" * 20,
            "source_tool": "http_client",
            "target": "POST http://target.local/login",
        }),
    )))
    evidence_id = evidence["evidence_id"]
    for filename in ("attack_surface.json", "coverage.json", "evidence.json"):
        path = state_dir / filename
        if path.exists():
            path.unlink()

    write_vulnerabilities(
        run_dir,
        [
            {
                "id": "vuln-1",
                "title": "SQL Injection",
                "severity": "high",
                "timestamp": "2026-07-08T00:00:00Z",
                "description": "SQL injection is confirmed.",
                "evidence_ids": [evidence_id],
            },
        ],
        set(),
    )

    markdown = (run_dir / "vulnerabilities" / "vuln-1.md").read_text(encoding="utf-8")
    assert f"`{evidence_id}`" in markdown
    assert "http_trace" in markdown
    assert "http_client" in markdown
    assert "POST http://target.local/login" in markdown
    assert "POST /login returned a database syntax error" in markdown
    assert "RAW_HTTP_TRACE_SHOULD_NOT_BE_RENDERED" not in markdown


def test_vulnerability_markdown_marks_missing_evidence_reference(tmp_path):
    write_vulnerabilities(
        tmp_path,
        [
            {
                "id": "vuln-missing",
                "title": "Stored XSS",
                "severity": "medium",
                "timestamp": "2026-07-08T00:00:00Z",
                "description": "Stored XSS is suspected.",
                "evidence_ids": ["ev-missing"],
            },
        ],
        set(),
    )

    markdown = (tmp_path / "vulnerabilities" / "vuln-missing.md").read_text(encoding="utf-8")
    assert "`ev-missing` (not found in evidence ledger)" in markdown


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


def test_root_todo_rejects_generic_vuln_testing_and_preserves_details(tmp_path):
    todo_tools.hydrate_todos_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="create_todo",
        tool_call_id="call-1",
        tool_arguments="{}",
    )

    generic = json.loads(asyncio.run(todo_tools.create_todo.on_invoke_tool(
        ctx,
        json.dumps({"todos": [{"title": "Test SQL Injection", "priority": "high"}]}),
    )))
    detailed = json.loads(asyncio.run(todo_tools.create_todo.on_invoke_tool(
        ctx,
        json.dumps({"todos": [{
            "title": "Test SQL Injection on POST /login username",
            "priority": "high",
            "endpoint": "/login",
            "method": "POST",
            "parameter": "username",
            "vuln_type": "sql_injection",
            "auth_state": "anonymous",
        }]}),
    )))
    todo_id = detailed["created"][0]["todo_id"]
    update = json.loads(asyncio.run(todo_tools.update_todo.on_invoke_tool(
        ctx,
        json.dumps({"updates": [{"todo_id": todo_id, "surface_id": "as-1"}]}),
    )))
    projected = todos_from_file(tmp_path / "todos.json")

    assert generic["success"] is False
    assert "Root vulnerability-testing todos must include endpoint/detail fields" in generic["error"]
    assert detailed["success"] is True
    assert update["success"] is True
    assert projected[0]["surface_id"] == "as-1"
    assert projected[0]["endpoint"] == "/login"
    assert projected[0]["method"] == "POST"
    assert projected[0]["parameter"] == "username"
    assert projected[0]["vuln_type"] == "sql_injection"
    assert projected[0]["auth_state"] == "anonymous"


def test_todo_must_be_in_progress_before_done(tmp_path):
    todo_tools.hydrate_todos_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="create_todo",
        tool_call_id="call-1",
        tool_arguments="{}",
    )
    created_payload = json.loads(asyncio.run(todo_tools.create_todo.on_invoke_tool(
        ctx,
        json.dumps({"todos": [{"title": "Probe /login"}, {"title": "Probe /admin"}]}),
    )))
    first_id = created_payload["created"][0]["todo_id"]
    second_id = created_payload["created"][1]["todo_id"]

    direct_done = json.loads(asyncio.run(todo_tools.mark_todo_done.on_invoke_tool(
        ctx,
        json.dumps({"todo_ids": [first_id]}),
    )))
    assert direct_done["success"] is False
    assert "in_progress before it can be marked done" in direct_done["errors"][0]["error"]

    update_done = json.loads(asyncio.run(todo_tools.update_todo.on_invoke_tool(
        ctx,
        json.dumps({"updates": [{"todo_id": first_id, "status": "done"}]}),
    )))
    assert update_done["success"] is False
    assert "in_progress before it can be marked done" in update_done["errors"][0]["error"]

    started = json.loads(asyncio.run(todo_tools.update_todo.on_invoke_tool(
        ctx,
        json.dumps({"updates": [{"todo_id": first_id, "status": "in_progress"}]}),
    )))
    assert started["success"] is True

    mixed_done = json.loads(asyncio.run(todo_tools.mark_todo_done.on_invoke_tool(
        ctx,
        json.dumps({"todo_ids": [first_id, second_id]}),
    )))
    assert mixed_done["success"] is False
    assert mixed_done["marked"] == []
    assert "advanced one at a time" in mixed_done["errors"][0]["error"]

    persisted = json.loads((tmp_path / "todos.json").read_text(encoding="utf-8"))
    assert persisted["root"][first_id]["status"] == "in_progress"
    assert persisted["root"][first_id]["started_at"]
    assert not persisted["root"][first_id].get("completed_at")
    assert persisted["root"][second_id]["status"] == "pending"


def test_todo_order_stays_stable_when_status_changes(tmp_path):
    todo_tools.hydrate_todos_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="create_todo",
        tool_call_id="call-1",
        tool_arguments="{}",
    )
    created_payload = json.loads(asyncio.run(todo_tools.create_todo.on_invoke_tool(
        ctx,
        json.dumps({"todos": [
            {"title": "Phase 1: Recon", "priority": "normal"},
            {"title": "Phase 2: Testing", "priority": "critical"},
            {"title": "Phase 3: Reporting", "priority": "low"},
        ]}),
    )))
    ordered_ids = [item["todo_id"] for item in created_payload["created"]]

    asyncio.run(todo_tools.update_todo.on_invoke_tool(
        ctx,
        json.dumps({"updates": [{"todo_id": ordered_ids[1], "status": "in_progress"}]}),
    ))
    asyncio.run(todo_tools.mark_todo_done.on_invoke_tool(
        ctx,
        json.dumps({"todo_ids": [ordered_ids[1]]}),
    ))
    listed = json.loads(asyncio.run(todo_tools.list_todos.on_invoke_tool(
        ctx,
        json.dumps({}),
    )))
    projected = todos_from_file(tmp_path / "todos.json")

    assert [item["todo_id"] for item in listed["todos"]] == ordered_ids
    assert [item["id"] for item in projected] == ordered_ids
    assert listed["todos"][1]["status"] == "done"


def test_delete_todo_cannot_remove_unfinished_or_erase_history(tmp_path):
    todo_tools.hydrate_todos_from_disk(tmp_path)
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="create_todo",
        tool_call_id="call-1",
        tool_arguments="{}",
    )
    created_payload = json.loads(asyncio.run(todo_tools.create_todo.on_invoke_tool(
        ctx,
        json.dumps({"todos": [{"title": "Probe /login"}, {"title": "Probe /admin"}]}),
    )))
    first_id = created_payload["created"][0]["todo_id"]
    second_id = created_payload["created"][1]["todo_id"]

    blocked_delete = json.loads(asyncio.run(todo_tools.delete_todo.on_invoke_tool(
        ctx,
        json.dumps({"todo_ids": [first_id, second_id]}),
    )))
    assert blocked_delete["success"] is False
    assert blocked_delete["deleted"] == []
    assert blocked_delete["deleted_count"] == 0
    assert {error["todo_id"] for error in blocked_delete["errors"]} == {first_id, second_id}

    asyncio.run(todo_tools.update_todo.on_invoke_tool(
        ctx,
        json.dumps({"updates": [{"todo_id": first_id, "status": "in_progress"}]}),
    ))
    asyncio.run(todo_tools.mark_todo_done.on_invoke_tool(
        ctx,
        json.dumps({"todo_ids": [first_id]}),
    ))
    archived_delete = json.loads(asyncio.run(todo_tools.delete_todo.on_invoke_tool(
        ctx,
        json.dumps({"todo_ids": [first_id]}),
    )))
    assert archived_delete["success"] is True
    assert archived_delete["deleted"] == [first_id]
    assert archived_delete["archived"] == [first_id]

    persisted = json.loads((tmp_path / "todos.json").read_text(encoding="utf-8"))
    assert first_id in persisted["root"]
    assert persisted["root"][first_id]["status"] == "done"
    assert persisted["root"][first_id]["archived_at"]
    assert second_id in persisted["root"]
    assert persisted["root"][second_id]["status"] == "pending"


def test_bound_todo_helpers_complete_successful_child_task(tmp_path):
    todo_tools.hydrate_todos_from_disk(tmp_path)

    created = todo_tools.create_bound_todo(
        owner_agent_id="root",
        title="Validate endpoint",
        description="Run focused checks",
        priority="high",
        linked_agent_id="child",
    )
    assert created["status"] == "in_progress"
    assert created["linked_agent_id"] == "child"

    skipped = todo_tools.complete_bound_todos(linked_agent_id="child", success=False)
    assert skipped[0]["status"] == "failed"
    pending = json.loads((tmp_path / "todos.json").read_text(encoding="utf-8"))
    assert pending["root"][created["todo_id"]]["status"] == "failed"

    created_success = todo_tools.create_bound_todo(
        owner_agent_id="root",
        title="Validate second endpoint",
        description="Run focused checks",
        priority="high",
        linked_agent_id="child-success",
    )
    completed = todo_tools.complete_bound_todos(linked_agent_id="child-success", success=True)
    assert completed[0]["todo_id"] == created_success["todo_id"]
    persisted = json.loads((tmp_path / "todos.json").read_text(encoding="utf-8"))
    assert persisted["root"][created["todo_id"]]["status"] == "failed"
    assert persisted["root"][created_success["todo_id"]]["status"] == "done"
    assert persisted["root"][created_success["todo_id"]]["completed_at"]


def test_create_agent_enforces_recon_workflow_gate_for_root(tmp_path):
    from strix.tools.workflow import initialize_workflow_state, mark_sitemap_attempt

    async def run():
        state_dir = tmp_path / ".state"
        state_dir.mkdir()
        initialize_workflow_state(state_dir, caido_available=True)
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        todo_tools.hydrate_todos_from_disk(state_dir)
        spawned: list[str] = []

        async def spawner(**kwargs):
            child_id = f"child-{len(spawned) + 1}"
            spawned.append(kwargs["name"])
            await coordinator.register(child_id, kwargs["name"], kwargs["parent_ctx"]["agent_id"])
            return {"success": True, "agent_id": child_id, "name": kwargs["name"]}

        ctx = ToolContext(
            context={
                "agent_id": "root",
                "parent_id": None,
                "state_dir": str(state_dir),
                "coordinator": coordinator,
                "spawn_child_agent": spawner,
            },
            tool_name="create_agent",
            tool_call_id="call-agent",
            tool_arguments="{}",
        )
        blocked = json.loads(await agent_tools.create_agent.on_invoke_tool(
            ctx,
            json.dumps({"name": "XSS Agent", "task": "Validate XSS on /search"}),
        ))
        recon = json.loads(await agent_tools.create_agent.on_invoke_tool(
            ctx,
            json.dumps({"name": "Sitemap Mapper", "task": "Map sitemap and attack surface"}),
        ))
        mark_sitemap_attempt(state_dir, success=True, entry_count=1)
        (state_dir / "attack_surface.json").write_text(json.dumps([
            {"surface_id": "as-1", "kind": "url", "url": "http://target.local/search", "method": "GET"},
        ]), encoding="utf-8")
        allowed = json.loads(await agent_tools.create_agent.on_invoke_tool(
            ctx,
            json.dumps({"name": "XSS Agent", "task": "Validate XSS on /search"}),
        ))
        return blocked, recon, allowed, spawned

    blocked, recon, allowed, spawned = asyncio.run(run())

    assert blocked["success"] is False
    assert "Workflow gate blocked create_agent" in blocked["error"]
    assert blocked["workflow_gate"]["reason"] == "Caido is available but list_sitemap has not been attempted"
    assert recon["success"] is True
    assert allowed["success"] is True
    assert spawned == ["Sitemap Mapper", "XSS Agent"]


def test_create_agent_rejects_unbounded_vulnerability_task(tmp_path):
    async def run():
        state_dir = tmp_path / ".state"
        state_dir.mkdir()
        (state_dir / "attack_surface.json").write_text(json.dumps([
            {"surface_id": "as-1", "kind": "url", "url": "http://target.local/search", "method": "GET"},
        ]), encoding="utf-8")
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        todo_tools.hydrate_todos_from_disk(state_dir)
        spawned: list[str] = []

        async def spawner(**kwargs):
            child_id = f"child-{len(spawned) + 1}"
            spawned.append(kwargs["name"])
            await coordinator.register(child_id, kwargs["name"], kwargs["parent_ctx"]["agent_id"])
            return {"success": True, "agent_id": child_id, "name": kwargs["name"]}

        ctx = ToolContext(
            context={
                "agent_id": "root",
                "parent_id": None,
                "state_dir": str(state_dir),
                "coordinator": coordinator,
                "spawn_child_agent": spawner,
            },
            tool_name="create_agent",
            tool_call_id="call-agent",
            tool_arguments="{}",
        )
        blocked = json.loads(await agent_tools.create_agent.on_invoke_tool(
            ctx,
            json.dumps({
                "name": "XSS Agent",
                "task": "Validate XSS on /search and any other user input reflection points",
            }),
        ))
        allowed = json.loads(await agent_tools.create_agent.on_invoke_tool(
            ctx,
            json.dumps({"name": "XSS Agent", "task": "Validate XSS on /search"}),
        ))
        return blocked, allowed, spawned

    blocked, allowed, spawned = asyncio.run(run())

    assert blocked["success"] is False
    assert blocked["workflow_gate"]["reason"] == "Child testing task is too broad and can drift away from recorded attack surface"
    assert allowed["success"] is True
    assert spawned == ["XSS Agent"]


def test_create_agent_creates_bound_parent_todo(tmp_path):
    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        todo_tools.hydrate_todos_from_disk(tmp_path)

        async def spawner(**kwargs):
            await coordinator.register(
                "child",
                kwargs["name"],
                kwargs["parent_ctx"]["agent_id"],
                task=kwargs["task"],
                skills=kwargs["skills"],
            )
            return {"success": True, "agent_id": "child", "name": kwargs["name"]}

        ctx = ToolContext(
            context={"agent_id": "root", "coordinator": coordinator, "spawn_child_agent": spawner},
            tool_name="create_agent",
            tool_call_id="call-agent",
            tool_arguments="{}",
        )
        result = await agent_tools.create_agent.on_invoke_tool(
            ctx,
            json.dumps({
                "name": "XSS Agent",
                "task": "Validate XSS on /search",
                "skills": ["xss"],
                "task_priority": "high",
            }),
        )
        metadata = await coordinator.agent_metadata("child")
        return json.loads(result), metadata

    result, metadata = asyncio.run(run())

    assert result["success"] is True
    assert result["task_tracking"] == "created"
    assert result["todo_id"]
    assert metadata["assigned_todo_id"] == result["todo_id"]
    persisted = json.loads((tmp_path / "todos.json").read_text(encoding="utf-8"))
    todo = persisted["root"][result["todo_id"]]
    assert todo["title"] == "XSS Agent"
    assert todo["status"] == "in_progress"
    assert todo["linked_agent_id"] == "child"


def test_create_agent_links_auto_todo_to_single_active_phase(tmp_path):
    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        todo_tools.hydrate_todos_from_disk(tmp_path)
        todo_ctx = ToolContext(
            context={"agent_id": "root"},
            tool_name="create_todo",
            tool_call_id="call-todo",
            tool_arguments="{}",
        )
        created = await todo_tools.create_todo.on_invoke_tool(
            todo_ctx,
            json.dumps({"todos": [{"title": "Validation phase", "priority": "high"}]}),
        )
        phase_id = json.loads(created)["created"][0]["todo_id"]
        await todo_tools.update_todo.on_invoke_tool(
            todo_ctx,
            json.dumps({"updates": [{"todo_id": phase_id, "status": "in_progress"}]}),
        )

        async def spawner(**kwargs):
            await coordinator.register("child", kwargs["name"], "root")
            return {"success": True, "agent_id": "child", "name": kwargs["name"]}

        ctx = ToolContext(
            context={"agent_id": "root", "coordinator": coordinator, "spawn_child_agent": spawner},
            tool_name="create_agent",
            tool_call_id="call-agent",
            tool_arguments="{}",
        )
        result = await agent_tools.create_agent.on_invoke_tool(
            ctx,
            json.dumps({"name": "XSS Agent", "task": "Validate XSS on /search"}),
        )
        return json.loads(result), phase_id

    result, phase_id = asyncio.run(run())

    assert result["success"] is True
    child_todo_id = result["todo_id"]
    persisted = json.loads((tmp_path / "todos.json").read_text(encoding="utf-8"))
    assert persisted["root"][child_todo_id]["parent_todo_id"] == phase_id
    assert persisted["root"][phase_id]["status"] == "in_progress"


def test_root_top_level_todos_must_advance_one_phase_at_a_time(tmp_path):
    async def run():
        todo_tools.hydrate_todos_from_disk(tmp_path)
        ctx = ToolContext(
            context={"agent_id": "root", "parent_id": None},
            tool_name="create_todo",
            tool_call_id="call-todo",
            tool_arguments="{}",
        )
        created = json.loads(await todo_tools.create_todo.on_invoke_tool(
            ctx,
            json.dumps({"todos": [
                {"title": "Phase 1: Recon", "priority": "high"},
                {"title": "Phase 2: Injection", "priority": "high"},
                {"title": "Phase 3: Access Control", "priority": "high"},
            ]}),
        ))
        ids = [item["todo_id"] for item in created["created"]]
        bulk_start = json.loads(await todo_tools.update_todo.on_invoke_tool(
            ctx,
            json.dumps({"updates": [
                {"todo_id": ids[0], "status": "in_progress"},
                {"todo_id": ids[1], "status": "in_progress"},
            ]}),
        ))
        single_start = json.loads(await todo_tools.update_todo.on_invoke_tool(
            ctx,
            json.dumps({"updates": [{"todo_id": ids[0], "status": "in_progress"}]}),
        ))
        bulk_done = json.loads(await todo_tools.mark_todo_done.on_invoke_tool(
            ctx,
            json.dumps({"todo_ids": ids[:2]}),
        ))
        return bulk_start, single_start, bulk_done

    bulk_start, single_start, bulk_done = asyncio.run(run())

    assert bulk_start["success"] is False
    assert "advanced one at a time" in bulk_start["errors"][0]["error"]
    assert single_start["success"] is True
    assert bulk_done["success"] is False
    assert "advanced one at a time" in bulk_done["errors"][0]["error"]


def test_root_phase_done_requires_work_artifact_since_phase_start(tmp_path):
    async def run():
        state_dir = tmp_path / ".state"
        state_dir.mkdir()
        todo_tools.hydrate_todos_from_disk(state_dir)
        ctx = ToolContext(
            context={"agent_id": "root", "parent_id": None, "state_dir": str(state_dir)},
            tool_name="create_todo",
            tool_call_id="call-todo",
            tool_arguments="{}",
        )
        created = json.loads(await todo_tools.create_todo.on_invoke_tool(
            ctx,
            json.dumps({"todos": [{"title": "Phase 4: Access Control Testing", "priority": "high"}]}),
        ))
        todo_id = created["created"][0]["todo_id"]
        started = json.loads(await todo_tools.update_todo.on_invoke_tool(
            ctx,
            json.dumps({"updates": [{"todo_id": todo_id, "status": "in_progress"}]}),
        ))
        blocked = json.loads(await todo_tools.mark_todo_done.on_invoke_tool(
            ctx,
            json.dumps({"todo_ids": [todo_id]}),
        ))

        persisted = json.loads((state_dir / "todos.json").read_text(encoding="utf-8"))
        started_at = datetime.fromisoformat(
            persisted["root"][todo_id]["started_at"].replace("Z", "+00:00"),
        )
        artifact_at = (started_at + timedelta(seconds=1)).isoformat()
        (state_dir / "coverage.json").write_text(json.dumps([{
            "coverage_id": "cov-1",
            "endpoint": "GET /api/BasketItems",
            "vuln_type": "idor",
            "status": "passed",
            "result": "Authorization check tested with another account.",
            "phase": "Phase 4: Access Control Testing",
            "created_at": artifact_at,
            "updated_at": artifact_at,
        }]), encoding="utf-8")
        completed = json.loads(await todo_tools.mark_todo_done.on_invoke_tool(
            ctx,
            json.dumps({"todo_ids": [todo_id]}),
        ))
        return started, blocked, completed

    started, blocked, completed = asyncio.run(run())

    assert started["success"] is True
    assert blocked["success"] is False
    assert "without phase-linked work artifacts" in blocked["errors"][0]["error"]
    assert completed["success"] is True


def test_create_agent_binds_existing_parent_todo(tmp_path):
    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        todo_tools.hydrate_todos_from_disk(tmp_path)
        todo_ctx = ToolContext(
            context={"agent_id": "root"},
            tool_name="create_todo",
            tool_call_id="call-todo",
            tool_arguments="{}",
        )
        created = await todo_tools.create_todo.on_invoke_tool(
            todo_ctx,
            json.dumps({"todos": [{"title": "Existing task", "priority": "normal"}]}),
        )
        todo_id = json.loads(created)["created"][0]["todo_id"]

        async def spawner(**kwargs):
            await coordinator.register("child", kwargs["name"], "root")
            return {"success": True, "agent_id": "child", "name": kwargs["name"]}

        ctx = ToolContext(
            context={"agent_id": "root", "coordinator": coordinator, "spawn_child_agent": spawner},
            tool_name="create_agent",
            tool_call_id="call-agent",
            tool_arguments="{}",
        )
        result = await agent_tools.create_agent.on_invoke_tool(
            ctx,
            json.dumps({"name": "Existing Agent", "task": "Do existing work", "todo_id": todo_id}),
        )
        return json.loads(result), todo_id

    result, todo_id = asyncio.run(run())

    assert result["task_tracking"] == "bound"
    assert result["todo_id"] == todo_id
    persisted = json.loads((tmp_path / "todos.json").read_text(encoding="utf-8"))
    assert len(persisted["root"]) == 1
    assert persisted["root"][todo_id]["status"] == "in_progress"
    assert persisted["root"][todo_id]["linked_agent_id"] == "child"


def test_terminal_agent_status_resolves_bound_parent_todo(tmp_path):
    async def run():
        todo_tools.hydrate_todos_from_disk(tmp_path)
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        await coordinator.register("child", "child", "root")
        created = todo_tools.create_bound_todo(
            owner_agent_id="root",
            title="Child assignment",
            linked_agent_id="child",
        )
        await coordinator.set_status("child", "crashed")
        return created["todo_id"]

    todo_id = asyncio.run(run())

    persisted = json.loads((tmp_path / "todos.json").read_text(encoding="utf-8"))
    assert persisted["root"][todo_id]["status"] == "failed"
    assert persisted["root"][todo_id]["resolution_reason"] == "Agent ended with status crashed"


def test_create_agent_rejects_unknown_todo_before_spawning(tmp_path):
    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        todo_tools.hydrate_todos_from_disk(tmp_path)
        spawned = False

        async def spawner(**kwargs):
            nonlocal spawned
            spawned = True
            return {"success": True, "agent_id": "child", "name": kwargs["name"]}

        ctx = ToolContext(
            context={"agent_id": "root", "coordinator": coordinator, "spawn_child_agent": spawner},
            tool_name="create_agent",
            tool_call_id="call-agent",
            tool_arguments="{}",
        )
        result = await agent_tools.create_agent.on_invoke_tool(
            ctx,
            json.dumps({"name": "Unknown Todo Agent", "task": "Do work", "todo_id": "missing"}),
        )
        _, statuses, _ = await coordinator.graph_snapshot()
        return json.loads(result), spawned, statuses

    result, spawned, statuses = asyncio.run(run())

    assert result["success"] is False
    assert result["agent_id"] is None
    assert "Todo with ID 'missing' not found" in result["error"]
    assert spawned is False
    assert statuses == {"root": "running"}


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


def test_agent_finish_completes_bound_parent_todo(tmp_path):
    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        await coordinator.register("child", "child", "root")
        todo_tools.hydrate_todos_from_disk(tmp_path)
        created = todo_tools.create_bound_todo(
            owner_agent_id="root",
            title="Child assignment",
            description="Assigned work",
            linked_agent_id="child",
        )

        finish_ctx = ToolContext(
            context={"agent_id": "child", "parent_id": "root", "coordinator": coordinator},
            tool_name="agent_finish",
            tool_call_id="call-finish",
            tool_arguments="{}",
        )
        result = await agent_tools.agent_finish.on_invoke_tool(
            finish_ctx,
            json.dumps({"result_summary": "done", "success": True}),
        )
        _, statuses, _ = await coordinator.graph_snapshot()
        return json.loads(result), statuses, created["todo_id"]

    result, statuses, todo_id = asyncio.run(run())

    assert result["success"] is True
    assert result["completed_todo_ids"] == [todo_id]
    assert statuses["child"] == "completed"
    persisted = json.loads((tmp_path / "todos.json").read_text(encoding="utf-8"))
    assert persisted["root"][todo_id]["status"] == "done"


def test_agent_finish_failure_does_not_complete_bound_parent_todo(tmp_path):
    async def run():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "root", None)
        await coordinator.register("child", "child", "root")
        todo_tools.hydrate_todos_from_disk(tmp_path)
        created = todo_tools.create_bound_todo(
            owner_agent_id="root",
            title="Child assignment",
            linked_agent_id="child",
        )

        finish_ctx = ToolContext(
            context={"agent_id": "child", "parent_id": "root", "coordinator": coordinator},
            tool_name="agent_finish",
            tool_call_id="call-finish",
            tool_arguments="{}",
        )
        result = await agent_tools.agent_finish.on_invoke_tool(
            finish_ctx,
            json.dumps({"result_summary": "blocked", "success": False}),
        )
        return json.loads(result), created["todo_id"]

    result, todo_id = asyncio.run(run())

    assert result["success"] is True
    assert result["completed_todo_ids"] == []
    assert result["resolved_todo_ids"] == [todo_id]
    persisted = json.loads((tmp_path / "todos.json").read_text(encoding="utf-8"))
    assert persisted["root"][todo_id]["status"] == "failed"


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
        evidence_ids=None,
    ))

    assert result["success"] is True
    assert result["severity"] == "critical"
    assert result["cvss_score"] == 9.8
    assert state.reports[0]["severity"] == "critical"
    assert state.reports[0]["cvss"] == 9.8


def test_reporting_shim_persists_evidence_ids(monkeypatch, tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    memory_tools.hydrate_memory_from_disk(tmp_path)

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
    ctx = ToolContext(
        context={"agent_id": "root"},
        tool_name="record_evidence",
        tool_call_id="call-1",
        tool_arguments="{}",
    )
    first_evidence = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx,
        json.dumps({"evidence_type": "http_trace", "summary": "SQL injection proof"}),
    )))["evidence_id"]
    second_evidence = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx,
        json.dumps({"evidence_type": "tool_output", "summary": "SQL injection exploit output"}),
    )))["evidence_id"]

    result = asyncio.run(node3_tool._do_create(
        title="SQL Injection",
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
        evidence_ids=[first_evidence, first_evidence, second_evidence],
    ))

    assert result["success"] is True
    assert "warning" not in result
    assert state.reports[0]["evidence_ids"] == [first_evidence, second_evidence]


def test_create_vulnerability_report_requires_attack_surface_and_coverage(monkeypatch, tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    memory_tools.hydrate_memory_from_disk(state_dir)

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

    async def run_case():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "strix", None)
        await coordinator.register("validator", "SQL Validator", "root")
        root_ctx = ToolContext(
            context={"agent_id": "root", "state_dir": str(state_dir), "coordinator": coordinator},
            tool_name="record_evidence",
            tool_call_id="call-root-evidence",
            tool_arguments="{}",
        )
        validator_ctx = ToolContext(
            context={"agent_id": "validator", "state_dir": str(state_dir), "coordinator": coordinator},
            tool_name="record_evidence",
            tool_call_id="call-validator-evidence",
            tool_arguments="{}",
        )
        root_evidence_id = json.loads(await memory_tools.record_evidence.on_invoke_tool(
            root_ctx,
            json.dumps({"evidence_type": "http_trace", "summary": "Root SQL injection proof"}),
        ))["evidence_id"]
        validator_evidence_id = json.loads(await memory_tools.record_evidence.on_invoke_tool(
            validator_ctx,
            json.dumps({"evidence_type": "http_trace", "summary": "Validator reproduced SQL injection"}),
        ))["evidence_id"]
        report_ctx = ToolContext(
            context={"agent_id": "root", "state_dir": str(state_dir), "coordinator": coordinator},
            tool_name="create_vulnerability_report",
            tool_call_id="call-report",
            tool_arguments="{}",
        )
        base = {
            "title": "SQL Injection",
            "description": "SQL injection is confirmed.",
            "impact": "An attacker can read database contents.",
            "target": "http://target.local",
            "technical_analysis": "The endpoint concatenates SQL.",
            "poc_description": "Send a UNION payload.",
            "poc_script_code": "print('poc')",
            "remediation_steps": "Use prepared statements.",
            "cvss_breakdown": {"AV": "N", "AC": "L", "PR": "N", "UI": "N", "S": "U", "C": "H", "I": "H", "A": "H"},
            "endpoint": "/sqli",
            "method": "GET",
            "cwe": "CWE-89",
            "evidence_ids": [root_evidence_id],
            "validation_agent_id": "validator",
            "validation_evidence_ids": [validator_evidence_id],
        }
        no_surface = json.loads(await node3_tool.create_vulnerability_report.on_invoke_tool(
            report_ctx,
            json.dumps(base),
        ))
        await memory_tools.record_attack_surface.on_invoke_tool(
            root_ctx,
            json.dumps({
                "kind": "api_endpoint",
                "url": "/sqli",
                "method": "GET",
                "evidence_ids": [root_evidence_id],
            }),
        )
        no_coverage = json.loads(await node3_tool.create_vulnerability_report.on_invoke_tool(
            report_ctx,
            json.dumps(base),
        ))
        await memory_tools.record_coverage.on_invoke_tool(
            root_ctx,
            json.dumps({
                "endpoint": "GET /sqli",
                "vuln_type": "sql_injection",
                "status": "failed",
                "evidence_ids": [root_evidence_id],
                "result": "SQL injection confirmed",
            }),
        )
        valid = json.loads(await node3_tool.create_vulnerability_report.on_invoke_tool(
            report_ctx,
            json.dumps(base),
        ))
        return no_surface, no_coverage, valid

    monkeypatch.setattr("strix.report.dedupe.check_duplicate", fake_check_duplicate)
    monkeypatch.setattr("strix.report.state.get_global_report_state", lambda: state)

    no_surface, no_coverage, valid = asyncio.run(run_case())

    assert no_surface["success"] is False
    assert no_surface["workflow_gate"]["reason"] == "No attack surface records exist yet"
    assert no_coverage["success"] is False
    assert no_coverage["workflow_gate"]["reason"] == "The reported endpoint does not have a meaningful coverage record"
    assert valid["success"] is True
    assert state.reports[0]["endpoint"] == "/sqli"


def test_create_vulnerability_report_allows_specific_endpoint_when_unrelated_external_gap_exists(monkeypatch, tmp_path):
    from strix.tools.run_memory import tools as memory_tools
    from strix.tools.workflow import record_external_discoveries

    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    memory_tools.hydrate_memory_from_disk(state_dir)
    record_external_discoveries(
        state_dir,
        source="caido_sitemap",
        discoveries=[
            {"method": "GET", "url": "http://target.local/sqli", "path": "/sqli"},
            {"method": "GET", "url": "http://target.local/unrecorded", "path": "/unrecorded"},
        ],
    )

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

    async def run_case():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "strix", None)
        await coordinator.register("validator", "SQL Validator", "root")
        root_ctx = ToolContext(
            context={"agent_id": "root", "state_dir": str(state_dir), "coordinator": coordinator},
            tool_name="record_evidence",
            tool_call_id="call-root-evidence",
            tool_arguments="{}",
        )
        validator_ctx = ToolContext(
            context={"agent_id": "validator", "state_dir": str(state_dir), "coordinator": coordinator},
            tool_name="record_evidence",
            tool_call_id="call-validator-evidence",
            tool_arguments="{}",
        )
        root_evidence_id = json.loads(await memory_tools.record_evidence.on_invoke_tool(
            root_ctx,
            json.dumps({"evidence_type": "http_trace", "summary": "Root SQL injection proof"}),
        ))["evidence_id"]
        validator_evidence_id = json.loads(await memory_tools.record_evidence.on_invoke_tool(
            validator_ctx,
            json.dumps({"evidence_type": "http_trace", "summary": "Validator reproduced SQL injection"}),
        ))["evidence_id"]
        await memory_tools.record_attack_surface.on_invoke_tool(
            root_ctx,
            json.dumps({
                "kind": "api_endpoint",
                "url": "http://target.local/sqli",
                "method": "GET",
                "evidence_ids": [root_evidence_id],
            }),
        )
        await memory_tools.record_coverage.on_invoke_tool(
            root_ctx,
            json.dumps({
                "endpoint": "GET http://target.local/sqli",
                "vuln_type": "sql_injection",
                "status": "passed",
                "evidence_ids": [root_evidence_id],
                "result": "SQL injection confirmed",
            }),
        )
        report_ctx = ToolContext(
            context={"agent_id": "root", "state_dir": str(state_dir), "coordinator": coordinator},
            tool_name="create_vulnerability_report",
            tool_call_id="call-report",
            tool_arguments="{}",
        )
        return json.loads(await node3_tool.create_vulnerability_report.on_invoke_tool(
            report_ctx,
            json.dumps({
                "title": "SQL Injection",
                "description": "SQL injection is confirmed.",
                "impact": "An attacker can read database contents.",
                "target": "http://target.local",
                "technical_analysis": "The endpoint concatenates SQL.",
                "poc_description": "Send a UNION payload.",
                "poc_script_code": "print('poc')",
                "remediation_steps": "Use prepared statements.",
                "cvss_breakdown": {"AV": "N", "AC": "L", "PR": "N", "UI": "N", "S": "U", "C": "H", "I": "H", "A": "H"},
                "endpoint": "/sqli",
                "method": "GET",
                "cwe": "CWE-89",
                "evidence_ids": [root_evidence_id],
                "validation_agent_id": "validator",
                "validation_evidence_ids": [validator_evidence_id],
            }),
        ))

    monkeypatch.setattr("strix.report.dedupe.check_duplicate", fake_check_duplicate)
    monkeypatch.setattr("strix.report.state.get_global_report_state", lambda: state)

    result = asyncio.run(run_case())

    assert result["success"] is True
    assert state.reports[0]["endpoint"] == "/sqli"


def test_create_vulnerability_report_requires_independent_validation(monkeypatch, tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    state_dir = tmp_path / ".state"
    state_dir.mkdir()
    memory_tools.hydrate_memory_from_disk(state_dir)

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

    async def run_case():
        coordinator = AgentCoordinator()
        await coordinator.register("root", "strix", None)
        await coordinator.register("validator", "SQL Validator", "root")
        root_ctx = ToolContext(
            context={"agent_id": "root", "state_dir": str(state_dir), "coordinator": coordinator},
            tool_name="record_evidence",
            tool_call_id="call-root-evidence",
            tool_arguments="{}",
        )
        validator_ctx = ToolContext(
            context={"agent_id": "validator", "state_dir": str(state_dir), "coordinator": coordinator},
            tool_name="record_evidence",
            tool_call_id="call-validator-evidence",
            tool_arguments="{}",
        )
        root_evidence_id = json.loads(await memory_tools.record_evidence.on_invoke_tool(
            root_ctx,
            json.dumps({"evidence_type": "http_trace", "summary": "Root SQL injection proof"}),
        ))["evidence_id"]
        validator_evidence_id = json.loads(await memory_tools.record_evidence.on_invoke_tool(
            validator_ctx,
            json.dumps({"evidence_type": "http_trace", "summary": "Validator reproduced SQL injection"}),
        ))["evidence_id"]
        surface = json.loads(await memory_tools.record_attack_surface.on_invoke_tool(
            root_ctx,
            json.dumps({
                "kind": "api_endpoint",
                "url": "/sqli",
                "method": "GET",
                "evidence_ids": [root_evidence_id],
            }),
        ))
        coverage = json.loads(await memory_tools.record_coverage.on_invoke_tool(
            root_ctx,
            json.dumps({
                "endpoint": "GET /sqli",
                "vuln_type": "sql_injection",
                "status": "failed",
                "evidence_ids": [root_evidence_id],
                "result": "SQL injection confirmed",
            }),
        ))
        assert surface["success"] is True
        assert coverage["success"] is True
        report_ctx = ToolContext(
            context={"agent_id": "root", "state_dir": str(state_dir), "coordinator": coordinator},
            tool_name="create_vulnerability_report",
            tool_call_id="call-report",
            tool_arguments="{}",
        )
        base = {
            "title": "SQL Injection",
            "description": "SQL injection is confirmed.",
            "impact": "An attacker can read database contents.",
            "target": "http://target.local",
            "technical_analysis": "The endpoint concatenates SQL.",
            "poc_description": "Send a UNION payload.",
            "poc_script_code": "print('poc')",
            "remediation_steps": "Use prepared statements.",
            "cvss_breakdown": {"AV": "N", "AC": "L", "PR": "N", "UI": "N", "S": "U", "C": "H", "I": "H", "A": "H"},
            "endpoint": "/sqli",
            "method": "GET",
            "cwe": "CWE-89",
            "evidence_ids": [root_evidence_id],
        }
        missing_validation = json.loads(await node3_tool.create_vulnerability_report.on_invoke_tool(
            report_ctx,
            json.dumps(base),
        ))
        root_self_validation = json.loads(await node3_tool.create_vulnerability_report.on_invoke_tool(
            report_ctx,
            json.dumps({
                **base,
                "validation_agent_id": "root",
                "validation_evidence_ids": [root_evidence_id],
            }),
        ))
        wrong_owner_validation = json.loads(await node3_tool.create_vulnerability_report.on_invoke_tool(
            report_ctx,
            json.dumps({
                **base,
                "validation_agent_id": "validator",
                "validation_evidence_ids": [root_evidence_id],
            }),
        ))
        valid = json.loads(await node3_tool.create_vulnerability_report.on_invoke_tool(
            report_ctx,
            json.dumps({
                **base,
                "validation_agent_id": "validator",
                "validation_evidence_ids": [validator_evidence_id],
            }),
        ))
        return missing_validation, root_self_validation, wrong_owner_validation, valid, validator_evidence_id

    monkeypatch.setattr("strix.report.dedupe.check_duplicate", fake_check_duplicate)
    monkeypatch.setattr("strix.report.state.get_global_report_state", lambda: state)

    missing_validation, root_self_validation, wrong_owner_validation, valid, validator_evidence_id = asyncio.run(run_case())

    assert missing_validation["success"] is False
    assert any("validation_agent_id is required" in error for error in missing_validation["errors"])
    assert any("validation_evidence_ids is required" in error for error in missing_validation["errors"])
    assert root_self_validation["success"] is False
    assert any("subagent, not the root agent" in error for error in root_self_validation["errors"])
    assert wrong_owner_validation["success"] is False
    assert any("recorded by validation_agent_id" in error for error in wrong_owner_validation["errors"])
    assert valid["success"] is True
    assert state.reports[0]["validation_agent_id"] == "validator"
    assert state.reports[0]["validation_evidence_ids"] == [validator_evidence_id]


def test_reporting_shim_rejects_unknown_evidence_ids(monkeypatch, tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    memory_tools.hydrate_memory_from_disk(tmp_path)

    class FakeReportState:
        def __init__(self) -> None:
            self.reports: list[dict] = []

        def get_existing_vulnerabilities(self) -> list[dict]:
            return []

        def add_vulnerability_report(self, **kwargs):
            self.reports.append(kwargs)
            return "vuln-0001"

    state = FakeReportState()
    monkeypatch.setattr("strix.report.state.get_global_report_state", lambda: state)

    result = asyncio.run(node3_tool._do_create(
        title="SQL Injection",
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
        evidence_ids=["ev-missing"],
    ))

    assert result["success"] is False
    assert any("Unknown evidence_ids: ev-missing" in error for error in result["errors"])
    assert state.reports == []


def test_reporting_shim_validates_evidence_ids_against_context_state_dir(monkeypatch, tmp_path):
    from strix.tools.run_memory import tools as memory_tools

    state_a = tmp_path / "run-a" / ".state"
    state_b = tmp_path / "run-b" / ".state"
    state_a.mkdir(parents=True)
    state_b.mkdir(parents=True)
    memory_tools.hydrate_memory_from_disk(state_a)
    ctx_a = ToolContext(
        context={"agent_id": "root-a", "state_dir": str(state_a)},
        tool_name="record_evidence",
        tool_call_id="call-a",
        tool_arguments="{}",
    )
    evidence_a = json.loads(asyncio.run(memory_tools.record_evidence.on_invoke_tool(
        ctx_a,
        json.dumps({"evidence_type": "http_trace", "summary": "Run A proof"}),
    )))["evidence_id"]
    memory_tools.hydrate_memory_from_disk(state_b)

    class FakeReportState:
        def __init__(self) -> None:
            self.reports: list[dict] = []

        def get_existing_vulnerabilities(self) -> list[dict]:
            return []

        def add_vulnerability_report(self, **kwargs):
            self.reports.append(kwargs)
            return "vuln-0001"

    state = FakeReportState()
    monkeypatch.setattr("strix.report.state.get_global_report_state", lambda: state)

    result = asyncio.run(node3_tool._do_create(
        title="SQL Injection",
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
        evidence_ids=[evidence_a],
        state_dir=str(state_b),
    ))

    assert result["success"] is False
    assert any(f"Unknown evidence_ids: {evidence_a}" in error for error in result["errors"])
    assert state.reports == []


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
        evidence_ids=None,
    ))

    assert result["success"] is True
    assert result["cvss_score"] == 9.8
    assert state.reports[0]["cvss_breakdown"]["attack_vector"] == "N"


def test_reporting_shim_tolerates_cvss_metric_values_with_scores(monkeypatch):
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
        cvss_breakdown={
            "AV": "N - SCORE: 9.8 CRITICAL",
            "AC": "L",
            "PR": "N",
            "UI": "N",
            "S": "U",
            "C": "H",
            "I": "H",
            "A": "H - SCORE: 9.8 CRITICAL",
        },
        endpoint="/run",
        method="POST",
        cve=None,
        cwe="CWE-78",
        code_locations=None,
        evidence_ids=None,
    ))

    assert result["success"] is True
    assert result["cvss_score"] == 9.8
    assert state.reports[0]["cvss_breakdown"]["attack_vector"] == "N"
    assert state.reports[0]["cvss_breakdown"]["availability"] == "H"


def test_reporting_shim_tolerates_cvss_metric_values_with_explanations(monkeypatch):
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
        title="Sensitive Data Exposure",
        description="Sensitive data exposure is confirmed.",
        impact="An attacker can read user data.",
        target="http://target.local",
        technical_analysis="The endpoint exposes private user records.",
        poc_description="Send the request and observe leaked data.",
        poc_script_code="print('poc')",
        remediation_steps="Enforce authorization checks.",
        cvss_breakdown={
            "AV": "N (6.5 MEDIUM) - LOW PRIVILEGE REQUIRED, HIGH CONFIDENTIALITY IMPACT",
            "AC": "L",
            "PR": "L",
            "UI": "N",
            "S": "U",
            "C": "H",
            "I": "N",
            "A": "N (6.5 MEDIUM) - LOW PRIVILEGE REQUIRED",
        },
        endpoint="/users",
        method="GET",
        cve=None,
        cwe="CWE-200",
        code_locations=None,
        evidence_ids=None,
    ))

    assert result["success"] is True
    assert result["cvss_score"] == 6.5
    assert state.reports[0]["cvss_breakdown"]["attack_vector"] == "N"
    assert state.reports[0]["cvss_breakdown"]["availability"] == "N"


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
        "evidence_ids": None,
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
        evidence_ids=None,
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


def test_agent_finish_tool_result_summary_uses_summary_field():
    summary = tool_result_summary("agent_finish", {
        "success": True,
        "summary": "validated login endpoint",
    })

    assert summary == "Sub-agent finished: validated login endpoint"


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


def test_agent_engineering_rules_prioritize_harness_over_restriction():
    rules = (ROOT / "AGENTS.MD").read_text(encoding="utf-8")

    assert "Harness Over Restriction" in rules
    assert "Do not use target-specific profiles" in rules
    assert "Do not make new gates, restrictions, tools, or validators the default answer" in rules
    assert "Validator and reporting agents should follow candidate evidence" in rules


def test_system_prompt_uses_discovery_first_multi_agent_workflow():
    prompt = (NODE3 / "strix" / "agents" / "prompts" / "system_prompt.jinja").read_text(encoding="utf-8")

    assert "PHASE 2 - HYPOTHESIS-DRIVEN DISCOVERY & TESTING" in prompt
    assert "Discovery/testing workstreams -> Candidate validation -> Reporting" in prompt
    assert "CREATE AGENTS FROM THE TEST MATRIX" in prompt
    assert "Create new agents from recorded attack surfaces, planned hypotheses, candidate evidence" in prompt
    assert "CREATE SPECIALIZED SUBAGENT for EACH vulnerability type" not in prompt
    assert "Found SQL injection hint?" not in prompt
    assert "SQL injection agent finds potential vulnerability in login form" not in prompt


def test_create_agent_guidance_shapes_discovery_before_validation():
    source = (NODE3 / "strix" / "tools" / "agents_graph" / "tools.py").read_text(encoding="utf-8")

    assert "Good discovery/testing tasks cite recorded endpoints" in source
    assert "Good validator tasks cite the candidate evidence" in source
    assert "prefer discovery/testing children built" in source
    assert "do not use validators as the first" in source
