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
from pentest_node.agent.loop import PHASE_TOOL_NAMES, PentestAgentLoop  # noqa: E402
from pentest_node.agent.state import Phase  # noqa: E402
from pentest_node.tools.workflow import make_workflow_tools  # noqa: E402


class DummyPlatform:
    def __init__(self):
        self.events = []

    async def send(self, event):
        self.events.append(event)

class CheckpointResumeTests(unittest.TestCase):
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
                    "evidence_ids": ["ev-1"],
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
            task={"conversation_id": "conv-1"},
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

        asyncio.run(loop._record_autonomy_from_tool("tool-1", "http_request", result, "ev-1"))
        snapshot = loop.checkpoint_snapshot("test")

        kinds = {item["kind"] for item in snapshot["attack_surface"]}
        self.assertIn("url", kinds)
        self.assertIn("form", kinds)
        self.assertTrue(any(item["method"] == "POST" and "username" in item["parameters"] for item in snapshot["attack_surface"]))
        self.assertTrue(any(event["type"] == "attack_surface_discovered" for event in platform.events))

    def test_mark_coverage_tool_updates_checkpoint(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1"},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        tool = next(t for t in make_workflow_tools(loop) if t.name == "mark_coverage")

        result = asyncio.run(tool.handler(
            endpoint="POST http://target.local/login.php?debug=1",
            parameter="username",
            vuln_type="sqli",
            status="passed",
            notes="No SQL error or timing difference observed",
            evidence_ids=["ev-1"],
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
        )
        loop.candidate_findings.append({"id": "cand-1", "title": "SQLi", "severity": "high", "status": "candidate"})
        tool = next(t for t in make_workflow_tools(loop) if t.name == "confirm_finding")

        result = asyncio.run(tool.handler(candidate_finding_id="cand-1", evidence_ids=["ev-1"]))

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
        )
        loop.candidate_findings.append({"id": "cand-1", "title": "SQLi", "severity": "high", "status": "candidate"})
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
            evidence_ids=["ev-1"],
        ))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(loop.confirmed_findings[0]["target_url"], "http://target.local/login.php")
        self.assertTrue(any(event["type"] == "vuln_found" and event["status"] == "confirmed" for event in platform.events))
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
            evidence_id="ev-1",
        )
        loop.coverage.mark(
            endpoint="POST http://target.local/login.php",
            parameter="username",
            vuln_type="sqli",
            status="passed",
            evidence_ids=["ev-1"],
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
