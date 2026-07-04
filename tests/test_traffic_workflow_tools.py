import asyncio
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.agent.loop import PHASE_TOOL_NAMES, PentestAgentLoop  # noqa: E402
from pentest_node.tools.workflow import make_workflow_tools  # noqa: E402


class DummyPlatform:
    def __init__(self):
        self.events = []

    async def send(self, event):
        self.events.append(event)


def _loop(target: str, platform: DummyPlatform) -> PentestAgentLoop:
    return PentestAgentLoop(
        task={
            "conversation_id": "conv-traffic-tools",
            "target": {"type": "url", "value": target},
            "resolved_target": target,
            "scope": {"allow": [target], "deny": []},
        },
        tools=SimpleNamespace(),
        sandbox=None,
        llm=None,
        platform_sync=platform,
    )


class TrafficWorkflowToolTests(unittest.TestCase):
    def test_phase_tool_lists_expose_traffic_analysis_and_batch_mutation(self):
        self.assertIn("traffic_analyze", PHASE_TOOL_NAMES["recon"])
        self.assertIn("traffic_analyze", PHASE_TOOL_NAMES["analysis"])
        self.assertIn("traffic_analyze", PHASE_TOOL_NAMES["verify"])
        self.assertIn("traffic_batch_mutate", PHASE_TOOL_NAMES["verify"])
        self.assertNotIn("traffic_batch_mutate", PHASE_TOOL_NAMES["analysis"])

    def test_traffic_analyze_groups_parameterized_requests(self):
        platform = DummyPlatform()
        target = "http://target.local/"
        loop = _loop(target, platform)
        loop.traffic_capture.record_http_result(
            tool_name="http_request",
            result={
                "method": "GET",
                "url": "http://target.local/search?q=base",
                "status_code": 200,
                "headers": {"content-type": "text/html"},
                "body": "<html>base</html>",
                "request": "GET http://target.local/search?q=base HTTP/1.1\nHost: target.local",
            },
            evidence_id="ev-111111111111",
        )
        loop.traffic_capture.record_http_result(
            tool_name="http_request",
            result={
                "method": "POST",
                "url": "http://target.local/login",
                "request_body": "username=admin&password=admin",
                "status_code": 200,
                "headers": {"content-type": "text/html"},
                "body": "<form></form>",
                "request": "POST http://target.local/login HTTP/1.1\nHost: target.local\n\nusername=admin&password=admin",
            },
            evidence_id="ev-222222222222",
        )
        tools = {tool.name: tool for tool in make_workflow_tools(loop)}

        result = asyncio.run(tools["traffic_analyze"].handler(limit=20))

        self.assertEqual(result["status"], "ok")
        self.assertGreaterEqual(result["analysis"]["by_parameter"]["q"], 1)
        self.assertGreaterEqual(result["analysis"]["by_parameter"]["username"], 1)
        self.assertTrue(result["analysis"]["recommendations"])

    def test_traffic_batch_mutate_marks_failed_coverage_from_verifier(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
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
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            platform = DummyPlatform()
            loop = _loop(base, platform)
            recorded = loop.traffic_capture.record_http_result(
                tool_name="http_request",
                result={
                    "method": "GET",
                    "url": f"{base}/search?q=base",
                    "status_code": 200,
                    "headers": {"content-type": "text/html"},
                    "body": "base",
                    "request": f"GET {base}/search?q=base HTTP/1.1\nHost: 127.0.0.1",
                },
                evidence_id="ev-111111111111",
            )
            tools = {tool.name: tool for tool in make_workflow_tools(loop)}

            result = asyncio.run(tools["traffic_batch_mutate"].handler(
                request_ids=[recorded["request_id"]],
                vuln_type="xss",
                payloads=["<img src=x onerror=alert(1)>"],
                limit=1,
                max_payloads=1,
            ))
            asyncio.run(loop._record_autonomy_from_tool("tool-batch", "traffic_batch_mutate", result, "ev-333333333333"))

            snapshot = loop.checkpoint_snapshot("test")
            self.assertEqual(result["status"], "done")
            self.assertEqual(result["summary"]["failed_signals"], 1)
            self.assertTrue(any(entry["vuln_type"] == "xss" and entry["status"] == "failed" for entry in snapshot["coverage"]))
            self.assertTrue(any(finding.get("vuln_type") == "xss" for finding in snapshot["candidate_findings"]))
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
