import sys
import asyncio
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))
sys.path.insert(0, str(ROOT / "platform" / "backend"))

from app.services.conversation_snapshot import (  # noqa: E402
    agent_state_from_checkpoint as _agent_state_from_checkpoint,
    checkpoint_assets as _checkpoint_assets,
    checkpoint_findings as _checkpoint_findings,
    progress_for_checkpoint as _progress_for_checkpoint,
    todos_for_checkpoint as _todos_for_checkpoint,
)
from app.models.conversation import Conversation  # noqa: E402
from app.services.conversation_state import transition_conversation  # noqa: E402
from app.ws.router import _resume_message_from_context, _task_assign_from_user_message, _user_message_route  # noqa: E402
from pentest_node.agent.intake import TaskIntake  # noqa: E402
from pentest_node.agent.loop import PHASE_TOOL_NAMES, PhaseGateError, PentestAgentLoop  # noqa: E402
from pentest_node.agent.state import Phase  # noqa: E402
from pentest_node.agent.llm import LLMClient  # noqa: E402
from pentest_node.tools.browser import _playwright_install_error  # noqa: E402
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
        self.records = [SimpleNamespace(evidence_id=eid, summary="HTTP POST http://target.local/login.php returned SQL error", raw_ref="") for eid in ids]

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
        self.assertIsNone(loop._phase_gate_error(Phase.COMPLETE))

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

        loop.coverage.mark(endpoint=f"GET {target}", parameter="<none>", vuln_type="xss", status="skipped", notes="not applicable")
        self.assertIn("all coverage records are skipped", loop._phase_gate_error(Phase.COMPLETE))

        loop.coverage.mark(endpoint=f"GET {target}", parameter="q", vuln_type="xss", status="tried", evidence_ids=["ev-111111111111"])
        self.assertIsNone(loop._phase_gate_error(Phase.COMPLETE))

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

    def test_web_phases_allow_http_and_browser_tools(self):
        for phase in ("recon", "verify"):
            self.assertIn("http_request", PHASE_TOOL_NAMES[phase])
            self.assertIn("browser", PHASE_TOOL_NAMES[phase])

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

    def test_task_assign_from_user_message_carries_checkpoint(self):
        msg = {
            "text": "continue",
            "target": {"type": "url", "value": "http://target.local"},
            "scope": {"allow": ["http://target.local"], "deny": []},
            "checkpoint": {"phase": "verify"},
        }

        task_msg = _task_assign_from_user_message("conv-1", msg, "task-1")

        self.assertEqual(task_msg["type"], "task_assign")
        self.assertEqual(task_msg["conversation_id"], "conv-1")
        self.assertEqual(task_msg["task_id"], "task-1")
        self.assertEqual(task_msg["target"], msg["target"])
        self.assertEqual(task_msg["scope"], msg["scope"])
        self.assertEqual(task_msg["checkpoint"], msg["checkpoint"])

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


