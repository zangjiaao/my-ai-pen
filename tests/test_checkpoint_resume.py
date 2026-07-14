import sys
import uuid
import asyncio
import json
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))
sys.path.insert(0, str(ROOT / "platform" / "backend"))

from app.services.conversation_snapshot import (  # noqa: E402
    build_conversation_snapshot as _build_conversation_snapshot,
    agent_state_from_checkpoint as _agent_state_from_checkpoint,
    checkpoint_assets as _checkpoint_assets,
    checkpoint_findings as _checkpoint_findings,
    checkpoint_plan_tree as _checkpoint_plan_tree,
    progress_for_checkpoint as _progress_for_checkpoint,
    snapshot_messages as _snapshot_messages,
    todos_for_checkpoint as _todos_for_checkpoint,
)
from app.models.conversation import Conversation  # noqa: E402
from app.models.message import Message  # noqa: E402
from app.services.conversation_state import transition_conversation  # noqa: E402
from app.ws.router import (  # noqa: E402
    DEFAULT_GOAL_OBJECTIVE,
    _goal_objective_from_message,
    _resume_message_from_context,
    _task_assign_from_user_message,
    _user_message_route,
)
from pentest_node.agent.intake import TaskIntake  # noqa: E402
from pentest_node.agent.loop import PHASE_TOOL_NAMES, PhaseGateError, PentestAgentLoop  # noqa: E402
from pentest_node.agent.state import Phase  # noqa: E402
from pentest_node.agent.llm import LLMClient  # noqa: E402
from pentest_node.tools.browser import _browser_result, _playwright_install_error, _safe_click_candidate  # noqa: E402
from pentest_node.tools.execute import make_execute_tool  # noqa: E402
from pentest_node.tools.workflow import make_workflow_tools  # noqa: E402


class DummyPlatform:
    def __init__(self):
        self.events = []

    async def send(self, event):
        self.events.append(event)



class FakeLLMError:
    async def chat(self, messages, tools=None):
        return {"content": "LLM failed", "tool_calls": [], "finish_reason": "error"}


class FakeSandbox:
    def __init__(self, exit_code=1, stdout="", stderr="boom"):
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr

    async def execute(self, command, timeout=600):
        return {"exit_code": self.exit_code, "stdout": self.stdout, "stderr": self.stderr}

class FakeEvidenceStore:
    workspace = ROOT

    def __init__(self, ids=("ev-111111111111",)):
        self.records = [self._record(eid, "HTTP POST http://target.local/login.php returned SQL error") for eid in ids]

    def _record(self, evidence_id, summary):
        return SimpleNamespace(
            evidence_id=evidence_id,
            type="http_trace",
            source_tool="run_web_skill",
            related_tool_run_id="tool-1",
            raw_ref="",
            summary=summary,
            hash="sha256:test",
        )

    async def collect_http_trace(self, tool_run_id, request, response):
        evidence_id = f"ev-{len(self.records) + 1:012x}"
        record = self._record(evidence_id, f"HTTP {request[:200]}")
        record.related_tool_run_id = tool_run_id
        self.records.append(record)
        return record

    async def collect_tool_output(self, tool_run_id, tool_name, stdout, stderr):
        evidence_id = f"ev-{len(self.records) + 1:012x}"
        record = self._record(evidence_id, f"Tool output from {tool_name}")
        record.type = "tool_output"
        record.source_tool = tool_name
        record.related_tool_run_id = tool_run_id
        self.records.append(record)
        return record

    def get_by_ids(self, ids):
        wanted = set(ids)
        return [record for record in self.records if record.evidence_id in wanted]

