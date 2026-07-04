import asyncio
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.agent.loop import PHASE_TOOL_NAMES, PentestAgentLoop  # noqa: E402
from pentest_node.tools.security import (  # noqa: E402
    make_content_discovery_tool,
    make_web_fingerprint_tool,
    parse_content_discovery_output,
    parse_web_fingerprint_output,
)


class DummyPlatform:
    def __init__(self):
        self.events = []

    async def send(self, event):
        self.events.append(event)


class FakeSandbox:
    def __init__(self, stdout="", stderr="", exit_code=0):
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code
        self.commands = []

    async def execute(self, command, timeout=600):
        self.commands.append((command, timeout))
        return {"stdout": self.stdout, "stderr": self.stderr, "exit_code": self.exit_code}


class SecurityToolTests(unittest.TestCase):
    def test_recon_phase_exposes_typed_security_tools(self):
        self.assertIn("web_fingerprint", PHASE_TOOL_NAMES["recon"])
        self.assertIn("content_discovery", PHASE_TOOL_NAMES["recon"])

    def test_parse_web_fingerprint_jsonl(self):
        stdout = json.dumps({
            "url": "http://target.local/",
            "status_code": 200,
            "title": "Target",
            "tech": ["nginx", "PHP"],
            "webserver": "nginx",
            "cdn_name": "cloudflare",
        })

        rows = parse_web_fingerprint_output(stdout, fallback_url="http://target.local/")

        self.assertEqual(rows[0]["url"], "http://target.local/")
        self.assertEqual(rows[0]["status_code"], 200)
        self.assertIn("PHP", rows[0]["technologies"])
        self.assertEqual(rows[0]["server"], "nginx")

    def test_parse_content_discovery_ffuf_json_and_text(self):
        ffuf_stdout = json.dumps({
            "results": [
                {"url": "http://target.local/admin", "status": 200, "length": 123},
                {"url": "http://target.local/missing", "status": 404, "length": 0},
            ]
        })
        text_stdout = "/api-docs (Status: 200) [Size: 321]\n"

        ffuf_rows = parse_content_discovery_output(ffuf_stdout, base_url="http://target.local/")
        text_rows = parse_content_discovery_output(text_stdout, base_url="http://target.local/")

        self.assertEqual([row["url"] for row in ffuf_rows], ["http://target.local/admin"])
        self.assertEqual(text_rows[0]["url"], "http://target.local/api-docs")
        self.assertEqual(text_rows[0]["status_code"], 200)

    def test_typed_tools_block_out_of_scope_targets(self):
        scope = {"allow": ["http://target.local"], "deny": []}
        sandbox = FakeSandbox()
        tool = make_web_fingerprint_tool(sandbox, scope=scope)

        result = asyncio.run(tool.handler(target_url="http://evil.local", reason="test"))

        self.assertEqual(result["status"], "blocked")
        self.assertFalse(sandbox.commands)

    def test_content_discovery_result_seeds_attack_surface_and_plan(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={
                "conversation_id": "conv-security-tools",
                "target": {"type": "url", "value": "http://target.local/"},
                "resolved_target": "http://target.local/",
                "scope": {"allow": ["http://target.local"], "deny": []},
            },
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        result = {
            "status": "done",
            "discoveries": [
                {"url": "http://target.local/admin", "method": "GET", "status_code": 200, "length": 99},
                {"url": "http://target.local/api-docs", "method": "GET", "status_code": 200, "length": 99},
            ],
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-content", "content_discovery", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")

        urls = {item.get("url") for item in snapshot["attack_surface"]}
        self.assertIn("http://target.local/admin", urls)
        self.assertIn("http://target.local/api-docs", urls)
        self.assertGreater(snapshot["plan_tree_summary"]["total"], 1)
        self.assertTrue(any(event.get("type") == "attack_surface_discovered" for event in platform.events))

    def test_web_fingerprint_result_records_technology_hints(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={
                "conversation_id": "conv-fingerprint",
                "target": {"type": "url", "value": "http://target.local/"},
                "resolved_target": "http://target.local/",
                "scope": {"allow": ["http://target.local"], "deny": []},
            },
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
        )
        result = {
            "status": "done",
            "fingerprints": [{
                "url": "http://target.local/",
                "status_code": 200,
                "title": "Target",
                "server": "nginx",
                "cdn": "",
                "technologies": ["PHP"],
            }],
        }

        asyncio.run(loop._record_autonomy_from_tool("tool-fp", "web_fingerprint", result, "ev-111111111111"))
        snapshot = loop.checkpoint_snapshot("test")

        url_item = next(item for item in snapshot["attack_surface"] if item.get("url") == "http://target.local/")
        self.assertIn("PHP", url_item["technology_hints"])
        self.assertIn("nginx", url_item["technology_hints"])


if __name__ == "__main__":
    unittest.main()
