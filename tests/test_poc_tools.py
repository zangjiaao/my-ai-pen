import asyncio
import json
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.agent.loop import PHASE_TOOL_NAMES  # noqa: E402
from pentest_node.tools.poc import make_poc_tools, review_poc_code  # noqa: E402


class DummyPlatform:
    def __init__(self):
        self.events = []

    async def send(self, event):
        self.events.append(event)


class FakeEvidenceStore:
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.records = []

    async def collect_tool_output(self, tool_run_id, tool_name, stdout, stderr=""):
        evidence_id = f"ev-{len(self.records) + 1:012x}"
        record = SimpleNamespace(
            evidence_id=evidence_id,
            type="tool_output",
            source_tool=tool_name,
            raw_ref="",
            summary=stdout[:200],
            hash="sha256:test",
            related_tool_run_id=tool_run_id,
        )
        self.records.append(record)
        return record

    def get_by_ids(self, ids):
        wanted = set(ids)
        return [record for record in self.records if record.evidence_id in wanted]


class FakeSandbox:
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.commands = []

    async def execute(self, command, timeout=600):
        self.commands.append(command)
        script = re.search(r"python3\s+(\S+)", command).group(1).strip("'\"")
        target = re.search(r"--target-url\s+('([^']+)'|\"([^\"]+)\"|(\S+))", command)
        output = re.search(r"--output\s+(\S+)", command).group(1).strip("'\"")
        target_url = target.group(2) or target.group(3) or target.group(4)
        (self.workspace / Path(output).parent).mkdir(parents=True, exist_ok=True)
        proc = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, script, "--target-url", target_url, "--output", output],
            cwd=self.workspace,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
        return {"exit_code": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}


def _loop(workspace: Path, target: str):
    return SimpleNamespace(
        task={"scope": {"allow": [target], "deny": []}},
        evidence_store=FakeEvidenceStore(workspace),
        sandbox=FakeSandbox(workspace),
        platform=DummyPlatform(),
    )


class PocToolTests(unittest.TestCase):
    def test_poc_tools_are_verify_phase_only(self):
        self.assertIn("create_poc_script", PHASE_TOOL_NAMES["verify"])
        self.assertIn("run_poc_script", PHASE_TOOL_NAMES["verify"])
        self.assertIn("attach_artifact_evidence", PHASE_TOOL_NAMES["verify"])
        self.assertNotIn("create_poc_script", PHASE_TOOL_NAMES["recon"])
        self.assertNotIn("run_poc_script", PHASE_TOOL_NAMES["analysis"])
    def test_review_blocks_dangerous_custom_python(self):
        result = review_poc_code("import subprocess\nsubprocess.run(['id'])\n", scope={"allow": ["http://target.local"]})

        self.assertFalse(result["approved"])
        self.assertTrue(any("Denied import" in error for error in result["errors"]))

    def test_create_poc_script_blocks_out_of_scope_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            loop = _loop(Path(tmp), "http://allowed.local")
            tools = {tool.name: tool for tool in make_poc_tools(loop)}

            result = asyncio.run(tools["create_poc_script"].handler(target_url="http://blocked.local/search?q=base"))

        self.assertEqual(result["status"], "blocked")

    def test_template_poc_runs_and_artifact_can_be_attached_as_evidence(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                query = parse_qs(urlparse(self.path).query)
                body = (query.get("q") or [""])[0].encode()
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
            base = f"http://127.0.0.1:{server.server_port}"
            target = f"{base}/search?q=base"
            with tempfile.TemporaryDirectory() as tmp:
                workspace = Path(tmp)
                loop = _loop(workspace, base)
                tools = {tool.name: tool for tool in make_poc_tools(loop)}

                created = asyncio.run(tools["create_poc_script"].handler(
                    poc_id="xss-reflection",
                    target_url=target,
                    template="http_parameter_probe",
                    method="GET",
                    parameter="q",
                    payload="<script>alert(1337)</script>",
                    expected_text="<script>alert(1337)</script>",
                ))
                ran = asyncio.run(tools["run_poc_script"].handler(poc_id="xss-reflection", target_url=target))
                attached = asyncio.run(tools["attach_artifact_evidence"].handler(
                    artifact_path=created["artifact_path"],
                    summary="PoC reflected payload artifact",
                ))

                artifact = json.loads((workspace / created["artifact_path"]).read_text(encoding="utf-8"))

            self.assertEqual(created["status"], "ok")
            self.assertTrue(created["review"]["approved"])
            self.assertEqual(ran["status"], "done")
            self.assertTrue(artifact["matched_expected_text"])
            self.assertEqual(attached["status"], "ok")
            self.assertRegex(attached["evidence_id"], r"^ev-[0-9a-f]{12}$")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