class CheckpointResumeTests(unittest.TestCase):
    def test_wait_for_approval_generates_unique_request_ids(self):
        async def scenario():
            platform = DummyPlatform()
            loop = PentestAgentLoop(
                task={"conversation_id": "conv-approval"},
                tools=SimpleNamespace(),
                sandbox=None,
                llm=None,
                platform_sync=platform,
            )

            first = asyncio.create_task(loop.wait_for_approval(risk_level="destructive", question="Allow first?", proposed_action="cmd1"))
            await asyncio.sleep(0)
            first_id = platform.events[-1]["request_id"]
            loop.receive_user_input(first_id, "authorize")
            self.assertEqual(await first, "authorize")

            second = asyncio.create_task(loop.wait_for_approval(risk_level="destructive", question="Allow second?", proposed_action="cmd2"))
            await asyncio.sleep(0)
            second_id = platform.events[-1]["request_id"]
            loop.receive_user_input(second_id, "authorize")
            self.assertEqual(await second, "authorize")
            return first_id, second_id

        first_id, second_id = asyncio.run(scenario())

        self.assertTrue(first_id.startswith("conv-approval-1-"))
        self.assertTrue(second_id.startswith("conv-approval-2-"))
        self.assertNotEqual(first_id, second_id)
    def test_llm_client_returns_reasoning_content_for_history(self):
        class Message:
            content = "answer"
            tool_calls = []
            model_extra = {"reasoning_content": "hidden reasoning"}

        class Choice:
            message = Message()
            finish_reason = "stop"

        class Response:
            choices = [Choice()]

        class Completions:
            async def create(self, **kwargs):
                return Response()

        class Chat:
            completions = Completions()

        class Client:
            chat = Chat()

        client = LLMClient.__new__(LLMClient)
        client.model = "fake"
        client.client = Client()

        result = asyncio.run(client.chat([{"role": "user", "content": "hi"}]))

        self.assertEqual(result["reasoning_content"], "hidden reasoning")
        self.assertEqual(result["content"], "answer")

    def test_complete_phase_recommends_task_complete(self):
        self.assertEqual(PHASE_TOOL_NAMES["complete"], {"task_complete"})

    def test_phase_tool_allowlist_blocks_disallowed_tool_execution(self):
        target = "http://target.local/login.php"
        platform = DummyPlatform()
        calls = []

        class FakeLLM:
            def __init__(self):
                self.calls = 0

            async def chat(self, messages, tools=None):
                self.calls += 1
                if self.calls == 1:
                    return {
                        "content": "",
                        "finish_reason": "tool_calls",
                        "tool_calls": [{"id": "call-run-skill", "type": "function", "function": {"name": "run_web_skill", "arguments": "{}"}}],
                    }
                return {
                    "content": "",
                    "finish_reason": "tool_calls",
                    "tool_calls": [{"id": "call-complete", "type": "function", "function": {"name": "task_complete", "arguments": "{}"}}],
                }

        async def run_web_skill_handler(**kwargs):
            calls.append("run_web_skill")
            return {"status": "done", "stdout": "skill executed"}

        async def task_complete_handler(**kwargs):
            loop.abort()
            return {"status": "ok"}

        tool_by_name = {
            "run_web_skill": SimpleNamespace(name="run_web_skill", description="fake skill", parameters={"type": "object", "properties": {}}, handler=run_web_skill_handler),
            "task_complete": SimpleNamespace(name="task_complete", description="complete", parameters={"type": "object", "properties": {}}, handler=task_complete_handler),
        }
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(list_tools=lambda: list(tool_by_name.values()), get=lambda name: tool_by_name.get(name)),
            sandbox=None,
            llm=FakeLLM(),
            platform_sync=platform,
        )
        loop.attack_surface.record_http_result("tool-1", {"status": "done", "method": "GET", "url": target, "status_code": 200}, "ev-111111111111")
        loop.coverage.mark(endpoint=f"GET {target}", parameter="<none>", vuln_type="web_baseline", status="tried", evidence_ids=["ev-111111111111"])

        asyncio.run(loop._run_phase(Phase.COMPLETE))

        self.assertEqual(calls, [])
        self.assertTrue(any(event.get("tool_name") == "run_web_skill" and event.get("status") == "blocked" for event in platform.events))
        self.assertTrue(any("not available during complete" in str(event.get("line") or "") for event in platform.events))
        self.assertFalse(any(item.get("content", "").startswith("Phase guidance:") for item in loop.history if item.get("role") == "system"))

    def test_repeated_llm_errors_fail_phase_instead_of_spamming(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": "http://target.local"}, "resolved_target": "http://target.local", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(list_tools=lambda: [], get=lambda name: None),
            sandbox=None,
            llm=FakeLLMError(),
            platform_sync=platform,
        )

        with self.assertRaises(PhaseGateError):
            asyncio.run(loop._run_phase(Phase.RECON))
        self.assertEqual(sum(1 for event in platform.events if event.get("type") == "text"), 3)

    def test_execute_nonzero_exit_is_failed(self):
        tool = make_execute_tool(FakeSandbox(exit_code=2, stderr="command failed"), scope={"allow": ["http://target.local"], "deny": []})
        result = asyncio.run(tool.handler(command="curl http://target.local/missing", reason="probe"))

        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["exit_code"], 2)

    def test_browser_missing_binary_error_has_remediation(self):
        result = _playwright_install_error(
            "BrowserType.launch: Executable doesn't exist at C:\\Users\\me\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1223\\chrome.exe\n"
            "Please run the following command to download new browsers:\nplaywright install"
        )

        self.assertEqual(result["status"], "failed")
        self.assertIn("browser binaries are not installed", result["error"])
        self.assertIn("python -m playwright install chromium", result["remediation"])

    def test_intake_strips_chinese_task_suffix_from_url_target(self):
        result = TaskIntake(check_connectivity=False).parse_task({
            "instruction": "\u5bf9http://host.docker.internal:3000/\u8fdb\u884c Web \u5e94\u7528\u6e17\u900f\u6d4b\u8bd5",
            "target": {"type": "url", "value": "http://host.docker.internal:3000/\u8fdb\u884c"},
            "scope": {"allow": ["http://host.docker.internal:3000/\u8fdb\u884c"], "deny": []},
        })

        self.assertTrue(result.ok)
        self.assertEqual(result.target, "http://host.docker.internal:3000/")
        self.assertEqual(result.node_task.path, "/")

    def test_resume_intake_can_skip_connectivity_but_keeps_scope(self):
        intake = TaskIntake(timeout=0.01, check_connectivity=True)
        task = {
            "instruction": "test http://203.0.113.1:65535/login.php",
            "target": {"type": "url", "value": "http://203.0.113.1:65535/login.php"},
            "scope": {"allow": ["http://203.0.113.1:65535/login.php"], "deny": []},
        }

        normal = asyncio.run(intake.validate(task))
        resumed = asyncio.run(intake.validate(task, check_connectivity=False))

        self.assertFalse(normal.ok)
        self.assertIn("203.0.113.1", normal.reason)
        self.assertTrue(resumed.ok)
        self.assertEqual(resumed.connectivity, {"checked": False})

    def test_node_restores_checkpoint_state(self):
        checkpoint = {
            "phase": "analysis",
            "resolved_target": "http://host.docker.internal:8080/login.php",
            "state": {
                "phase": "analysis",
                "phases_completed": ["intake", "recon"],
                "iteration": 17,
                "phase_iteration": 4,
                "recent_tool_runs": [{"tool_name": "execute", "status": "done"}],
                "iterations_since_last_finding": 2,
            },
            "history": [{"role": "assistant", "content": "prior step"}],
            "candidate_findings": [{"id": "f1", "title": "SQLi", "status": "candidate"}],
            "discovered_assets": [{"address": "host.docker.internal", "asset_type": "web"}],
        }

        loop = PentestAgentLoop(
            task={"checkpoint": checkpoint, "target": {"type": "url", "value": checkpoint["resolved_target"]}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=None,
        )

        self.assertTrue(loop._resuming)
        self.assertEqual(loop.state.phase, Phase.ANALYSIS)
        self.assertEqual(loop.state.iteration, 17)
        self.assertEqual(loop.state.phase_iteration, 4)
        self.assertEqual({p.value for p in loop.state.phases_completed}, {"intake", "recon"})
        self.assertEqual(loop.task["resolved_target"], checkpoint["resolved_target"])
        self.assertEqual(loop.candidate_findings[0]["id"], "f1")
        self.assertEqual(loop.discovered_assets[0]["address"], "host.docker.internal")

        snapshot = loop.checkpoint_snapshot("test")
        self.assertEqual(snapshot["phase"], "analysis")
        self.assertEqual(snapshot["iteration"], 17)
        self.assertIn("recon", snapshot["phases_completed"])

    def test_node_restores_attack_surface_and_coverage(self):
        checkpoint = {
            "phase": "analysis",
            "attack_surface": [
                {
                    "surface_id": "as-1",
                    "conversation_id": "conv-1",
                    "kind": "form",
                    "url": "http://target.local/login",
                    "method": "POST",
                    "parameters": ["username", "password"],
                    "evidence_ids": ["ev-111111111111"],
                }
            ],
            "coverage": [
                {
                    "coverage_id": "cov-1",
                    "conversation_id": "conv-1",
                    "endpoint": "POST http://target.local/login",
                    "parameter": "username",
                    "vuln_type": "sqli",
                    "status": "tried",
                    "count": 1,
                }
            ],
        }
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "checkpoint": checkpoint},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )

        snapshot = loop.checkpoint_snapshot("test")

        self.assertEqual(snapshot["attack_surface_summary"]["total"], 1)
        self.assertEqual(snapshot["coverage_summary"]["total"], 1)
        self.assertEqual(snapshot["attack_surface"][0]["parameters"], ["username", "password"])
        self.assertEqual(snapshot["coverage"][0]["vuln_type"], "sqli")

    def test_http_result_populates_attack_surface(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": "http://target.local/login.php"}, "resolved_target": "http://target.local/login.php", "scope": {"allow": ["http://target.local/login.php"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        result = {
            "status": "done",
            "method": "GET",
            "url": "http://target.local/login.php?debug=1",
            "status_code": 200,
            "headers": {"content-type": "text/html"},
            "body": """
                <html><a href='/setup.php'>setup</a>
                <form action='/login.php' method='post'>
                  <input name='username'><input name='password' type='password'>
                </form></html>
            """,
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")

        kinds = {item["kind"] for item in snapshot["attack_surface"]}
        self.assertIn("url", kinds)
        self.assertIn("form", kinds)
        self.assertTrue(any(item["method"] == "POST" and "username" in item["parameters"] for item in snapshot["attack_surface"]))
        self.assertTrue(any(event["type"] == "attack_surface_discovered" for event in platform.events))

    def test_task_context_prompt_pins_target_without_attack_surface(self):
        target = "http://host.docker.internal:3000/login.php"
        loop = PentestAgentLoop(
            task={
                "instruction": f"test {target}",
                "target": {"type": "url", "value": target},
                "resolved_target": target,
                "scope": {"allow": [target], "deny": []},
            },
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )

        prompt = loop._task_context_prompt(Phase.RECON)

        self.assertIn(f"Resolved target: {target}", prompt)
        self.assertIn(f"Authorized scope allow: {target}", prompt)
        self.assertIn("Do not say the target is missing", prompt)

    def test_tool_arg_normalization_resolves_relative_urls_against_target(self):
        target = "http://host.docker.internal:3000/login.php"
        loop = PentestAgentLoop(
            task={"target": {"type": "url", "value": target}, "resolved_target": target},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )

        http_args = loop._normalize_tool_args("http_request", {"url": "/rest/user/login", "reason": "probe"})
        browser_args = loop._normalize_tool_args("browser", {"action": "navigate"})
        coverage_args = loop._normalize_tool_args("mark_coverage", {"endpoint": "POST /rest/user/login", "vuln_type": "auth_session", "status": "tried"})

        self.assertEqual(http_args["method"], "GET")
        self.assertEqual(http_args["url"], "http://host.docker.internal:3000/rest/user/login")
        self.assertEqual(browser_args["url"], target)
        self.assertEqual(coverage_args["endpoint"], "POST http://host.docker.internal:3000/rest/user/login")

    def test_blocked_or_out_of_scope_tool_results_do_not_seed_attack_surface(self):
        target = "http://target.local/login.php"
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": [target], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", {"status": "blocked", "url": "http://target.local/login.php", "method": "GET"}, "ev-111111111111"))
        asyncio.run(loop._record_autonomy_from_tool("tool-2", "http_request", {"status": "done", "url": "http://127.0.0.1:80/", "method": "GET", "status_code": 200}, "ev-2"))
        snapshot = loop.checkpoint_snapshot("test")

        self.assertEqual(snapshot["attack_surface_summary"]["total"], 0)
        self.assertFalse(any(event["type"] == "attack_surface_discovered" for event in platform.events))

    def test_phase_gate_blocks_positive_vulnerability_signal_without_finding(self):
        target = "http://target.local/rest/products/search"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
            evidence_store=FakeEvidenceStore(),
        )
        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", {"status": "done", "url": target, "method": "GET", "status_code": 200}, "ev-111111111111"))
        loop.coverage.mark(
            endpoint=f"GET {target}",
            parameter="q",
            vuln_type="sqli",
            status="passed",
            notes="SQL injection confirmed via UNION payload. Dumped users and password hashes.",
            evidence_ids=["ev-111111111111"],
        )

        self.assertIn("unresolved vulnerability", loop._phase_gate_error(Phase.COMPLETE))

        loop.candidate_findings.append({"id": "cand-1", "title": "SQLi", "status": "candidate", "evidence_ids": ["ev-111111111111"]})
        for node in loop.plan_tree.to_list():
            if node.get("status") == "pending":
                loop.plan_tree.update_node(node["node_id"], status="skipped", notes="not relevant to unresolved-signal gate test")
        self.assertIsNone(loop._phase_gate_error(Phase.COMPLETE))

    def test_failed_info_disclosure_coverage_auto_creates_confirmed_finding(self):
        target = "http://target.local/login.php"
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-info-disclosure", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )
        loop.attack_surface.record_http_result("tool-1", {"status": "done", "method": "GET", "url": target, "status_code": 200}, "ev-111111111111")
        loop.coverage.mark(
            endpoint=f"GET {target}",
            parameter="<none>",
            vuln_type="info_disclosure",
            status="failed",
            notes="Directory listing enabled and sensitive backup file exposed.",
            evidence_ids=["ev-111111111111"],
        )

        created = asyncio.run(loop._auto_create_findings_from_failed_coverage())

        self.assertEqual(len(created), 1)
        self.assertEqual(loop.candidate_findings[0]["status"], "confirmed")
        self.assertEqual(loop.confirmed_findings[0]["vuln_type"], "info_disclosure")
        self.assertIsNone(loop._phase_gate_error(Phase.COMPLETE))
        self.assertTrue(any(event.get("type") == "vuln_found" and event.get("status") == "confirmed" for event in platform.events))
    def test_info_disclosure_finding_key_dedupes_different_titles_same_location(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-dedupe", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        first = {"title": "Possible sensitive information disclosure", "vuln_type": "info_disclosure", "affected_asset": "http://target.local/ftp", "location": "GET http://target.local/ftp"}
        second = {"title": "Sensitive information disclosure", "vuln_type": "info_disclosure", "affected_asset": "http://target.local/ftp", "location": "GET http://target.local/ftp"}

        self.assertEqual(loop._finding_key(first), loop._finding_key(second))
    def test_tool_history_content_exposes_evidence_id(self):
        loop = PentestAgentLoop(
            task={},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )

        content = loop._tool_history_content({"stdout": "proof body", "status": "done", "evidence_id": "ev-111111111111"})

        self.assertIn("EVIDENCE_ID: ev-111111111111", content)
        self.assertIn("proof body", content)
    def test_recon_runtime_advances_when_executable_plan_nodes_exist(self):
        class ExplodingLLM:
            async def chat(self, messages, tools=None):
                raise AssertionError("recon runtime should advance before calling LLM")

        target = "http://target.local/login.php"
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(list_tools=lambda: [], get=lambda name: None),
            sandbox=None,
            llm=ExplodingLLM(),
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )
        loop.attack_surface.record_http_result("tool-1", {"status": "done", "method": "GET", "url": target, "status_code": 200, "body": "<form><input name=q></form>"}, "ev-111111111111")
        for idx in range(3):
            loop.plan_tree.add_node(title=f"Recon runtime test {idx}", kind="test", endpoint=f"GET {target}", parameter="q", vuln_type="sqli")

        asyncio.run(loop._run_phase(Phase.RECON))

        self.assertIn(Phase.RECON, loop.state.phases_completed)
        self.assertTrue(any("advancing to analysis" in item.get("content", "") for item in loop.history))
        self.assertTrue(any(event.get("active_tool") == "workflow_runtime" for event in platform.events))

    def test_login_surface_auth_pivot_expands_attack_surface(self):
        calls = []

        async def browser_handler(**kwargs):
            calls.append(kwargs)
            return {
                "status": "ok",
                "action": "login",
                "url": "http://target.local/index.php",
                "title": "Home",
                "body": "<html><a href='/vulnerabilities/exec/'>Command Injection</a><form action='/vulnerabilities/exec/' method='post'><input name='ip'></form></html>",
            }

        target = "http://target.local/login.php"
        platform = DummyPlatform()
        browser_tool = SimpleNamespace(handler=browser_handler)
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-auth", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(list_tools=lambda: [], get=lambda name: browser_tool if name == "browser" else None),
            sandbox=None,
            llm=None,
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )
        loop.attack_surface.record_http_result(
            "tool-login",
            {"status": "done", "method": "GET", "url": target, "status_code": 200, "body": "<form action='/login.php' method='post'><input name='username'><input name='password'></form>"},
            "ev-111111111111",
        )

        self.assertTrue(loop._auth_pivot_available())
        executed = asyncio.run(loop._autorun_auth_pivot())
        snapshot = loop.checkpoint_snapshot("test")
        urls = {item["url"] for item in snapshot["attack_surface"] if item.get("url")}
        tests = {(node["target"], node["parameter"], node["vuln_type"]) for node in snapshot["exploration_plan_tree"] if node["kind"] == "test"}

        self.assertEqual(executed, 1)
        self.assertEqual(calls[0]["action"], "login")
        self.assertIn("http://target.local/vulnerabilities/exec", urls)
        self.assertTrue(any(target_url.rstrip("/") == "http://target.local/vulnerabilities/exec" and param == "ip" and vuln == "command_injection" for target_url, param, vuln in tests))
        self.assertFalse(loop._auth_pivot_available())
    def test_browser_explore_click_filter_skips_unsafe_controls(self):
        base = "http://target.local/"
        self.assertTrue(_safe_click_candidate({"tag": "a", "href": "/login", "text": "Login", "visible": True}, base))
        self.assertTrue(_safe_click_candidate({"tag": "button", "text": "Menu", "visible": True}, base))
        self.assertFalse(_safe_click_candidate({"tag": "button", "text": "Delete account", "visible": True}, base))
        self.assertFalse(_safe_click_candidate({"tag": "button", "type": "submit", "text": "Login", "in_form": True, "visible": True}, base))
        self.assertFalse(_safe_click_candidate({"tag": "a", "href": "https://evil.example/", "text": "external", "visible": True}, base))

    def test_browser_entrypoint_captures_spa_api_traffic(self):
        calls = []

        async def browser_handler(**kwargs):
            calls.append(kwargs)
            return _browser_result(
                status="ok",
                action="navigate",
                url="http://target.local/",
                title="SPA",
                body="<html><script src='main.js'></script></html>",
                captured_requests=[
                    {
                        "method": "GET",
                        "url": "http://target.local/rest/products/search?q=apple",
                        "status_code": 200,
                        "response_headers": {"content-type": "application/json"},
                        "response_body": "[{\"id\":1,\"name\":\"Apple Juice\"}]",
                    },
                    {
                        "method": "GET",
                        "url": "http://target.local/socket.io/?EIO=4",
                        "status_code": 200,
                        "response_headers": {"content-type": "text/plain"},
                        "is_websocket": True,
                    },
                ],
            )

        browser_tool = SimpleNamespace(handler=browser_handler)
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-entrypoint", "target": {"type": "url", "value": "http://target.local/"}, "resolved_target": "http://target.local/", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(list_tools=lambda: [], get=lambda name: browser_tool if name == "browser" else None),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
            evidence_store=FakeEvidenceStore(),
        )

        executed = asyncio.run(loop._autorun_browser_entrypoint())
        snapshot = loop.checkpoint_snapshot("test")
        ranked = loop.traffic_capture.rank_candidates(limit=5)

        self.assertEqual(executed, 1)
        self.assertEqual(calls[0]["action"], "explore")
        self.assertEqual(calls[0]["wait_ms"], 1000)
        self.assertEqual(calls[0]["max_actions"], 8)
        self.assertTrue(any(row["url"] == "http://target.local/rest/products/search?q=apple" for row in ranked))
        self.assertFalse(any("socket.io" in row["url"] for row in ranked))
        self.assertTrue(any(item["kind"] == "api_endpoint" and item["url"] == "http://target.local/rest/products/search?q=apple" for item in snapshot["attack_surface"]))
        self.assertTrue(any(node["kind"] == "test" and node["request_id"] for node in snapshot["exploration_plan_tree"]))
    def test_surface_expansion_visits_pending_surface_and_discovers_forms(self):
        async def browser_handler(**kwargs):
            return {
                "status": "ok",
                "action": "navigate",
                "url": kwargs["url"],
                "title": "Command Injection",
                "body": "<form action='/vulnerabilities/exec/' method='post'><input name='ip'></form>",
            }

        target = "http://target.local/vulnerabilities/exec"
        platform = DummyPlatform()
        browser_tool = SimpleNamespace(handler=browser_handler)
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-surface", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(list_tools=lambda: [], get=lambda name: browser_tool if name == "browser" else None),
            sandbox=None,
            llm=None,
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )
        surface = loop.plan_tree.add_node(title="Explore exec", kind="surface", target=target, endpoint=f"GET {target}", source="runtime")

        executed = asyncio.run(loop._autorun_surface_expansion(limit=1))
        snapshot = loop.checkpoint_snapshot("test")
        by_id = {node["node_id"]: node for node in snapshot["exploration_plan_tree"]}
        tests = {(node["target"], node["parameter"], node["vuln_type"]) for node in snapshot["exploration_plan_tree"] if node["kind"] == "test"}

        self.assertEqual(executed, 1)
        self.assertEqual(by_id[surface.node_id]["status"], "done")
        self.assertTrue(any(target_url.rstrip("/") == target.rstrip("/") and param == "ip" and vuln == "command_injection" for target_url, param, vuln in tests))

    def test_workflow_runtime_prioritizes_high_value_tests_over_cookie_checks(self):
        target = "http://target.local/vulnerabilities/exec?ip=127.0.0.1"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-priority", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        loop.plan_tree.add_node(title="Cookie flags", kind="test", endpoint=f"GET {target}", parameter="<none>", vuln_type="auth_session")
        high = loop.plan_tree.add_node(title="Command injection", kind="test", endpoint=f"GET {target}", parameter="ip", vuln_type="command_injection")

        nodes = loop._workflow_runtime_candidate_nodes(limit=10)

        self.assertEqual([node["node_id"] for node in nodes], [high.node_id])
    def test_workflow_runtime_balances_vulnerability_types_and_paths(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-balanced", "target": {"type": "url", "value": "http://target.local"}, "resolved_target": "http://target.local", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        cmdi = loop.plan_tree.add_node(title="Exec command injection", kind="test", endpoint="POST http://target.local/vulnerabilities/exec/", parameter="ip", vuln_type="command_injection", priority=22)
        exec_sqli = loop.plan_tree.add_node(title="Exec SQLi", kind="test", endpoint="POST http://target.local/vulnerabilities/exec/", parameter="ip", vuln_type="sqli", priority=22)
        sqli = loop.plan_tree.add_node(title="SQLi", kind="test", endpoint="GET http://target.local/vulnerabilities/sqli/", parameter="id", vuln_type="sqli", priority=22)
        xss = loop.plan_tree.add_node(title="XSS", kind="test", endpoint="GET http://target.local/vulnerabilities/xss_r/", parameter="name", vuln_type="xss", priority=22)

        nodes = loop._workflow_runtime_candidate_nodes(limit=3)

        self.assertEqual(nodes[0]["node_id"], cmdi.node_id)
        self.assertIn(sqli.node_id, [node["node_id"] for node in nodes])
        self.assertIn(xss.node_id, [node["node_id"] for node in nodes])
        self.assertNotIn(exec_sqli.node_id, [node["node_id"] for node in nodes])
    def test_workflow_runtime_prioritizes_endpoint_vulnerability_affinity(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-affinity", "target": {"type": "url", "value": "http://target.local"}, "resolved_target": "http://target.local", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        csrf_sqli = loop.plan_tree.add_node(title="CSRF SQLi", kind="test", endpoint="GET http://target.local/vulnerabilities/csrf/", parameter="password_new", vuln_type="sqli", priority=22)
        sqli = loop.plan_tree.add_node(title="SQLi", kind="test", endpoint="GET http://target.local/vulnerabilities/sqli/", parameter="id", vuln_type="sqli", priority=22)
        cmdi = loop.plan_tree.add_node(title="Exec command injection", kind="test", endpoint="POST http://target.local/vulnerabilities/exec/", parameter="ip", vuln_type="command_injection", priority=22)

        nodes = loop._workflow_runtime_candidate_nodes(limit=3)

        self.assertEqual(nodes[0]["node_id"], cmdi.node_id)
        self.assertEqual(nodes[1]["node_id"], sqli.node_id)
        self.assertEqual(nodes[2]["node_id"], csrf_sqli.node_id)
    def test_surface_expansion_prioritizes_high_signal_attack_surfaces(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-surface-priority", "target": {"type": "url", "value": "http://target.local"}, "resolved_target": "http://target.local", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        about = loop.plan_tree.add_node(title="About", kind="surface", target="http://target.local/about.php", endpoint="GET http://target.local/about.php", source="runtime")
        xss = loop.plan_tree.add_node(title="XSS", kind="surface", target="http://target.local/vulnerabilities/xss_r/", endpoint="GET http://target.local/vulnerabilities/xss_r/", source="runtime")
        sqli = loop.plan_tree.add_node(title="SQLi", kind="surface", target="http://target.local/vulnerabilities/sqli/", endpoint="GET http://target.local/vulnerabilities/sqli/", source="runtime")
        exec_node = loop.plan_tree.add_node(title="Exec", kind="surface", target="http://target.local/vulnerabilities/exec/", endpoint="GET http://target.local/vulnerabilities/exec/", source="runtime")

        nodes = loop._surface_expansion_candidate_nodes(limit=4)

        self.assertEqual([node["node_id"] for node in nodes], [exec_node.node_id, sqli.node_id, xss.node_id, about.node_id])
    def test_goal_keeper_keeps_vulnerability_discovery_as_primary_objective(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1"},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )

        prompt = loop._goal_keeper_prompt(Phase.VERIFY)

        self.assertIn("discover, verify, and report real exploitable vulnerabilities", prompt)
        self.assertIn("supporting means, not success criteria", prompt)
    def test_analysis_drains_with_reflection_turns_then_advances(self):
        # When the auto-seeded plan is drained, the runtime must give the model
        # reflection turns (ReAct) instead of hard-advancing. It advances only
        # after DRAIN_MAX_IDLE_ROUNDS turns produce no new plan nodes/coverage.
        class IdleLLM:
            def __init__(self):
                self.calls = 0

            async def chat(self, messages, tools=None):
                self.calls += 1
                return {"finish_reason": "stop", "tool_calls": [], "content": "No further coverage gaps."}

        target = "http://target.local/login.php"
        platform = DummyPlatform()
        llm = IdleLLM()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(list_tools=lambda: [], get=lambda name: None),
            sandbox=None,
            llm=llm,
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )
        loop.attack_surface.record_http_result("tool-1", {"status": "done", "method": "GET", "url": target, "status_code": 200, "body": "<form><input name=q></form>"}, "ev-111111111111")
        for idx in range(3):
            loop.plan_tree.add_node(title=f"Runtime test {idx}", kind="test", endpoint=f"GET {target}", parameter="q", vuln_type="sqli")

        asyncio.run(loop._run_phase(Phase.ANALYSIS))

        self.assertIn(Phase.ANALYSIS, loop.state.phases_completed)
        # The ReAct loop was given at least one reflection turn before advancing.
        self.assertGreaterEqual(llm.calls, 1)
        self.assertTrue(any("Plan Tree test nodes are drained" in item.get("content", "") for item in loop.history))
        self.assertTrue(any("advancing to verify workflow" in item.get("content", "") for item in loop.history))
        self.assertTrue(any(event.get("active_tool") == "workflow_runtime" for event in platform.events))

    def test_verify_drains_with_reflection_turns_then_advances(self):
        class IdleLLM:
            def __init__(self):
                self.calls = 0

            async def chat(self, messages, tools=None):
                self.calls += 1
                return {"finish_reason": "stop", "tool_calls": [], "content": "No further tests remain."}

        target = "http://target.local/login.php"
        platform = DummyPlatform()
        llm = IdleLLM()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(list_tools=lambda: [], get=lambda name: None),
            sandbox=None,
            llm=llm,
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )
        loop.attack_surface.record_http_result("tool-1", {"status": "done", "method": "GET", "url": target, "status_code": 200, "body": "<form><input name=q></form>"}, "ev-111111111111")
        node = loop.plan_tree.add_node(title="Runtime test", kind="test", endpoint=f"GET {target}", parameter="q", vuln_type="sqli")
        loop.plan_tree.update_node(node.node_id, status="done", evidence_ids=["ev-111111111111"])
        loop.coverage.mark(endpoint=f"GET {target}", parameter="q", vuln_type="sqli", status="tried", evidence_ids=["ev-111111111111"])

        asyncio.run(loop._run_phase(Phase.VERIFY))

        self.assertIn(Phase.VERIFY, loop.state.phases_completed)
        self.assertGreaterEqual(llm.calls, 1)
        self.assertTrue(any("High-value Plan Tree test nodes are executed" in item.get("content", "") for item in loop.history))
        self.assertTrue(any("advancing to report" in item.get("content", "") for item in loop.history))
        self.assertTrue(any(event.get("active_tool") == "workflow_runtime" for event in platform.events))
    def test_analysis_runtime_waits_for_plan_or_iteration_threshold(self):
        target = "http://target.local/login.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        loop.plan_tree.add_node(title="Runtime test", kind="test", endpoint=f"GET {target}", parameter="q", vuln_type="sqli")

        self.assertEqual(loop._runtime_phase_advance_reason(Phase.ANALYSIS), "")
        loop.state.phase_iteration = 6
        self.assertIn("advancing to verify workflow", loop._runtime_phase_advance_reason(Phase.ANALYSIS))
    def test_phase_gates_reject_false_completion_without_valid_testing(self):
        target = "http://target.local/login.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": [target], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
            evidence_store=FakeEvidenceStore(),
        )

        self.assertIn("no successful in-scope", loop._phase_gate_error(Phase.RECON))

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", {"status": "done", "url": target, "method": "GET", "status_code": 200}, "ev-111111111111"))
        self.assertIsNone(loop._phase_gate_error(Phase.RECON))

        loop.coverage.restore([])
        loop.coverage.mark(endpoint=f"GET {target}", parameter="<none>", vuln_type="xss", status="skipped", notes="not applicable")
        self.assertIn("all coverage records are skipped", loop._phase_gate_error(Phase.COMPLETE))

        loop.coverage.mark(endpoint=f"GET {target}", parameter="q", vuln_type="xss", status="tried", evidence_ids=["ev-111111111111"])
        self.assertIsNone(loop._phase_gate_error(Phase.COMPLETE))


    def test_phase_gates_reject_report_when_plan_tree_was_not_executed(self):
        target = "http://target.local/login.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
            evidence_store=FakeEvidenceStore(),
        )
        loop.attack_surface.record_http_result("tool-1", {"status": "done", "method": "GET", "url": target, "status_code": 200, "body": "<form><input name=q></form>"}, "ev-111111111111")
        for idx in range(20):
            loop.plan_tree.add_node(title=f"Test login SQLi {idx}", kind="test", endpoint=f"GET {target}", parameter="q", vuln_type="sqli")
        loop.coverage.mark(endpoint=f"GET {target}", parameter="q", vuln_type="sqli", status="tried", evidence_ids=["ev-111111111111"])

        self.assertIn("Plan Tree has no executed nodes", loop._phase_gate_error(Phase.VERIFY))
        self.assertIn("Plan Tree has no executed nodes", loop._phase_gate_error(Phase.REPORT))

        node_id = loop.plan_tree.to_list()[0]["node_id"]
        loop.plan_tree.update_node(node_id, status="done", evidence_ids=["ev-111111111111"])
        self.assertIn("unfinished Plan Tree work items", loop._phase_gate_error(Phase.REPORT))
        for node in loop.plan_tree.to_list():
            if node["status"] == "pending":
                loop.plan_tree.update_node(node["node_id"], status="skipped", notes="duplicate endpoint/parameter/type already covered")
        self.assertIsNone(loop._phase_gate_error(Phase.REPORT))

        loop.plan_tree.add_node(title="Test login XSS", kind="test", endpoint=f"GET {target}", parameter="q", vuln_type="xss")
        self.assertIn("unexamined high-value Plan Tree test nodes", loop._phase_gate_error(Phase.REPORT))
        for node in loop.plan_tree.to_list():
            if node["status"] == "pending":
                loop.plan_tree.update_node(node["node_id"], status="skipped", notes="not selected in focused test")

        self.assertIsNone(loop._phase_gate_error(Phase.REPORT))
    def test_phase_gate_does_not_count_running_nodes_as_executed(self):
        target = "http://target.local/login.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-running", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
            evidence_store=FakeEvidenceStore(),
        )
        loop.attack_surface.record_http_result("tool-1", {"status": "done", "method": "GET", "url": target, "status_code": 200}, "ev-111111111111")
        for idx in range(20):
            node = loop.plan_tree.add_node(title=f"Running login check {idx}", kind="test", endpoint=f"GET {target}", parameter="q", vuln_type="sqli")
            loop.plan_tree.update_node(node.node_id, status="running")
        loop.coverage.mark(endpoint=f"GET {target}", parameter="q", vuln_type="sqli", status="tried", evidence_ids=["ev-111111111111"])

        self.assertIn("Plan Tree has no executed nodes", loop._phase_gate_error(Phase.REPORT))

    def test_verify_runtime_does_not_advance_with_unfinished_low_priority_work(self):
        target = "http://target.local/login.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-unfinished-low", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
            evidence_store=FakeEvidenceStore(),
        )
        loop.attack_surface.record_http_result("tool-1", {"status": "done", "method": "GET", "url": target, "status_code": 200}, "ev-111111111111")
        loop.coverage.mark(endpoint=f"GET {target}", parameter="<none>", vuln_type="web_baseline", status="tried", evidence_ids=["ev-111111111111"])
        loop.plan_tree.add_node(title="Cookie flags", kind="test", endpoint=f"GET {target}", parameter="<none>", vuln_type="auth_session")

        self.assertEqual(loop._runtime_phase_advance_reason(Phase.VERIFY), "")
        self.assertIn("unfinished Plan Tree work items", loop._phase_gate_error(Phase.REPORT))

    def test_phase_gate_counts_pending_tests_by_endpoint_parameter_and_type(self):
        target = "http://target.local/search?q=base"
        other = "http://target.local/profile?name=base"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
            evidence_store=FakeEvidenceStore(),
        )
        loop.attack_surface.record_http_result("tool-1", {"status": "done", "method": "GET", "url": target, "status_code": 200}, "ev-111111111111")
        done_node = loop.plan_tree.add_node(title="Search SQLi", kind="test", endpoint=f"GET {target}", parameter="q", vuln_type="sqli")
        loop.plan_tree.update_node(done_node.node_id, status="done", evidence_ids=["ev-111111111111"])
        loop.coverage.mark(endpoint=f"GET {target}", parameter="q", vuln_type="sqli", status="tried", evidence_ids=["ev-111111111111"])
        loop.plan_tree.add_node(title="Profile SQLi", kind="test", endpoint=f"GET {other}", parameter="name", vuln_type="sqli")

        self.assertEqual(loop._pending_high_value_test_count(), 1)
        self.assertIn("unexamined high-value Plan Tree test nodes", loop._phase_gate_error(Phase.REPORT))

    def test_phase_gate_counts_pending_no_param_info_and_idor_tests(self):
        target = "http://target.local/api/users"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
            evidence_store=FakeEvidenceStore(),
        )
        loop.attack_surface.record_http_result("tool-1", {"status": "done", "method": "GET", "url": target, "status_code": 200, "body": "[]"}, "ev-111111111111")
        done_node = loop.plan_tree.add_node(title="Executed baseline", kind="test", endpoint=f"GET {target}", parameter="<none>", vuln_type="web_baseline")
        loop.plan_tree.update_node(done_node.node_id, status="done", evidence_ids=["ev-111111111111"])
        loop.coverage.mark(endpoint=f"GET {target}", parameter="<none>", vuln_type="web_baseline", status="tried", evidence_ids=["ev-111111111111"])
        info_node = loop.plan_tree.add_node(title="API info disclosure", kind="test", endpoint=f"GET {target}", parameter="<none>", vuln_type="info_disclosure")
        idor_node = loop.plan_tree.add_node(title="API IDOR", kind="test", endpoint=f"GET {target}", parameter="<none>", vuln_type="idor")
        auth_node = loop.plan_tree.add_node(title="Cookie flags", kind="test", endpoint=f"GET {target}", parameter="<none>", vuln_type="auth_session")

        self.assertEqual(loop._pending_high_value_test_count(), 2)
        self.assertIn("unexamined high-value Plan Tree test nodes", loop._phase_gate_error(Phase.REPORT))

        loop.plan_tree.update_node(info_node.node_id, status="skipped", notes="not sensitive", evidence_ids=["ev-111111111111"])
        loop.plan_tree.update_node(idor_node.node_id, status="skipped", notes="no object identifier", evidence_ids=["ev-111111111111"])
        self.assertEqual(loop._pending_high_value_test_count(), 0)
        self.assertIn("unfinished Plan Tree work items", loop._phase_gate_error(Phase.REPORT))

        loop.plan_tree.update_node(auth_node.node_id, status="skipped", notes="cookie flags not in scope", evidence_ids=["ev-111111111111"])
        self.assertIsNone(loop._phase_gate_error(Phase.REPORT))
        self.assertEqual(auth_node.vuln_type, "auth_session")

    def test_report_phase_uses_runtime_facts_not_llm_summary(self):
        class ExplodingLLM:
            async def chat(self, messages, tools=None):
                raise AssertionError("report phase should not call LLM")

        platform = DummyPlatform()
        target = "http://target.local/search.php?q=x"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-report", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=ExplodingLLM(),
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )
        loop.attack_surface.record_http_result("tool-1", {"status": "done", "method": "GET", "url": target, "status_code": 200, "body": "<script>alert(1)</script>"}, "ev-111111111111")
        loop.coverage.mark(endpoint=f"GET {target}", parameter="q", vuln_type="xss", status="failed", notes="Executable XSS payload reflected", evidence_ids=["ev-111111111111"])
        loop.candidate_findings.append({"id": "finding-xss", "title": "Executable cross-site scripting", "vuln_type": "xss", "severity": "high", "status": "confirmed", "location": f"GET {target} parameter=q", "evidence_ids": ["ev-111111111111"], "impact": "JavaScript execution", "remediation": "Encode output"})
        loop.confirmed_findings.append(loop.candidate_findings[0])

        asyncio.run(loop._run_phase(Phase.REPORT))

        text_events = [event for event in platform.events if event.get("type") == "text"]
        self.assertTrue(text_events)
        report_text = text_events[-1]["content"]["text"]
        self.assertIn("Executable cross-site scripting", report_text)
        self.assertIn("coverage status `failed` means", report_text)
        self.assertNotIn("No confirmed findings", report_text)
        self.assertIn(Phase.REPORT, loop.state.phases_completed)
    def test_workflow_tools_cannot_bypass_phase_gates(self):
        target = "http://target.local/login.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": [target], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        phase_transition = next(t for t in make_workflow_tools(loop) if t.name == "phase_transition")
        task_complete = next(t for t in make_workflow_tools(loop) if t.name == "task_complete")

        loop.state.phase = Phase.RECON
        with self.assertLogs("pentest_node.tools.workflow", level="WARNING"):
            blocked = asyncio.run(phase_transition.handler(phase_summary="done"))
        self.assertEqual(blocked["status"], "error")
        self.assertNotIn(Phase.RECON, loop.state.phases_completed)

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", {"status": "done", "url": target, "method": "GET", "status_code": 200}, "ev-111111111111"))
        loop.coverage.mark(endpoint=f"GET {target}", parameter="<none>", vuln_type="xss", status="tried", evidence_ids=["ev-111111111111"])
        loop.state.phase = Phase.COMPLETE
        allowed = asyncio.run(task_complete.handler())
        self.assertEqual(allowed["status"], "ok")
        self.assertTrue(loop._aborted)

    def test_mark_coverage_tool_updates_checkpoint(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )
        tool = next(t for t in make_workflow_tools(loop) if t.name == "mark_coverage")

        result = asyncio.run(tool.handler(
            endpoint="POST http://target.local/login.php?debug=1",
            parameter="username",
            vuln_type="sqli",
            status="passed",
            notes="No SQL error or timing difference observed",
            evidence_ids=["ev-111111111111"],
        ))
        snapshot = loop.checkpoint_snapshot("test")

        self.assertEqual(result["status"], "ok")
        self.assertEqual(snapshot["coverage_summary"]["by_status"]["passed"], 1)
        self.assertEqual(snapshot["coverage"][0]["parameter"], "username")
        self.assertTrue(any(event["type"] == "coverage_marked" for event in platform.events))

    def test_confirm_finding_requires_quality_gate_fields(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
            evidence_store=FakeEvidenceStore(),
        )
        loop.candidate_findings.append({"id": "cand-1", "title": "SQLi", "severity": "high", "status": "candidate", "affected_asset": "http://target.local", "location": "http://target.local/login.php", "evidence_ids": ["ev-111111111111"]})
        tool = next(t for t in make_workflow_tools(loop) if t.name == "confirm_finding")

        result = asyncio.run(tool.handler(candidate_finding_id="cand-1", evidence_ids=["ev-111111111111"]))

        self.assertEqual(result["status"], "error")
        self.assertIn("Finding quality gate failed", result["message"])
        self.assertEqual(loop.confirmed_findings, [])

    def test_confirm_finding_passes_quality_gate(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )
        loop.candidate_findings.append({"id": "cand-1", "title": "SQLi", "severity": "high", "status": "candidate", "affected_asset": "http://target.local", "location": "http://target.local/login.php", "evidence_ids": ["ev-111111111111"]})
        tool = next(t for t in make_workflow_tools(loop) if t.name == "confirm_finding")

        result = asyncio.run(tool.handler(
            candidate_finding_id="cand-1",
            target_url="http://target.local/login.php",
            method="POST",
            parameter="username",
            payload="' OR '1'='1",
            reproduction_steps="Submit the payload in the username field.",
            reproduction_request="curl -i -X POST http://target.local/login.php -d username=...",
            response_proof="The response contains a SQL error marker.",
            impact="An attacker can bypass authentication.",
            remediation="Use parameterized queries and server-side validation.",
            evidence_ids=["ev-111111111111"],
        ))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(loop.confirmed_findings[0]["target_url"], "http://target.local/login.php")
        self.assertTrue(any(event["type"] == "vuln_found" and event["status"] == "confirmed" for event in platform.events))

    def test_reconcile_tool_calls_adds_missing_tool_messages(self):
        loop = PentestAgentLoop(
            task={},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        repaired = loop._reconcile_tool_calls([
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "call-1", "type": "function", "function": {"name": "http_request", "arguments": "{}"}},
                {"id": "call-2", "type": "function", "function": {"name": "browser", "arguments": "{}"}},
            ]},
            {"role": "tool", "tool_call_id": "call-1", "content": "ok"},
            {"role": "assistant", "content": "next"},
        ])

        tool_messages = [m for m in repaired if m.get("role") == "tool"]
        self.assertEqual({m.get("tool_call_id") for m in tool_messages}, {"call-1", "call-2"})

    def test_reconcile_moves_interleaved_runtime_note_after_tool_messages(self):
        loop = PentestAgentLoop(
            task={},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        repaired = loop._reconcile_tool_calls([
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "call-1", "type": "function", "function": {"name": "http_request", "arguments": "{}"}},
                {"id": "call-2", "type": "function", "function": {"name": "browser", "arguments": "{}"}},
            ]},
            {"role": "system", "content": "Runtime: only the first calls were executed."},
            {"role": "tool", "tool_call_id": "call-1", "content": "http ok"},
            {"role": "tool", "tool_call_id": "call-2", "content": "browser ok"},
            {"role": "assistant", "content": "next"},
        ])

        self.assertEqual([m.get("role") for m in repaired[:4]], ["assistant", "tool", "tool", "system"])
        self.assertEqual(repaired[1]["tool_call_id"], "call-1")
        self.assertEqual(repaired[2]["tool_call_id"], "call-2")
        self.assertEqual(repaired[4]["content"], "next")

    def test_reconcile_drops_orphan_tool_messages(self):
        loop = PentestAgentLoop(
            task={},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        repaired = loop._reconcile_tool_calls([
            {"role": "system", "content": "before"},
            {"role": "tool", "tool_call_id": "orphan", "content": "bad"},
            {"role": "assistant", "content": "after"},
        ])

        self.assertEqual([m.get("role") for m in repaired], ["system", "assistant"])
        self.assertFalse(any(m.get("tool_call_id") == "orphan" for m in repaired))
    def test_intake_rejects_multiple_targets(self):
        result = TaskIntake(check_connectivity=False).parse_task({
            "instruction": "test http://host.docker.internal:3000/login.php\u3001http://host.docker.internal:8080",
            "target": {"type": "url", "value": "http://host.docker.internal:3000/login.php\u3001http://host.docker.internal:8080"},
            "scope": {"allow": ["http://host.docker.internal:3000", "http://host.docker.internal:8080"], "deny": []},
        })

        self.assertFalse(result.ok)
        self.assertIn("Multiple test targets", result.reason)

    def test_mark_coverage_rejects_invented_evidence_and_out_of_scope(self):
        target = "http://target.local/login.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "scope": {"allow": [target], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
            evidence_store=FakeEvidenceStore(),
        )
        tool = next(t for t in make_workflow_tools(loop) if t.name == "mark_coverage")

        invented = asyncio.run(tool.handler(endpoint=f"GET {target}", vuln_type="xss", status="failed", evidence_ids=["fake-id"]))
        out_of_scope = asyncio.run(tool.handler(endpoint="GET http://evil.local/", vuln_type="xss", status="tried"))

        self.assertEqual(invented["status"], "error")
        self.assertEqual(out_of_scope["status"], "blocked")
        self.assertEqual(loop.coverage.summary()["total"], 0)

    def test_create_candidate_requires_real_evidence_and_dedupes(self):
        target = "http://target.local/login.php"
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )
        tool = next(t for t in make_workflow_tools(loop) if t.name == "create_candidate_finding")
        args = {
            "title": "SQLi",
            "vuln_type": "sql_injection",
            "severity": "high",
            "affected_asset": "http://target.local",
            "location": target,
            "confidence": 0.8,
            "evidence_summary": "SQL error observed",
            "evidence_ids": ["ev-111111111111"],
        }

        missing = asyncio.run(tool.handler(**{**args, "evidence_ids": []}))
        first = asyncio.run(tool.handler(**args))
        second = asyncio.run(tool.handler(**args))

        self.assertEqual(missing["status"], "error")
        self.assertEqual(first["status"], "ok")
        self.assertTrue(second.get("deduped"))
        self.assertEqual(len(loop.candidate_findings), 1)
        self.assertEqual(len([e for e in platform.events if e.get("type") == "vuln_found"]), 1)
    def test_autonomy_prompt_includes_next_untested_candidates(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1"},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        loop.attack_surface.add_item(
            kind="form",
            url="http://target.local/login.php",
            method="POST",
            parameters=["username", "password"],
            source_tool_run_id="tool-1",
            evidence_id="ev-111111111111",
        )
        loop.coverage.mark(
            endpoint="POST http://target.local/login.php",
            parameter="username",
            vuln_type="sqli",
            status="passed",
            evidence_ids=["ev-111111111111"],
        )

        prompt = loop._autonomy_context_prompt()

        self.assertIn("Next untested candidates:", prompt)
        self.assertIn("param=password vuln=sqli", prompt)
        self.assertNotIn("- POST http://target.local/login.php param=username vuln=sqli", prompt)

    def test_node_restores_plan_tree(self):
        checkpoint = {
            "phase": "analysis",
            "exploration_plan_tree": [
                {
                    "node_id": "plan-1",
                    "title": "Test login form SQLi",
                    "status": "running",
                    "kind": "test",
                    "endpoint": "POST http://target.local/login.php",
                    "parameter": "username",
                    "vuln_type": "sqli",
                }
            ],
        }
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "checkpoint": checkpoint},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )

        snapshot = loop.checkpoint_snapshot("test")

        self.assertEqual(snapshot["plan_tree_summary"]["by_level"]["phase"], 6)
        self.assertEqual(snapshot["plan_tree_summary"]["by_level"]["work_item"], 1)
        by_id = {node["node_id"]: node for node in snapshot["exploration_plan_tree"]}
        self.assertEqual(by_id["plan-1"]["node_id"], "plan-1")
        self.assertEqual(by_id["plan-1"]["level"], "work_item")
        prompt = loop._autonomy_context_prompt()
        self.assertIn("Test login form SQLi", prompt)
        self.assertIn("sql_injection", prompt)

    def test_browser_html_populates_attack_surface_and_plan_tree(self):
        platform = DummyPlatform()
        target = "http://target.local/index.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        result = {
            "status": "ok",
            "action": "login",
            "url": target,
            "title": "Welcome",
            "body": "<html><a href='/vulnerabilities/exec/'>Command Injection</a><a href='/vulnerabilities/fi/?page=include.php'>File Inclusion</a><form action='/vulnerabilities/exec/' method='post'><input name='ip'></form></html>",
        }

        asyncio.run(loop._record_autonomy_from_tool("browser-1", "browser", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")
        urls = {item["url"] for item in snapshot["attack_surface"] if item.get("url")}
        tests = {(node["endpoint"], node["parameter"], node["vuln_type"]) for node in snapshot["exploration_plan_tree"] if node["kind"] == "test"}

        self.assertIn("http://target.local/vulnerabilities/exec", urls)
        self.assertIn("http://target.local/vulnerabilities/fi?page=include.php", urls)
        self.assertTrue(any(param == "ip" and vuln == "command_injection" for _endpoint, param, vuln in tests))
        self.assertTrue(any(param == "page" and vuln == "lfi" for _endpoint, param, vuln in tests))
    def test_http_result_populates_plan_tree_from_attack_surface(self):
        platform = DummyPlatform()
        target = "http://target.local/login.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        result = {
            "status": "done",
            "method": "GET",
            "url": target,
            "status_code": 200,
            "headers": {"content-type": "text/html"},
            "body": "<form action='/login.php' method='post'><input name='username'><input name='password'></form>",
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")

        self.assertGreater(snapshot["plan_tree_summary"]["total"], 0)
        self.assertTrue(any(node["kind"] == "test" and node["parameter"] == "username" for node in snapshot["exploration_plan_tree"]))
        self.assertTrue(any(event["type"] == "plan_tree_updated" for event in platform.events))


    def test_http_result_auto_marks_coverage_from_real_traffic(self):
        platform = DummyPlatform()
        target = "http://target.local/vulnerabilities/sqli/?id=1&Submit=Submit"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        result = {
            "status": "done",
            "method": "GET",
            "url": target,
            "status_code": 200,
            "headers": {"content-type": "text/html"},
            "body": "You have an error in your SQL syntax",
            "request": f"GET {target} HTTP/1.1\nHost: target.local",
            "response": "HTTP 200\n\nSQL syntax",
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")

        self.assertTrue(any(row["parameter"] == "id" and row["vuln_type"] == "sqli" and row["status"] == "failed" for row in snapshot["coverage"]))
        self.assertTrue(any("ev-111111111111" in row["evidence_ids"] for row in snapshot["coverage"]))
        self.assertEqual(len(snapshot["confirmed_findings"]), 1)
        self.assertEqual(snapshot["confirmed_findings"][0]["vuln_type"], "sql_injection")
    def test_plan_tree_seeds_high_value_web_vulnerability_hypotheses(self):
        platform = DummyPlatform()
        target = "http://target.local/exec.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        result = {
            "status": "done",
            "method": "GET",
            "url": target,
            "status_code": 200,
            "headers": {"content-type": "text/html"},
            "body": "<form action='/exec.php' method='post'><input name='ip'></form><a href='/file.php?page=include.php'>file</a><a href='/redirect.php?url=/'>redirect</a>",
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")
        tests = {(node["parameter"], node["vuln_type"]) for node in snapshot["exploration_plan_tree"] if node["kind"] == "test"}

        self.assertIn(("ip", "command_injection"), tests)
        self.assertIn(("page", "lfi"), tests)
        self.assertIn(("url", "open_redirect"), tests)
    def test_plan_tree_filters_low_value_form_parameters(self):
        platform = DummyPlatform()
        target = "http://target.local/login.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        result = {
            "status": "done",
            "method": "GET",
            "url": target,
            "status_code": 200,
            "headers": {"content-type": "text/html"},
            "body": "<form action='/login.php' method='post'><input name='username'><input name='password'><input name='user_token'><input name='Login'></form>",
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")
        tests = [node for node in snapshot["exploration_plan_tree"] if node["kind"] == "test"]

        self.assertFalse(any(node["parameter"] == "username" and node["vuln_type"] == "sqli" for node in tests))
        self.assertFalse(any(node["parameter"] == "username" and node["vuln_type"] == "auth_session" for node in tests))
        self.assertTrue(any(node["parameter"] == "username" and node["vuln_type"] == "weak_credentials" for node in tests))
        self.assertTrue(any(node["parameter"] == "password" and node["vuln_type"] == "weak_credentials" for node in tests))
        self.assertFalse(any(node["parameter"] == "Login" for node in tests))
        self.assertFalse(any(node["parameter"] == "user_token" for node in tests))
    def test_static_asset_surface_does_not_seed_vulnerability_tests(self):
        platform = DummyPlatform()
        target = "http://target.local/static/app.css"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        result = {
            "status": "done",
            "method": "GET",
            "url": target,
            "status_code": 200,
            "headers": {"content-type": "text/css"},
            "body": "body { color: black; }",
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")

        self.assertEqual(snapshot["plan_tree_summary"]["by_level"].get("phase"), 6)
        self.assertEqual(snapshot["plan_tree_summary"]["by_level"].get("work_item", 0), 0)
        self.assertFalse(any(node.get("level") == "work_item" for node in snapshot["exploration_plan_tree"]))
    def test_http_result_marks_matching_plan_node_running(self):
        platform = DummyPlatform()
        target = "http://target.local/vulnerabilities/sqli/?id=1&Submit=Submit"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        loop.plan_tree.add_node(
            title="Test SQLi on id",
            kind="test",
            endpoint=f"GET {target}",
            parameter="id",
            vuln_type="sqli",
        )
        result = {
            "status": "done",
            "method": "GET",
            "url": target,
            "status_code": 200,
            "headers": {"content-type": "text/html"},
            "body": "You have an error in your SQL syntax",
            "request": f"GET {target} HTTP/1.1\nHost: target.local",
            "response": "HTTP 200\n\nSQL syntax",
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")

        matching = [node for node in snapshot["exploration_plan_tree"] if node["vuln_type"] == "sqli"]
        self.assertEqual(matching[0]["status"], "failed")
        self.assertIn("ev-111111111111", matching[0]["evidence_ids"])
        self.assertTrue(any(event["type"] == "plan_tree_updated" for event in platform.events))
    def test_failed_coverage_does_not_fail_unrelated_plan_nodes(self):
        platform = DummyPlatform()
        target = "http://target.local/login.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        auth = loop.plan_tree.add_node(title="Test auth session", kind="test", endpoint=f"POST {target}", parameter="username", vuln_type="auth_session")
        xss = loop.plan_tree.add_node(title="Test XSS", kind="test", endpoint=f"POST {target}", parameter="username", vuln_type="xss")
        weak = loop.plan_tree.add_node(title="Test weak credentials", kind="test", endpoint=f"POST {target}", parameter="username", vuln_type="weak_credentials")
        result = {
            "status": "done",
            "method": "POST",
            "url": target,
            "status_code": 200,
            "headers": {"set-cookie": "PHPSESSID=abc; Path=/"},
            "body": "login page",
            "parameter": "username",
            "vuln_type": "auth_session",
            "request": f"POST {target} HTTP/1.1\nHost: target.local\n\nusername=admin",
            "response": "HTTP 200\nset-cookie: PHPSESSID=abc; Path=/\n\nlogin page",
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "run_web_skill", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")
        by_id = {node["node_id"]: node for node in snapshot["exploration_plan_tree"]}

        self.assertEqual(by_id[auth.node_id]["status"], "failed")
        self.assertEqual(by_id[xss.node_id]["status"], "pending")
        self.assertEqual(by_id[weak.node_id]["status"], "pending")
    def test_common_web_discovery_detects_directory_listing_info_disclosure(self):
        async def handler(**kwargs):
            url = kwargs["url"]
            if url.endswith("/ftp/"):
                body = "<html><head><title>listing directory /ftp/</title></head><body><a href='legal.md'>legal.md</a></body></html>"
                return {
                    "status": "done",
                    "method": "GET",
                    "url": url,
                    "status_code": 200,
                    "headers": {"content-type": "text/html"},
                    "body": body,
                    "request": f"GET {url} HTTP/1.1\nHost: target.local\n\n",
                    "response": "HTTP 200\ncontent-type: text/html\n\n" + body,
                }
            return {
                "status": "done",
                "method": "GET",
                "url": url,
                "status_code": 404,
                "headers": {"content-type": "text/plain"},
                "body": "not found",
                "request": f"GET {url} HTTP/1.1\nHost: target.local\n\n",
                "response": "HTTP 404\ncontent-type: text/plain\n\nnot found",
            }

        target = "http://target.local/"
        platform = DummyPlatform()
        tool = SimpleNamespace(handler=handler)
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-common-discovery", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(get=lambda name: tool if name == "http_request" else None),
            sandbox=None,
            llm=None,
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(ids=()),
        )

        executed = asyncio.run(loop._autorun_common_web_discovery(limit=20))
        asyncio.run(loop._auto_create_findings_from_failed_coverage())
        snapshot = loop.checkpoint_snapshot("test")

        self.assertGreaterEqual(executed, 1)
        self.assertTrue(any(item.get("url", "").endswith("/ftp") or item.get("url", "").endswith("/ftp/") for item in snapshot["attack_surface"]))
        self.assertTrue(any(entry["vuln_type"] == "info_disclosure" and entry["status"] == "failed" for entry in snapshot["coverage"]))
        self.assertTrue(any(finding.get("status") == "confirmed" and finding.get("vuln_type") == "info_disclosure" for finding in snapshot["candidate_findings"]))
    def test_run_web_skill_result_does_not_seed_new_plan_nodes_from_probe_url(self):
        platform = DummyPlatform()
        target = "http://target.local/search?q=base"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-run-skill-no-seed", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        node = loop.plan_tree.add_node(title="Search XSS", kind="test", endpoint=f"GET {target}", parameter="q", vuln_type="xss")
        result = {
            "status": "done",
            "method": "GET",
            "url": "http://target.local/search?q=%27%3E%3Csvg%2Fonload%3Dalert%281337%29%3E&Submit=Submit",
            "status_code": 200,
            "headers": {"content-type": "text/html"},
            "body": "no reflection",
            "parameter": "q",
            "vuln_type": "xss",
            "plan_node_id": node.node_id,
            "request": "GET /search?q=payload HTTP/1.1\nHost: target.local\n\n",
            "response": "HTTP 200\ncontent-type: text/html\n\nno reflection",
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-run-skill", "run_web_skill", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")

        self.assertEqual(snapshot["traffic_capture_summary"]["total"], 1)
        self.assertEqual(snapshot["plan_tree_summary"]["by_level"].get("work_item"), 1)
        self.assertFalse(any(event.get("type") == "attack_surface_discovered" for event in platform.events))
    def test_http_result_populates_captured_traffic(self):
        platform = DummyPlatform()
        target = "http://target.local/login.php"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        result = {
            "status": "done",
            "method": "GET",
            "url": target,
            "status_code": 200,
            "headers": {"content-type": "text/html"},
            "body": "<html>ok</html>",
            "request": f"GET {target} HTTP/1.1\nHost: target.local",
            "response": "HTTP 200\ncontent-type: text/html\n\n<html>ok</html>",
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")

        self.assertEqual(snapshot["traffic_capture_summary"]["total"], 1)
        self.assertEqual(snapshot["captured_traffic"][0]["method"], "GET")
        self.assertEqual(snapshot["captured_traffic"][0]["evidence_id"], "ev-111111111111")

    def test_plan_workflow_tools_update_checkpoint(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )
        tools = {tool.name: tool for tool in make_workflow_tools(loop)}

        added = asyncio.run(tools["plan_add_node"].handler(
            title="Test SQLi on login",
            kind="test",
            endpoint="POST http://target.local/login.php",
            parameter="username",
            vuln_type="sqli",
        ))
        node_id = added["node"]["node_id"]
        updated = asyncio.run(tools["plan_update"].handler(node_id=node_id, status="running", notes="Starting test"))
        completed = asyncio.run(tools["plan_update"].handler(node_ids=[node_id], status="done", evidence_ids=["ev-111111111111"]))
        next_nodes = asyncio.run(tools["plan_next"].handler(limit=5))
        snapshot = loop.checkpoint_snapshot("test")

        self.assertEqual(added["status"], "ok")
        self.assertEqual(updated["node"]["status"], "running")
        self.assertEqual(completed["updated"][0]["status"], "done")
        self.assertEqual(next_nodes["status"], "ok")
        self.assertFalse(any(node.get("level") != "work_item" for node in next_nodes["nodes"]))
        by_id = {node["node_id"]: node for node in snapshot["exploration_plan_tree"]}
        self.assertEqual(by_id[node_id]["status"], "done")
        self.assertTrue(any(event["type"] == "plan_tree_updated" for event in platform.events))
    def test_run_web_skill_executes_plan_node_and_creates_candidate(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                from urllib.parse import parse_qs, urlparse
                query = parse_qs(urlparse(self.path).query)
                body = (query.get("q") or [""])[0].encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            platform = DummyPlatform()
            target = f"http://127.0.0.1:{server.server_port}/search?q=base"
            loop = PentestAgentLoop(
                task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": [f"http://127.0.0.1:{server.server_port}"], "deny": []}},
                tools=SimpleNamespace(),
                sandbox=None,
                llm=None,
                platform_sync=platform,
            )
            node = loop.plan_tree.add_node(title="Test reflected XSS", kind="test", endpoint=f"GET {target}", parameter="q", vuln_type="xss")
            tool = next(t for t in make_workflow_tools(loop) if t.name == "run_web_skill")

            result = asyncio.run(tool.handler(node_id=node.node_id))
            asyncio.run(loop._record_autonomy_from_tool("tool-1", "run_web_skill", result, "ev-111111111111"))
            snapshot = loop.checkpoint_snapshot("test")
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(result["status"], "done")
        self.assertIn("<script>alert(1337)</script>", result["body"])
        self.assertTrue(any(row["vuln_type"] == "xss" and row["status"] == "failed" for row in snapshot["coverage"]))
        self.assertEqual(len(snapshot["candidate_findings"]), 1)
        self.assertTrue(any(node["title"] == "Test reflected XSS" and node["status"] == "failed" for node in snapshot["exploration_plan_tree"]))
        self.assertTrue(any(event["type"] == "vuln_found" for event in platform.events))

    def test_run_web_skill_skips_no_param_idor_node(self):
        target = "http://target.local/api/users"
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-idor-skip", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        node = loop.plan_tree.add_node(title="API IDOR", kind="test", endpoint=f"GET {target}", parameter="<none>", vuln_type="idor")
        tool = next(t for t in make_workflow_tools(loop) if t.name == "run_web_skill")

        result = asyncio.run(tool.handler(node_id=node.node_id))
        asyncio.run(loop._record_autonomy_from_tool("tool-idor", "run_web_skill", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")

        self.assertEqual(result["status"], "done")
        self.assertEqual(result["verifier"]["status"], "skipped")
        self.assertTrue(any(row["vuln_type"] == "idor" and row["status"] == "skipped" for row in snapshot["coverage"]))
        self.assertTrue(any(row["node_id"] == node.node_id and row["status"] == "skipped" for row in snapshot["exploration_plan_tree"]))

    def test_run_web_skill_no_param_info_disclosure_uses_verifier(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'{"users":[{"email":"admin@example.com","passwordHash":"0123456789abcdef0123456789abcdef"}]}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            platform = DummyPlatform()
            target = f"http://127.0.0.1:{server.server_port}/api/users"
            loop = PentestAgentLoop(
                task={"conversation_id": "conv-info", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": [f"http://127.0.0.1:{server.server_port}"], "deny": []}},
                tools=SimpleNamespace(),
                sandbox=None,
                llm=None,
                platform_sync=platform,
            )
            node = loop.plan_tree.add_node(title="API info disclosure", kind="test", endpoint=f"GET {target}", parameter="<none>", vuln_type="info_disclosure")
            tool = next(t for t in make_workflow_tools(loop) if t.name == "run_web_skill")

            result = asyncio.run(tool.handler(node_id=node.node_id))
            asyncio.run(loop._record_autonomy_from_tool("tool-info", "run_web_skill", result, "ev-111111111111"))
            snapshot = loop.checkpoint_snapshot("test")
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(result["status"], "done")
        self.assertEqual(result["verifier"]["status"], "failed")
        self.assertTrue(any(row["vuln_type"] == "info_disclosure" and row["status"] == "failed" for row in snapshot["coverage"]))
        self.assertEqual(snapshot["candidate_findings"][0]["vuln_type"], "info_disclosure")
        self.assertTrue(any(row["node_id"] == node.node_id and row["status"] == "failed" for row in snapshot["exploration_plan_tree"]))

    def test_run_web_skill_posts_form_node_and_creates_command_injection_candidate(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                posted = self.rfile.read(length).decode()
                if self.path == "/vulnerabilities/exec/" and "ip=127.0.0.1" in posted and "%26%26+id" in posted and "Submit=Submit" in posted:
                    body = b"PING ok\nuid=33(www-data) gid=33(www-data) groups=33(www-data)"
                else:
                    body = f"unexpected {self.path} {posted}".encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            platform = DummyPlatform()
            target = f"http://127.0.0.1:{server.server_port}/vulnerabilities/exec/"
            loop = PentestAgentLoop(
                task={"conversation_id": "conv-cmdi", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": [f"http://127.0.0.1:{server.server_port}"], "deny": []}},
                tools=SimpleNamespace(),
                sandbox=None,
                llm=None,
                platform_sync=platform,
            )
            node = loop.plan_tree.add_node(title="Command injection form", kind="test", endpoint=f"POST {target}", parameter="ip", vuln_type="command_injection")
            tool = next(t for t in make_workflow_tools(loop) if t.name == "run_web_skill")

            result = asyncio.run(tool.handler(node_id=node.node_id))
            asyncio.run(loop._record_autonomy_from_tool("tool-cmdi", "run_web_skill", result, "ev-111111111111"))
            snapshot = loop.checkpoint_snapshot("test")
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(result["status"], "done")
        self.assertIn("Content-Type: application/x-www-form-urlencoded", result["request"])
        self.assertIn("Submit=Submit", result["request"])
        self.assertIn("%26%26+id", result["request"])
        self.assertIn("uid=33", result["body"])
        self.assertTrue(any(row["vuln_type"] == "command_injection" and row["status"] == "failed" for row in snapshot["coverage"]))
        self.assertEqual(len(snapshot["candidate_findings"]), 1)
        self.assertEqual(snapshot["candidate_findings"][0]["vuln_type"], "command_injection")
        self.assertTrue(any(row["node_id"] == node.node_id and row["status"] == "failed" for row in snapshot["exploration_plan_tree"]))
    def test_verify_workflow_runtime_executes_pending_skill_node(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                from urllib.parse import parse_qs, urlparse
                query = parse_qs(urlparse(self.path).query)
                body = (query.get("q") or [""])[0].encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            platform = DummyPlatform()
            target = f"http://127.0.0.1:{server.server_port}/search?q=base"
            loop = PentestAgentLoop(
                task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": [f"http://127.0.0.1:{server.server_port}"], "deny": []}},
                tools=SimpleNamespace(),
                sandbox=None,
                llm=None,
                platform_sync=platform,
                evidence_store=FakeEvidenceStore(ids=()),
            )
            workflow_tool = next(t for t in make_workflow_tools(loop) if t.name == "run_web_skill")
            loop.tools = SimpleNamespace(get=lambda name: workflow_tool if name == "run_web_skill" else None)
            loop.plan_tree.add_node(title="Test reflected XSS", kind="test", endpoint=f"GET {target}", parameter="q", vuln_type="xss")

            executed = asyncio.run(loop._autorun_verify_workflow_nodes(limit=1))
            snapshot = loop.checkpoint_snapshot("test")
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(executed, 1)
        self.assertTrue(any(row["vuln_type"] == "xss" and row["status"] == "failed" for row in snapshot["coverage"]))
        self.assertEqual(len(snapshot["candidate_findings"]), 1)
        self.assertEqual(snapshot["candidate_findings"][0]["status"], "confirmed")
        self.assertEqual(len(snapshot["confirmed_findings"]), 1)
        self.assertTrue(any(node["status"] == "failed" for node in snapshot["exploration_plan_tree"]))
        self.assertTrue(any(event["type"] == "evidence_created" for event in platform.events))
        self.assertTrue(any(event.get("type") == "vuln_found" and event.get("status") == "confirmed" and event.get("vuln_type") == "xss" for event in platform.events))
        self.assertTrue(any("[Workflow Runtime]" in item.get("content", "") for item in loop.history))
    def test_verify_workflow_runtime_auto_confirms_high_confidence_verifier(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                from urllib.parse import parse_qs, urlparse
                query = parse_qs(urlparse(self.path).query)
                ip_value = (query.get("ip") or [""])[0]
                body = b"uid=33(www-data) gid=33(www-data)" if "id" in ip_value else b"PING ok"
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            platform = DummyPlatform()
            target = f"http://127.0.0.1:{server.server_port}/vulnerabilities/exec?ip=127.0.0.1"
            loop = PentestAgentLoop(
                task={"conversation_id": "conv-autoconfirm", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": [f"http://127.0.0.1:{server.server_port}"], "deny": []}},
                tools=SimpleNamespace(),
                sandbox=None,
                llm=None,
                platform_sync=platform,
                evidence_store=FakeEvidenceStore(ids=()),
            )
            workflow_tool = next(t for t in make_workflow_tools(loop) if t.name == "run_web_skill")
            loop.tools = SimpleNamespace(get=lambda name: workflow_tool if name == "run_web_skill" else None)
            loop.plan_tree.add_node(title="Test command injection", kind="test", endpoint=f"GET {target}", parameter="ip", vuln_type="command_injection")

            executed = asyncio.run(loop._autorun_verify_workflow_nodes(limit=1))
            snapshot = loop.checkpoint_snapshot("test")
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(executed, 1)
        self.assertEqual(len(snapshot["candidate_findings"]), 1)
        self.assertEqual(snapshot["candidate_findings"][0]["status"], "confirmed")
        self.assertEqual(len(snapshot["confirmed_findings"]), 1)
        self.assertTrue(snapshot["confirmed_findings"][0]["reproduction_request"].startswith("GET "))
        self.assertTrue(any(event.get("type") == "vuln_found" and event.get("status") == "confirmed" for event in platform.events))
    def test_verify_workflow_runtime_auto_confirms_sql_error_injection(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                from urllib.parse import parse_qs, urlparse
                query = parse_qs(urlparse(self.path).query)
                id_value = (query.get("id") or [""])[0]
                if "'" in id_value:
                    body = b"You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near ''' at line 1"
                else:
                    body = b"ID: 1 First name: admin"
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            platform = DummyPlatform()
            target = f"http://127.0.0.1:{server.server_port}/vulnerabilities/sqli?id=1"
            loop = PentestAgentLoop(
                task={"conversation_id": "conv-sqli-autoconfirm", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": [f"http://127.0.0.1:{server.server_port}"], "deny": []}},
                tools=SimpleNamespace(),
                sandbox=None,
                llm=None,
                platform_sync=platform,
                evidence_store=FakeEvidenceStore(ids=()),
            )
            workflow_tool = next(t for t in make_workflow_tools(loop) if t.name == "run_web_skill")
            loop.tools = SimpleNamespace(get=lambda name: workflow_tool if name == "run_web_skill" else None)
            loop.plan_tree.add_node(title="Test SQL injection", kind="test", endpoint=f"GET {target}", parameter="id", vuln_type="sqli")

            executed = asyncio.run(loop._autorun_verify_workflow_nodes(limit=1))
            snapshot = loop.checkpoint_snapshot("test")
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(executed, 1)
        self.assertEqual(len(snapshot["candidate_findings"]), 1)
        self.assertEqual(snapshot["candidate_findings"][0]["status"], "confirmed")
        self.assertEqual(snapshot["candidate_findings"][0]["vuln_type"], "sql_injection")
        self.assertEqual(len(snapshot["confirmed_findings"]), 1)
        self.assertTrue(any(event.get("type") == "vuln_found" and event.get("status") == "confirmed" and event.get("vuln_type") == "sql_injection" for event in platform.events))
    def test_traffic_rank_candidates_prioritizes_parameterized_requests(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-traffic", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        loop.traffic_capture.record_browser_requests([
            {"method": "GET", "url": "http://target.local/static/app.css", "status_code": 200, "response_headers": {"content-type": "text/css"}, "is_static": True},
            {"method": "POST", "url": "http://target.local/login.php", "body": "username=admin&password=password", "headers": {"content-type": "application/x-www-form-urlencoded"}, "status_code": 200, "response_headers": {"content-type": "text/html", "set-cookie": "PHPSESSID=abc"}, "response_body": "<form></form>"},
            {"method": "GET", "url": "http://target.local/item.php?id=1", "status_code": 200, "response_headers": {"content-type": "text/html"}},
        ], evidence_id="ev-111111111111")
        tools = {tool.name: tool for tool in make_workflow_tools(loop)}

        ranked = asyncio.run(tools["traffic_rank_candidates"].handler(limit=5))

        self.assertEqual(ranked["status"], "ok")
        self.assertEqual(ranked["requests"][0]["method"], "POST")
        self.assertIn("username", ranked["requests"][0]["parameter_names"])
        self.assertFalse(any(row["url"].endswith("app.css") for row in ranked["requests"]))

    def test_attack_surface_extracts_openapi_paths_and_script_routes(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-api-doc", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        openapi = {
            "openapi": "3.0.0",
            "paths": {
                "/api/users/{id}": {"get": {"parameters": [{"name": "id", "in": "path"}]}},
                "/api/login": {"post": {"requestBody": {"content": {"application/json": {"schema": {"properties": {"email": {}, "password": {}}}}}}}},
            },
        }
        created = loop.attack_surface.record_http_result(
            "tool-openapi",
            {"status": "done", "method": "GET", "url": "http://target.local/api-docs/swagger.json", "status_code": 200, "headers": {"content-type": "application/json"}, "body": json.dumps(openapi)},
            "ev-111111111111",
        )
        created.extend(loop.attack_surface.record_http_result(
            "tool-js",
            {"status": "done", "method": "GET", "url": "http://target.local/app.js", "status_code": 200, "headers": {"content-type": "application/javascript"}, "body": "fetch('/rest/products/search?q=apple')"},
            "ev-111111111111",
        ))

        endpoints = {(item.method, item.url, tuple(item.parameters)) for item in created if item.kind == "api_endpoint"}

        self.assertIn(("GET", "http://target.local/api/users/{id}", ("id",)), endpoints)
        self.assertIn(("POST", "http://target.local/api/login", ("email", "password")), endpoints)
        self.assertTrue(any(url == "http://target.local/rest/products/search?q=apple" for _, url, _ in endpoints))
    def test_traffic_context_list_returns_summaries_and_detail_returns_body(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-traffic-detail", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        row = loop.traffic_capture.record_http_result(
            tool_name="http_request",
            result={
                "method": "POST",
                "url": "http://target.local/api/search",
                "request_body": "q=admin",
                "request_headers": {"content-type": "application/x-www-form-urlencoded"},
                "status_code": 200,
                "headers": {"content-type": "application/json"},
                "body": "{\"users\":[{\"email\":\"admin@example.test\",\"passwordHash\":\"abc\"}]}",
            },
            evidence_id="ev-111111111111",
        )
        tools = {tool.name: tool for tool in make_workflow_tools(loop)}

        listed = asyncio.run(tools["traffic_list"].handler(limit=5))
        detail = asyncio.run(tools["traffic_get"].handler(request_id=row["request_id"]))

        self.assertEqual(listed["status"], "ok")
        self.assertNotIn("response_body", listed["requests"][0])
        self.assertIn("api", listed["requests"][0]["traffic_tags"])
        self.assertIn("sensitive_shape", listed["requests"][0]["traffic_tags"])
        self.assertTrue(detail["request"]["response_body"].startswith("{\"users\""))

    def test_browser_history_uses_request_summaries_not_full_captured_requests(self):
        loop = PentestAgentLoop(
            task={},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        result = _browser_result(
            status="ok",
            action="navigate",
            url="http://target.local",
            title="Home",
            captured_requests=[{
                "method": "GET",
                "url": "http://target.local/api/users",
                "status_code": 200,
                "response_headers": {"content-type": "application/json"},
                "response_body": "X" * 5000,
            }],
        )

        content = loop._tool_history_content(result)

        self.assertIn("api/users", content)
        self.assertIn("count", content)
        self.assertNotIn("captured_requests", content)
        self.assertNotIn("XXX", content)

    def test_low_value_and_probe_traffic_do_not_seed_plan_nodes(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-traffic-noise", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        rows = loop.traffic_capture.record_browser_requests([
            {"method": "GET", "url": "http://target.local/socket.io/?EIO=4", "status_code": 200, "response_headers": {"content-type": "text/plain"}},
            {"method": "GET", "url": "http://target.local/i18n/en.json", "status_code": 200, "response_headers": {"content-type": "application/json"}, "response_body": "{}"},
            {"method": "GET", "url": "http://target.local/search?q=%3Cscript%3Ealert(1)%3C/script%3E", "status_code": 200, "response_headers": {"content-type": "text/html"}, "response_body": "probe"},
        ], evidence_id="ev-111111111111")

        created = []
        for row in rows:
            created.extend(loop.plan_tree.seed_from_traffic_request(row, vuln_types=["xss", "sqli"]))

        self.assertEqual(created, [])
    def test_traffic_rank_candidates_excludes_embedded_external_url_paths(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-traffic-malformed", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        malformed = 'http://target.local/rest/products//%22https:/steamcommunity.com/sharedfiles/filedetails?id=1969196030\\%22'
        valid = "http://target.local/rest/products/search?q=apple"
        loop.traffic_capture.record_browser_requests([
            {"method": "GET", "url": malformed, "status_code": 500, "response_headers": {"content-type": "text/html"}, "response_body": "Unexpected path"},
            {"method": "GET", "url": valid, "status_code": 200, "response_headers": {"content-type": "application/json"}, "response_body": "[]"},
        ], evidence_id="ev-111111111111")
        tools = {tool.name: tool for tool in make_workflow_tools(loop)}

        ranked = asyncio.run(tools["traffic_rank_candidates"].handler(limit=10))

        urls = [row["url"] for row in ranked["requests"]]
        self.assertIn(valid, urls)
        self.assertNotIn(malformed, urls)

    def test_browser_autonomy_ignores_embedded_external_url_paths(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-surface-malformed", "target": {"type": "url", "value": "http://target.local"}, "resolved_target": "http://target.local", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        malformed = 'http://target.local/rest/admin/\\"https:/steamcommunity.com/sharedfiles/filedetails?id=1970691216\\"'
        result = {
            "status": "ok",
            "action": "navigate",
            "url": malformed,
            "title": "Error: Unexpected path",
            "body": '<a href="/rest/admin/\\"https:/steamcommunity.com/sharedfiles/filedetails?id=1970691216\\"">bad</a>',
            "requests": [{"method": "GET", "url": malformed, "status_code": 500, "response_headers": {"content-type": "text/html"}, "response_body": "Unexpected path"}],
        }

        asyncio.run(loop._record_autonomy_from_tool("browser-malformed", "browser", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")

        self.assertFalse(any("steamcommunity" in str(item.get("url") or "") for item in snapshot["attack_surface"]))
        self.assertFalse(any("steamcommunity" in str(node.get("target") or "") for node in snapshot["exploration_plan_tree"]))
    def test_attack_surface_seed_prioritizes_high_signal_links_before_truncation(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-seed-priority", "target": {"type": "url", "value": "http://target.local"}, "resolved_target": "http://target.local", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        low_signal_links = "".join(f"<a href='/docs/page-{idx}'>doc</a>" for idx in range(40))
        result = {
            "status": "ok",
            "action": "navigate",
            "url": "http://target.local/index.php",
            "body": low_signal_links + "<a href='/vulnerabilities/exec/'>exec</a>",
        }

        asyncio.run(loop._record_autonomy_from_tool("browser-seed", "browser", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")
        surface_targets = [node["target"] for node in snapshot["exploration_plan_tree"] if node["kind"] == "surface"]

        self.assertTrue(any(str(target).rstrip("/") == "http://target.local/vulnerabilities/exec" for target in surface_targets))
    def test_browser_captured_html_responses_seed_plan_nodes(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-browser-traffic", "target": {"type": "url", "value": "http://target.local"}, "resolved_target": "http://target.local", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        result = {
            "status": "ok",
            "action": "navigate",
            "url": "http://target.local/index.php",
            "body": "<a href='/vulnerabilities/exec'>exec</a>",
            "requests": [
                {
                    "method": "GET",
                    "url": "http://target.local/vulnerabilities/exec",
                    "status_code": 200,
                    "response_headers": {"content-type": "text/html"},
                    "response_body": "".join(f"<a href='/menu-{idx}'>m</a>" for idx in range(30)) + "<form action='/vulnerabilities/exec' method='get'><input name='ip'></form>",
                }
            ],
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-browser", "browser", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")
        test_nodes = [node for node in snapshot["exploration_plan_tree"] if node["kind"] == "test"]
        tests = {(node["parameter"], node["vuln_type"], node["endpoint"]) for node in test_nodes}

        self.assertTrue(any(param == "ip" and vuln == "command_injection" and "vulnerabilities/exec" in endpoint for param, vuln, endpoint in tests))
        self.assertFalse(any(node["parameter"] == "ip" and node["vuln_type"] in {"weak_credentials", "auth_session"} for node in test_nodes))
        self.assertTrue(any(node["parameter"] == "ip" and node["priority"] == 22 for node in test_nodes))
    def test_traffic_request_seeds_request_bound_plan_nodes(self):
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-traffic-plan", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=DummyPlatform(),
        )
        rows = loop.traffic_capture.record_browser_requests([
            {"method": "POST", "url": "http://target.local/search", "body": "q=base", "headers": {"content-type": "application/x-www-form-urlencoded"}, "status_code": 200, "response_headers": {"content-type": "text/html"}, "response_body": "base"},
        ], evidence_id="ev-111111111111")

        created = loop.plan_tree.seed_from_traffic_request(rows[0], vuln_types=["xss", "sqli"])
        tests = [node.to_dict() for node in created if node.kind == "test"]

        self.assertTrue(tests)
        self.assertTrue(all(node["request_id"] == rows[0]["request_id"] for node in tests))
        self.assertTrue(any(node["parameter"] == "q" and node["vuln_type"] == "xss" for node in tests))

    def test_run_web_skill_uses_plan_node_request_id(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                from urllib.parse import parse_qs
                posted = self.rfile.read(length).decode()
                body = (parse_qs(posted).get("q") or [posted])[0].encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            platform = DummyPlatform()
            target = f"http://127.0.0.1:{server.server_port}/search"
            loop = PentestAgentLoop(
                task={"conversation_id": "conv-request-skill", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": [f"http://127.0.0.1:{server.server_port}"], "deny": []}},
                tools=SimpleNamespace(),
                sandbox=None,
                llm=None,
                platform_sync=platform,
            )
            row = loop.traffic_capture.record_http_result(tool_name="browser", result={"method": "POST", "url": target, "request_body": "q=base", "request_headers": {"content-type": "application/x-www-form-urlencoded"}, "status_code": 200, "headers": {"content-type": "text/html"}, "body": "base"})
            node = loop.plan_tree.add_node(title="Request-bound XSS", kind="test", endpoint=f"POST {target}", parameter="q", vuln_type="xss", request_id=row["request_id"])
            tool = next(t for t in make_workflow_tools(loop) if t.name == "run_web_skill")

            result = asyncio.run(tool.handler(node_id=node.node_id))
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(result["status"], "done")
        self.assertEqual(result["source_request_id"], row["request_id"])
        self.assertIn("<script>alert(1337)</script>", result["body"])
    def test_traffic_send_replay_and_mutate_send_real_http_requests(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = f"GET {self.path}".encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                posted = self.rfile.read(length).decode()
                body = f"POST {self.path} {posted}".encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            target = f"http://127.0.0.1:{server.server_port}/login"
            loop = PentestAgentLoop(
                task={"conversation_id": "conv-1", "target": {"type": "url", "value": target}, "resolved_target": target, "scope": {"allow": [f"http://127.0.0.1:{server.server_port}"], "deny": []}},
                tools=SimpleNamespace(),
                sandbox=None,
                llm=None,
                platform_sync=DummyPlatform(),
            )
            loop.traffic_capture.record_http_result(tool_name="http_request", result={"status": "done", "method": "GET", "url": target, "status_code": 200, "headers": {}, "body": "baseline"})
            request_id = loop.traffic_capture.to_list()[0]["request_id"]
            tools = {tool.name: tool for tool in make_workflow_tools(loop)}

            replay = asyncio.run(tools["traffic_send"].handler(request_id=request_id, action="replay"))
            mutated = asyncio.run(tools["traffic_send"].handler(request_id=request_id, action="mutate", method="POST", body="username=admin"))
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(replay["status"], "done")
        self.assertIn("GET /login", replay["body"])
        self.assertEqual(mutated["status"], "done")
        self.assertIn("username=admin", mutated["body"])

    def test_web_phases_allow_http_and_browser_tools(self):
        for phase in ("recon", "verify"):
            self.assertIn("http_request", PHASE_TOOL_NAMES[phase])
            self.assertIn("browser", PHASE_TOOL_NAMES[phase])

    def test_phase_tool_lists_expose_consolidated_workflow_tools(self):
        legacy_names = {
            "capture_list_requests",
            "capture_get_request",
            "traffic_detail",
            "capture_replay_request",
            "capture_mutate_request",
            "plan_update_node",
            "plan_prune_or_complete",
        }
        for phase in ("recon", "analysis", "verify"):
            self.assertIn("traffic_list", PHASE_TOOL_NAMES[phase])
            self.assertIn("traffic_get", PHASE_TOOL_NAMES[phase])
            self.assertIn("traffic_send", PHASE_TOOL_NAMES[phase])
            self.assertIn("plan_update", PHASE_TOOL_NAMES[phase])
            self.assertFalse(PHASE_TOOL_NAMES[phase] & legacy_names)

    def test_conversation_state_uses_checkpoint_progress(self):
        checkpoint = {
            "reason": "tool_output",
            "state": {
                "phase": "analysis",
                "phases_completed": ["intake", "recon"],
                "iteration": 12,
                "phase_iteration": 3,
                "recent_tool_runs": [{"tool_name": "execute", "status": "done"}],
            },
            "candidate_findings": [{"id": "cand-1", "title": "Reflected XSS", "severity": "medium"}],
            "discovered_assets": [{"address": "http://target.local", "asset_type": "url"}],
        }

        agent_state = _agent_state_from_checkpoint(checkpoint)
        progress = _progress_for_checkpoint(checkpoint, "running")
        todos = _todos_for_checkpoint(checkpoint, "running")

        self.assertEqual(agent_state["phase"], "analysis")
        self.assertEqual(agent_state["activeTool"], "execute")
        self.assertEqual(progress, {"current": 3, "total": 6, "percent": 50})
        self.assertEqual([item["status"] for item in todos], ["done", "done", "running", "pending", "pending", "pending"])
        self.assertEqual(_checkpoint_findings(checkpoint)[0]["id"], "cand-1")
        self.assertEqual(_checkpoint_assets(checkpoint)[0]["address"], "http://target.local")

    def test_checkpoint_helpers_tolerate_null_checkpoint(self):
        self.assertEqual(_agent_state_from_checkpoint(None, "running")["phase"], None)
        self.assertEqual(_progress_for_checkpoint(None, "running"), {"current": 1, "total": 6, "percent": 17})
        self.assertEqual([item["status"] for item in _todos_for_checkpoint(None, "running")], ["running", "pending", "pending", "pending", "pending", "pending"])
        self.assertEqual(_checkpoint_findings(None), [])
        self.assertEqual(_checkpoint_assets(None), [])
        self.assertEqual(_checkpoint_plan_tree(None), [])

    def test_checkpoint_plan_tree_helper_normalizes_nodes(self):
        checkpoint = {"exploration_plan_tree": [{"node_id": "plan-1", "title": "Check login", "status": "running", "endpoint": "GET http://target.local"}]}

        nodes = _checkpoint_plan_tree(checkpoint)

        self.assertEqual(nodes[0]["node_id"], "plan-1")
        self.assertEqual(nodes[0]["status"], "running")
        self.assertEqual(nodes[0]["endpoint"], "GET http://target.local")
    def test_checkpoint_completed_current_phase_advances_display_phase(self):
        checkpoint = {
            "reason": "phase_transition",
            "state": {
                "phase": "analysis",
                "phases_completed": ["intake", "recon", "analysis"],
                "iteration": 20,
                "phase_iteration": 999,
            },
        }

        agent_state = _agent_state_from_checkpoint(checkpoint, "running")
        progress = _progress_for_checkpoint(checkpoint, "running")
        todos = _todos_for_checkpoint(checkpoint, "running")

        self.assertEqual(agent_state["phase"], "verify")
        self.assertEqual(progress, {"current": 4, "total": 6, "percent": 67})
        self.assertEqual([item["status"] for item in todos], ["done", "done", "done", "running", "pending", "pending"])

    def test_user_message_route_separates_resume_from_new_assignment(self):
        self.assertEqual(_user_message_route({"text": "continue"}, "completed")["action"], "completed")
        self.assertEqual(
            _user_message_route({"text": "confirm current state", "agent_target": "pentest"}, "completed")["action"],
            "completed_followup",
        )
        self.assertEqual(
            _user_message_route({"text": "\u786e\u8ba4\u4e00\u4e0b DVWA \u5b89\u5168\u7ea7\u522b", "agent_target": "pentest"}, "completed")["action"],
            "completed_followup",
        )
        self.assertEqual(
            _user_message_route({"text": "test http://host.docker.internal:8080/login.php"}, "completed")["action"],
            "completed_followup",
        )
        self.assertEqual(_user_message_route({"text": "continue"}, "running")["action"], "steer_or_resume")
        self.assertEqual(_user_message_route({"text": "continue"}, "failed")["action"], "resume")
        self.assertEqual(
            _user_message_route({"text": "test http://host.docker.internal:8080/login.php"}, "created")["action"],
            "assign",
        )

    def test_resume_message_from_context_preserves_task_and_checkpoint(self):
        msg = {"type": "user_message", "conversation_id": "conv-1", "text": "continue"}
        resume_context = {
            "task": {
                "target": {"type": "url", "value": "http://host.docker.internal:8080/login.php"},
                "scope": {"allow": ["http://host.docker.internal:8080/login.php"], "deny": []},
                "instruction": "Run a DVWA web application pentest",
            },
            "checkpoint": {"phase": "analysis", "state": {"phase": "analysis"}},
        }

        resumed, is_resume = _resume_message_from_context(msg, resume_context)

        self.assertTrue(is_resume)
        self.assertEqual(resumed["target"], resume_context["task"]["target"])
        self.assertEqual(resumed["scope"], resume_context["task"]["scope"])
        self.assertEqual(resumed["checkpoint"], resume_context["checkpoint"])
        self.assertIn("Run a DVWA web application pentest", resumed["text"])
        self.assertIn("continue", resumed["text"])

    def test_completed_followup_resume_can_reset_checkpoint(self):
        msg = {"type": "user_message", "conversation_id": "conv-1", "text": "confirm current state"}
        resume_context = {
            "task": {
                "target": {"type": "url", "value": "http://host.docker.internal:8080/login.php"},
                "scope": {"allow": ["http://host.docker.internal:8080/login.php"], "deny": []},
                "instruction": "Run a DVWA web application pentest",
            },
            "checkpoint": {"phase": "complete", "phases_completed": ["intake", "recon", "analysis", "verify", "report", "complete"]},
        }

        resumed, is_resume = _resume_message_from_context(msg, resume_context, include_checkpoint=False)

        self.assertTrue(is_resume)
        self.assertEqual(resumed["target"], resume_context["task"]["target"])
        self.assertEqual(resumed["scope"], resume_context["task"]["scope"])
        self.assertEqual(resumed["checkpoint"], {})
        self.assertIn("confirm current state", resumed["text"])

    def test_resume_message_requires_durable_target(self):
        resumed, is_resume = _resume_message_from_context({"text": "continue"}, {"task": {}, "checkpoint": {"phase": "analysis"}})
        self.assertIsNone(resumed)
        self.assertFalse(is_resume)

    def test_task_assign_from_user_message_carries_snapshot_only(self):
        msg = {
            "text": "continue",
            "target": {"type": "url", "value": "http://target.local"},
            "scope": {"allow": ["http://target.local"], "deny": []},
            "snapshot": {"counts": {"findings": 1}, "findings": [{"title": "SQLi"}]},
        }

        task_msg = _task_assign_from_user_message("conv-1", msg, "task-1")

        self.assertEqual(task_msg["type"], "task_assign")
        self.assertEqual(task_msg["conversation_id"], "conv-1")
        self.assertEqual(task_msg["task_id"], "task-1")
        self.assertEqual(task_msg["target"], msg["target"])
        self.assertEqual(task_msg["scope"], msg["scope"])
        self.assertNotIn("checkpoint", task_msg)
        self.assertEqual(task_msg["snapshot"], msg["snapshot"])
        self.assertNotIn("goal_objective", task_msg)

    def test_goal_objective_from_message_structured_only(self):
        self.assertEqual(_goal_objective_from_message({}), "")
        # Free-text instruction alone must not invent a goal (no NLP).
        self.assertEqual(
            _goal_objective_from_message({"text": "请尽量多拿 flag 和目标"}),
            "",
        )
        self.assertEqual(
            _goal_objective_from_message({"goal_mode": True}),
            DEFAULT_GOAL_OBJECTIVE,
        )
        self.assertEqual(
            _goal_objective_from_message(
                {"goal_mode": True, "goal_objective": "  Enumerate and book SQLi only  "}
            ),
            "Enumerate and book SQLi only",
        )

    def test_task_assign_carries_goal_objective_when_goal_mode_on(self):
        msg = {
            "text": "Test http://target.local",
            "target": {"type": "url", "value": "http://target.local"},
            "scope": {"allow": ["http://target.local"], "deny": []},
            "goal_mode": True,
            "goal_objective": "Maximize verified flags in scope",
        }
        task_msg = _task_assign_from_user_message("conv-goal", msg, "task-goal")
        self.assertTrue(task_msg.get("goal_mode"))
        self.assertEqual(task_msg.get("goal_objective"), "Maximize verified flags in scope")

    def test_task_assign_carries_expert_pack_engagement(self):
        msg = {
            "text": "Test http://target.local",
            "target": {"type": "url", "value": "http://target.local"},
            "scope": {"allow": ["http://target.local"], "deny": []},
            "engagement": "pentest",
            "role": "pentest",
            "expert_id": "3646a655-c22f-4af8-908e-037d1cec8bc4",
            "expert_name": "\u6e17\u900f",
        }
        task_msg = _task_assign_from_user_message("conv-expert", msg, "task-expert")
        self.assertEqual(task_msg.get("engagement"), "pentest")
        self.assertEqual(task_msg.get("role"), "pentest")
        self.assertEqual(task_msg.get("expert_id"), "3646a655-c22f-4af8-908e-037d1cec8bc4")
        self.assertEqual(task_msg.get("expert_name"), "\u6e17\u900f")
        self.assertEqual(task_msg.get("snapshot", {}).get("engagement"), "pentest")

    def test_resume_preserves_prior_goal_objective(self):
        resume_context = {
            "task": {
                "target": {"type": "url", "value": "http://target.local"},
                "scope": {"allow": ["http://target.local"]},
                "instruction": "prior instruction",
                "goal_objective": "Maximize verified flags in scope",
            }
        }
        resumed, is_resume = _resume_message_from_context({"text": "继续"}, resume_context)
        self.assertTrue(is_resume)
        self.assertEqual(resumed.get("goal_objective"), "Maximize verified flags in scope")
        self.assertTrue(resumed.get("goal_mode"))

    def test_build_conversation_snapshot_restores_checkpoint_runtime_structures(self):
        conv_id = uuid.uuid4()
        user_id = uuid.uuid4()
        checkpoint = {
            "phase": "verify",
            "state": {"phase": "verify", "phases_completed": ["intake", "recon", "analysis"]},
            "attack_surface": [{"kind": "form", "url": "http://target.local/login", "method": "POST"}],
            "coverage": [{"endpoint": "POST http://target.local/login", "parameter": "username", "vuln_type": "sqli", "status": "tried"}],
            "captured_traffic": [{"request_id": "req-1", "method": "POST", "url": "http://target.local/login"}],
            "exploration_plan_tree": [{"node_id": "plan-1", "title": "Verify login SQLi", "kind": "test", "status": "pending"}],
            "candidate_findings": [{"id": "finding-1", "title": "SQL injection", "severity": "high"}],
            "discovered_assets": [{"address": "http://target.local", "asset_type": "web"}],
        }
        task_context = {"target": {"type": "url", "value": "http://target.local"}, "scope": {"allow": ["http://target.local"]}}
        conversation = Conversation(id=conv_id, user_id=user_id, status="running", context={"checkpoint": checkpoint, "task": task_context})
        messages = [Message(id=uuid.uuid4(), conversation_id=conv_id, role="user", msg_type="text", content={"text": "@pentest continue"})]

        class Result:
            def __init__(self, rows):
                self.rows = rows

            def scalars(self):
                return self

            def all(self):
                return self.rows

        class FakeDB:
            def __init__(self):
                self.results = [messages, [], [], []]

            async def execute(self, _query):
                return Result(self.results.pop(0))

            async def rollback(self):
                pass

        snapshot = asyncio.run(_build_conversation_snapshot(FakeDB(), conversation, user_id))

        self.assertEqual(snapshot["checkpoint"], checkpoint)
        self.assertEqual(snapshot["attack_surface"], checkpoint["attack_surface"])
        self.assertEqual(snapshot["coverage"], checkpoint["coverage"])
        self.assertEqual(snapshot["captured_traffic"], checkpoint["captured_traffic"])
        self.assertEqual(snapshot["counts"]["attack_surface"], 1)
        self.assertEqual(snapshot["counts"]["coverage"], 1)
        self.assertEqual(snapshot["counts"]["captured_traffic"], 1)
        self.assertTrue(any(item["content"].get("text") == "@pentest continue" for item in snapshot["messages"]))
        self.assertTrue(any(item.get("title") == "SQL injection" for item in snapshot["findings"]))
        self.assertTrue(any(item.get("address") == "http://target.local" for item in snapshot["assets"]))
    def test_snapshot_messages_keep_main_content_and_omit_tool_detail(self):
        conv_id = uuid.uuid4()
        messages = [
            Message(id=uuid.uuid4(), conversation_id=conv_id, role="user", msg_type="text", content={"text": "@pentest summarize"}),
            Message(id=uuid.uuid4(), conversation_id=conv_id, role="agent", msg_type="tool_call", content={"tool_name": "http_request", "tool_run_id": "run-1", "stdout": "x" * 2000, "evidence_id": "ev-1"}),
        ]

        compacted, omitted = _snapshot_messages(messages, limit=10)

        self.assertEqual(compacted[0]["content"]["text"], "@pentest summarize")
        self.assertEqual(compacted[1]["content"]["tool_name"], "http_request")
        self.assertEqual(compacted[1]["content"]["evidence_id"], "ev-1")
        self.assertLess(len(compacted[1]["content"]["stdout"]), 1000)
        self.assertGreater(omitted["tool_stdout_chars"], 0)

    def test_task_context_prompt_includes_shared_session_snapshot(self):
        loop = PentestAgentLoop(
            task={
                "instruction": "continue",
                "target": {"type": "url", "value": "http://target.local"},
                "scope": {"allow": ["http://target.local"], "deny": []},
                "snapshot": {
                    "conversation": {"status": "completed"},
                    "counts": {"findings": 1, "plan_tree": 1},
                    "findings": [{"title": "SQL injection", "severity": "critical", "status": "confirmed"}],
                    "plan_tree": [{"title": "Verify login", "status": "pending", "endpoint": "POST http://target.local/login"}],
                    "messages": [{"role": "user", "content": {"text": "@pentest evaluate"}}],
                },
            },
            tools=SimpleNamespace(),
            sandbox=SimpleNamespace(),
            llm=SimpleNamespace(),
            platform_sync=DummyPlatform(),
            evidence_store=SimpleNamespace(),
        )

        prompt = loop._task_context_prompt(Phase.VERIFY)

        self.assertIn("[Session Snapshot - shared platform context]", prompt)
        self.assertIn("SQL injection", prompt)
        self.assertIn("Verify login", prompt)
        self.assertIn("@pentest evaluate", prompt)

    def test_status_machine_allows_unfinished_resume_but_not_completed(self):
        failed = Conversation(status="failed")
        transition_conversation(failed, "running")
        self.assertEqual(failed.status, "running")

        canceled = Conversation(status="canceled")
        transition_conversation(canceled, "running")
        self.assertEqual(canceled.status, "running")

        completed = Conversation(status="completed")
        transition_conversation(completed, "running")
        self.assertEqual(completed.status, "running")


if __name__ == "__main__":
    unittest.main()










