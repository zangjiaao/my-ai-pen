import sys
import asyncio
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.agent.loop import PHASE_TOOL_NAMES, PentestAgentLoop  # noqa: E402
from pentest_node.agent.verifiers import evaluate_web_probe  # noqa: E402
from pentest_node.tools.workflow import make_workflow_tools  # noqa: E402


class DummyPlatform:
    def __init__(self):
        self.events = []

    async def send(self, event):
        self.events.append(event)


class WebVerifierTests(unittest.TestCase):
    def test_sqli_basic_fails_on_sql_error_pattern(self):
        result = evaluate_web_probe(
            vuln_type="sqli",
            target_url="http://target.local/login.php",
            method="POST",
            parameter="username",
            payload="'",
            baseline_body="login failed",
            probe_body="You have an error in your SQL syntax near '\\'' MySQL",
            evidence_ids=["ev-1"],
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.candidate["vuln_type"], "sql_injection")
        self.assertEqual(result.evidence_ids, ["ev-1"])

    def test_auth_session_flags_weak_cookie(self):
        result = evaluate_web_probe(
            vuln_type="auth_session",
            target_url="http://target.local/login.php",
            method="GET",
            response_headers={"set-cookie": "PHPSESSID=abc123; Path=/"},
            evidence_ids=["ev-cookie"],
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.candidate["vuln_type"], "auth_session")
        self.assertIn("httponly", result.coverage_notes.lower())

    def test_idor_access_control_denied_probe_passes(self):
        result = evaluate_web_probe(
            vuln_type="idor",
            target_url="http://target.local/api/user/2",
            method="GET",
            parameter="id",
            payload="2",
            probe_body="Forbidden",
            status_code=403,
            evidence_ids=["ev-idor"],
        )

        self.assertEqual(result.status, "passed")
        self.assertEqual(result.vuln_type, "idor")

    def test_idor_access_control_allows_suspicious_probe(self):
        result = evaluate_web_probe(
            vuln_type="idor",
            target_url="http://target.local/api/user/2",
            method="GET",
            parameter="id",
            payload="2",
            baseline_body="{\"id\":1}",
            probe_body="{\"id\":2,\"email\":\"user2@example.test\"}",
            status_code=200,
            evidence_ids=["ev-idor"],
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.candidate["vuln_type"], "idor")
    def test_workflow_web_verifier_marks_coverage_and_candidate(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1"},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        tool = next(t for t in make_workflow_tools(loop) if t.name == "evaluate_web_verifier")

        result = asyncio.run(tool.handler(
            vuln_type="xss",
            target_url="http://target.local/search.php",
            method="GET",
            parameter="q",
            payload="<script>alert(1)</script>",
            probe_body="<html><script>alert(1)</script></html>",
            evidence_ids=["ev-2"],
        ))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["verifier"]["status"], "failed")
        self.assertEqual(loop.coverage.summary()["by_status"]["failed"], 1)
        self.assertEqual(len(loop.candidate_findings), 1)
        self.assertTrue(any(event["type"] == "coverage_marked" for event in platform.events))
        self.assertTrue(any(event["type"] == "vuln_found" for event in platform.events))

    def test_verify_phase_allows_web_verifier_tool(self):
        self.assertIn("evaluate_web_verifier", PHASE_TOOL_NAMES["verify"])


if __name__ == "__main__":
    unittest.main()