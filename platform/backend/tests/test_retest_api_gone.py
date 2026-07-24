"""N1: product retest HTTP removed — no free retest dispatch path."""
from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from app.api import vulnerabilities as vulns
from app.ws.router import _task_assign_from_user_message


class TestRetestApiGone(unittest.IsolatedAsyncioTestCase):
    async def test_dispatch_refuses_retest_and_unknown_engagement(self):
        with patch.object(vulns, "print"):  # silence
            ok = await vulns._dispatch_vuln_session_if_possible(
                "conv",
                "user",
                {"type": "url", "value": "http://x"},
                {"allow": []},
                "hi",
                engagement="retest",
            )
        self.assertFalse(ok)

        with patch.object(vulns, "print"):
            ok2 = await vulns._dispatch_vuln_session_if_possible(
                "conv",
                "user",
                {"type": "url", "value": "http://x"},
                {"allow": []},
                "hi",
                engagement="not-a-real-mode",
            )
        self.assertFalse(ok2)

    async def test_dispatch_consult_sends_when_node_online(self):
        fake_ws = AsyncMock()
        fake_ws.send_text = AsyncMock()

        class FakeRouter:
            node_connections = {"node-1": fake_ws}

            async def _conversation_snapshot(self, conv_id, user_id):
                return {}

            async def _gate_engagement_for_node(self, node_id, eng):
                return None

            async def _attach_case_context_to_task_assign(self, conv_id, task_msg):
                return task_msg

            async def _worker_limits_for_node(self, node_id):
                return None

            async def _bind_conversation_to_node(self, conv_id, node_id):
                return None

            async def _incr_sessions(self, node_id, delta):
                return None

        with patch.dict("sys.modules", {}):
            with patch("app.ws.router", FakeRouter(), create=True):
                # Import path uses `from app.ws import router as ws_router` inside helper
                import app.ws as ws_pkg

                with patch.object(ws_pkg, "router", FakeRouter()):
                    ok = await vulns._dispatch_vuln_session_if_possible(
                        "conv",
                        "user",
                        {"type": "url", "value": "http://x"},
                        {"allow": ["http://x"]},
                        "draft report",
                        engagement="consult",
                    )
        self.assertTrue(ok)
        fake_ws.send_text.assert_awaited()
        payload = fake_ws.send_text.await_args.args[0]
        self.assertIn('"engagement": "consult"', payload)

    def test_task_assign_carries_focus_fields(self):
        out = _task_assign_from_user_message(
            "conv-1",
            {
                "text": "dig deeper",
                "target": {"type": "url", "value": "http://lab"},
                "focus_finding_ids": ["v1", "v2"],
                "focus_note": " authz ",
            },
            "task-1",
        )
        self.assertEqual(out["focus_finding_ids"], ["v1", "v2"])
        self.assertEqual(out["focus_note"], "authz")
        # Legacy alias
        legacy = _task_assign_from_user_message(
            "conv-1",
            {
                "text": "dig",
                "retest_finding_ids": ["old"],
                "target": {},
            },
            "task-legacy",
        )
        self.assertEqual(legacy["focus_finding_ids"], ["old"])
        bare = _task_assign_from_user_message(
            "conv-1",
            {"text": "please retest all vulns", "target": {}},
            "task-2",
        )
        self.assertNotIn("focus_finding_ids", bare)
        self.assertNotIn("focus_note", bare)

    def test_no_retest_route_handler(self):
        self.assertFalse(hasattr(vulns, "retest_vuln_gone"))
        self.assertFalse(hasattr(vulns, "retest_vuln"))
        # Route table should not register POST retest
        paths = [getattr(r, "path", None) for r in vulns.router.routes]
        self.assertTrue(all(p is None or "/retest" not in str(p) for p in paths))


if __name__ == "__main__":
    unittest.main()
