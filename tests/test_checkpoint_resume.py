import sys
import asyncio
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))
sys.path.insert(0, str(ROOT / "platform" / "backend"))

from app.api.conversations import (  # noqa: E402
    _agent_state_from_checkpoint,
    _checkpoint_assets,
    _checkpoint_findings,
    _progress_for_checkpoint,
    _todos_for_checkpoint,
)
from app.models.conversation import Conversation  # noqa: E402
from app.services.conversation_state import ConversationStatusError, transition_conversation  # noqa: E402
from app.ws.router import _resume_message_from_context, _task_assign_from_user_message, _user_message_route  # noqa: E402
from pentest_node.agent.intake import TaskIntake  # noqa: E402
from pentest_node.agent.loop import PentestAgentLoop  # noqa: E402
from pentest_node.agent.state import Phase  # noqa: E402


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
            "phase": "scan",
            "resolved_target": "http://host.docker.internal:8080/login.php",
            "state": {
                "phase": "scan",
                "phases_completed": ["precheck", "plan", "recon"],
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
        self.assertEqual(loop.state.phase, Phase.SCAN)
        self.assertEqual(loop.state.iteration, 17)
        self.assertEqual(loop.state.phase_iteration, 4)
        self.assertEqual({p.value for p in loop.state.phases_completed}, {"precheck", "plan", "recon"})
        self.assertEqual(loop.task["resolved_target"], checkpoint["resolved_target"])
        self.assertEqual(loop.candidate_findings[0]["id"], "f1")
        self.assertEqual(loop.discovered_assets[0]["address"], "host.docker.internal")

        snapshot = loop.checkpoint_snapshot("test")
        self.assertEqual(snapshot["phase"], "scan")
        self.assertEqual(snapshot["iteration"], 17)
        self.assertIn("recon", snapshot["phases_completed"])

    def test_conversation_state_uses_checkpoint_progress(self):
        checkpoint = {
            "reason": "tool_output",
            "state": {
                "phase": "scan",
                "phases_completed": ["precheck", "plan", "recon"],
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

        self.assertEqual(agent_state["phase"], "scan")
        self.assertEqual(agent_state["activeTool"], "execute")
        self.assertEqual(progress, {"current": 4, "total": 6, "percent": 67})
        self.assertEqual([item["status"] for item in todos], ["done", "done", "done", "running", "pending", "pending"])
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
                "phase": "scan",
                "phases_completed": ["precheck", "plan", "recon", "scan"],
                "iteration": 20,
                "phase_iteration": 999,
            },
        }

        agent_state = _agent_state_from_checkpoint(checkpoint, "running")
        progress = _progress_for_checkpoint(checkpoint, "running")
        todos = _todos_for_checkpoint(checkpoint, "running")

        self.assertEqual(agent_state["phase"], "verify")
        self.assertEqual(progress, {"current": 5, "total": 6, "percent": 83})
        self.assertEqual([item["status"] for item in todos], ["done", "done", "done", "done", "running", "pending"])

    def test_user_message_route_separates_resume_from_new_assignment(self):
        self.assertEqual(_user_message_route({"text": "continue"}, "completed")["action"], "completed")
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
            "checkpoint": {"phase": "scan", "state": {"phase": "scan"}},
        }

        resumed, is_resume = _resume_message_from_context(msg, resume_context)

        self.assertTrue(is_resume)
        self.assertEqual(resumed["target"], resume_context["task"]["target"])
        self.assertEqual(resumed["scope"], resume_context["task"]["scope"])
        self.assertEqual(resumed["checkpoint"], resume_context["checkpoint"])
        self.assertIn("Run a DVWA web application pentest", resumed["text"])
        self.assertIn("continue", resumed["text"])

    def test_resume_message_requires_durable_target(self):
        resumed, is_resume = _resume_message_from_context({"text": "continue"}, {"task": {}, "checkpoint": {"phase": "scan"}})
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
        with self.assertRaises(ConversationStatusError):
            transition_conversation(completed, "running")


if __name__ == "__main__":
    unittest.main()
