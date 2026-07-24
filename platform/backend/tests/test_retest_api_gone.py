"""N1: product retest HTTP is gone — no Conversation / free OMP side effects."""
from __future__ import annotations

import asyncio
import inspect
import unittest

from fastapi import HTTPException

from app.api import vulnerabilities as vulns
from app.ws.router import _task_assign_from_user_message


class TestRetestApiGone(unittest.TestCase):
    def test_retest_handler_raises_410_without_side_effects(self):
        src = inspect.getsource(vulns.retest_vuln_gone)
        self.assertIn("410", src)
        # No product retest launch artifacts in executable body (docstring may mention terms)
        body = src.split('"""', 2)[-1] if '"""' in src else src
        self.assertNotIn("Conversation(", body)
        self.assertNotIn("_dispatch", body)
        self.assertNotIn("db.add", body)
        self.assertNotIn("vuln.retest", body)

        async def call():
            with self.assertRaises(HTTPException) as cm:
                await vulns.retest_vuln_gone(
                    vuln_id="00000000-0000-0000-0000-000000000099",
                    current_user={"user_id": "00000000-0000-0000-0000-000000000001"},
                )
            self.assertEqual(cm.exception.status_code, 410)

        asyncio.run(call())

    def test_dispatch_helper_refuses_retest_engagement(self):
        src = inspect.getsource(vulns._dispatch_vuln_session_if_possible)
        self.assertIn("refusing free engagement=retest", src)
        self.assertNotIn('engagement: str = "retest"', src)

    def test_task_assign_carries_f1_fields(self):
        out = _task_assign_from_user_message(
            "conv-1",
            {
                "text": "dig deeper",
                "target": {"type": "url", "value": "http://lab"},
                "retest_finding_ids": ["v1", "v2"],
                "focus_note": " authz ",
            },
            "task-1",
        )
        self.assertEqual(out["retest_finding_ids"], ["v1", "v2"])
        self.assertEqual(out["focus_note"], "authz")
        bare = _task_assign_from_user_message(
            "conv-1",
            {"text": "please retest all vulns", "target": {}},
            "task-2",
        )
        self.assertNotIn("retest_finding_ids", bare)
        self.assertNotIn("focus_note", bare)


if __name__ == "__main__":
    unittest.main()
