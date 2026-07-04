import asyncio
import json
import sys
import threading
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.agent.loop import PentestAgentLoop  # noqa: E402
from pentest_node.tools.skill_loader import SkillRegistry, discover_skill_packages  # noqa: E402
from pentest_node.tools.workflow import make_workflow_tools  # noqa: E402


class DummyPlatform:
    def __init__(self):
        self.events = []

    async def send(self, event):
        self.events.append(event)


class SkillPackageRuntimeTests(unittest.TestCase):
    def test_discovers_package_skills_and_selects_recipes_without_hardcoded_map(self):
        skills_dir = ROOT / "node" / "pentest_node" / "skills"
        packages = discover_skill_packages(skills_dir)
        registry = SkillRegistry(skills_dir)

        names = {package.name for package in packages}
        sqli = registry.select_recipe_for_vuln("sqli")
        xss = registry.select_recipe_for_vuln("xss")

        self.assertIn("sql_injection", names)
        self.assertIn("xss", names)
        self.assertIsNotNone(sqli)
        self.assertEqual(sqli.skill_name, "sql_injection")
        self.assertEqual(sqli.recipe_id, "error_boolean_union")
        self.assertIn("' OR 1=1--", sqli.payloads)
        self.assertIsNotNone(xss)
        self.assertEqual(xss.skill_name, "xss")
        self.assertEqual(xss.recipe_id, "reflection_context")


    def test_registry_supports_knowledge_only_package_without_recipe(self):
        skills_dir = ROOT / "node" / "pentest_node" / "skills"
        registry = SkillRegistry(skills_dir)
        package = registry.select_package_for_vuln("web_baseline")
        recipe = registry.select_recipe_for_vuln("web_baseline")

        self.assertIsNotNone(package)
        self.assertEqual(package.name, "web_baseline")
        self.assertEqual(recipe, None)
        self.assertIn("references/attack_surface.md", {item.get("path") for item in package.references})
    def test_registry_selects_migrated_knowledge_skills(self):
        skills_dir = ROOT / "node" / "pentest_node" / "skills"
        registry = SkillRegistry(skills_dir)
        expected = {
            "auth_session": "auth_test",
            "idor": "idor",
            "ssrf": "ssrf",
            "file_upload": "file_upload",
            "ssti": "ssti",
            "api_discovery": "api_test",
        }

        for vuln_type, skill_name in expected.items():
            with self.subTest(vuln_type=vuln_type):
                package = registry.select_package_for_vuln(vuln_type)
                self.assertIsNotNone(package)
                self.assertEqual(package.name, skill_name)
                self.assertEqual(registry.select_recipe_for_vuln(vuln_type), None)
                self.assertTrue(package.references)
    def test_invalid_package_without_skill_doc_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "bad_skill"
            root.mkdir()
            (root / "manifest.yaml").write_text(json.dumps({
                "schema_version": 1,
                "name": "bad_skill",
                "description": "Invalid package missing SKILL.md.",
                "vuln_types": ["bad"],
                "tools": ["traffic_send"],
                "risk_level": "safe",
                "recipes": [{"id": "bad", "path": "recipes/bad.yaml", "vuln_types": ["bad"]}],
            }), encoding="utf-8")

            packages = discover_skill_packages(Path(tmp))

        self.assertEqual(packages, [])
    def test_run_web_skill_uses_package_recipe_metadata(self):
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
        try:
            platform = DummyPlatform()
            target = f"http://127.0.0.1:{server.server_port}/search?q=base"
            loop = PentestAgentLoop(
                task={
                    "conversation_id": "conv-skill-package-runtime",
                    "target": {"type": "url", "value": target},
                    "resolved_target": target,
                    "scope": {"allow": [f"http://127.0.0.1:{server.server_port}"], "deny": []},
                },
                tools=SimpleNamespace(),
                sandbox=None,
                llm=None,
                platform_sync=platform,
            )
            node = loop.plan_tree.add_node(title="XSS from package", kind="test", endpoint=f"GET {target}", parameter="q", vuln_type="xss")
            tool = next(t for t in make_workflow_tools(loop) if t.name == "run_web_skill")

            result = asyncio.run(tool.handler(node_id=node.node_id))
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(result["status"], "done")
        self.assertEqual(result["skill_name"], "xss")
        self.assertEqual(result["skill_recipe"]["recipe_id"], "reflection_context")
        self.assertTrue(result["skill_recipe"]["source_path"].endswith("reflection_context.yaml"))
        self.assertIn("<script>alert(1337)</script>", result["body"])
        self.assertEqual(loop.plan_tree._nodes[node.node_id].status, "done")

    def test_workflow_autorun_completes_web_baseline_node(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b"baseline"
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
            target = f"http://127.0.0.1:{server.server_port}/login.php"
            loop = PentestAgentLoop(
                task={
                    "conversation_id": "conv-web-baseline-autorun",
                    "target": {"type": "url", "value": target},
                    "resolved_target": target,
                    "scope": {"allow": [f"http://127.0.0.1:{server.server_port}"], "deny": []},
                },
                tools=SimpleNamespace(),
                sandbox=None,
                llm=None,
                platform_sync=platform,
            )
            node = loop.plan_tree.add_node(title="Baseline login", kind="test", endpoint=f"GET {target}", parameter="<none>", vuln_type="web_baseline")
            loop.plan_tree.update_node(node.node_id, status="running", notes="Resumed unfinished runtime node")
            workflow_tool = next(t for t in make_workflow_tools(loop) if t.name == "run_web_skill")
            loop.tools = SimpleNamespace(get=lambda name: workflow_tool if name == "run_web_skill" else None)

            executed = asyncio.run(loop._autorun_verify_workflow_nodes(limit=1))
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(executed, 1)
        self.assertEqual(loop.plan_tree._nodes[node.node_id].status, "done")
    def test_run_web_skill_falls_back_when_no_package_skill_exists(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                posted = self.rfile.read(length).decode()
                body = b"uid=33(www-data)" if "id" in posted else posted.encode()
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
            target = f"http://127.0.0.1:{server.server_port}/exec"
            loop = PentestAgentLoop(
                task={
                    "conversation_id": "conv-skill-package-fallback",
                    "target": {"type": "url", "value": target},
                    "resolved_target": target,
                    "scope": {"allow": [f"http://127.0.0.1:{server.server_port}"], "deny": []},
                },
                tools=SimpleNamespace(),
                sandbox=None,
                llm=None,
                platform_sync=platform,
            )
            node = loop.plan_tree.add_node(title="Command injection fallback", kind="test", endpoint=f"POST {target}", parameter="ip", vuln_type="command_injection")
            tool = next(t for t in make_workflow_tools(loop) if t.name == "run_web_skill")

            result = asyncio.run(tool.handler(node_id=node.node_id))
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(result["status"], "done")
        self.assertEqual(result["skill_name"], "command_injection")
        self.assertIsNone(result["skill_recipe"])
        self.assertIn("uid=33", result["body"])


if __name__ == "__main__":
    unittest.main()


