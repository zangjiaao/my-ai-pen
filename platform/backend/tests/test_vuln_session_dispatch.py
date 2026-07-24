"""Vuln-adjacent session dispatch + focus envelope (map #81 N1 / focus fields)."""
from __future__ import annotations

import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.api import vulnerabilities as vulns
from app.ws.router import _task_assign_from_user_message


def _fake_ws_router(fake_ws: AsyncMock):
    """Minimal router surface used by _dispatch_vuln_session_if_possible."""
    return SimpleNamespace(
        node_connections={"node-1": fake_ws},
        _conversation_snapshot=AsyncMock(return_value={}),
        _gate_engagement_for_node=AsyncMock(return_value=None),
        _attach_case_context_to_task_assign=AsyncMock(side_effect=lambda _c, m: m),
        _worker_limits_for_node=AsyncMock(return_value=None),
        _bind_conversation_to_node=AsyncMock(return_value=None),
        _incr_sessions=AsyncMock(return_value=None),
    )


class TestVulnSessionDispatch(unittest.IsolatedAsyncioTestCase):
    async def test_dispatch_refuses_retest_and_unknown_engagement(self):
        ok = await vulns._dispatch_vuln_session_if_possible(
            "conv",
            "user",
            {"type": "url", "value": "http://x"},
            {"allow": []},
            "hi",
            engagement="retest",
        )
        self.assertFalse(ok)

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
        router = _fake_ws_router(fake_ws)

        # Helper does `from app.ws import router as ws_router` at call time.
        with patch("app.ws.router", router):
            ok = await vulns._dispatch_vuln_session_if_possible(
                "conv",
                "user",
                {"type": "url", "value": "http://x"},
                {"allow": ["http://x"]},
                "draft report",
                engagement="consult",
            )

        self.assertTrue(ok)
        fake_ws.send_text.assert_awaited_once()
        payload = json.loads(fake_ws.send_text.await_args.args[0])
        self.assertEqual(payload.get("engagement"), "consult")
        self.assertEqual(payload.get("type"), "task_assign")

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
        # Legacy retest_* wire removed
        legacy = _task_assign_from_user_message(
            "conv-1",
            {"text": "dig", "retest_finding_ids": ["old"], "target": {}},
            "task-legacy",
        )
        self.assertNotIn("focus_finding_ids", legacy)
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
        paths = [getattr(r, "path", None) for r in vulns.router.routes]
        self.assertTrue(all(p is None or "/retest" not in str(p) for p in paths))


if __name__ == "__main__":
    unittest.main()
