import asyncio
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "agent_autonomy_smoke.py"
sys.path.insert(0, str(ROOT / "scripts"))

from agent_autonomy_smoke import build_live_web_checkpoint, summarize_checkpoint  # noqa: E402


class AgentAutonomySmokeTests(unittest.TestCase):
    def test_smoke_passes_with_attack_surface_coverage_and_evidence(self):
        checkpoint = {
            "conversation_id": "conv-1",
            "resolved_target": "http://target.local/login.php",
            "attack_surface": [{"surface_id": "as-1", "kind": "form", "url": "http://target.local/login.php", "evidence_ids": ["ev-1"]}],
            "coverage": [{"coverage_id": "cov-1", "endpoint": "POST http://target.local/login.php", "parameter": "username", "vuln_type": "sqli", "status": "passed", "evidence_ids": ["ev-1"]}],
            "confirmed_findings": [{"id": "finding-1", "title": "SQLi", "evidence_ids": ["ev-1"]}],
            "state": {"recent_tool_runs": [{"tool_name": "http_request", "status": "done"}, {"tool_name": "evaluate_web_verifier", "status": "ok"}]},
        }

        result = self._run(checkpoint, "--min-attack-surface", "1", "--min-coverage", "1", "--min-evidence", "1", "--require-confirmed-evidence")
        summary = json.loads(result.stdout)

        self.assertEqual(result.returncode, 0)
        self.assertEqual(summary["smoke_status"], "passed")
        self.assertEqual(summary["attack_surface_count"], 1)
        self.assertEqual(summary["coverage_by_status"]["passed"], 1)

    def test_smoke_fails_empty_checkpoint_thresholds(self):
        result = self._run({}, "--min-attack-surface", "1", "--min-coverage", "1", "--min-evidence", "1")
        summary = json.loads(result.stdout)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(summary["smoke_status"], "failed")
        self.assertTrue(any("attack_surface_count" in item for item in summary["smoke_failures"]))
        self.assertTrue(any("coverage_total" in item for item in summary["smoke_failures"]))

    def test_live_web_checkpoint_records_real_surface_coverage_and_evidence(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b"<html><a href='/setup.php'>setup</a><form action='/login.php' method='post'><input name='username'><input name='password'></form></html>"
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
            target = f"http://127.0.0.1:{server.server_port}/login.php"
            with tempfile.TemporaryDirectory() as tmp:
                checkpoint = asyncio.run(build_live_web_checkpoint(target, session_id="live-test", workspace=Path(tmp)))
            summary = summarize_checkpoint(checkpoint, target=target, session_id="live-test")
        finally:
            server.shutdown()
            server.server_close()

        self.assertGreaterEqual(summary["attack_surface_count"], 2)
        self.assertEqual(summary["coverage_total"], 1)
        self.assertEqual(summary["evidence_count"], 1)
        self.assertTrue(any(item.get("kind") == "form" for item in checkpoint["attack_surface"]))
    def test_smoke_fails_confirmed_finding_without_evidence(self):
        checkpoint = {"confirmed_findings": [{"id": "finding-1", "title": "Speculative"}]}
        result = self._run(checkpoint, "--require-confirmed-evidence")
        summary = json.loads(result.stdout)

        self.assertEqual(result.returncode, 1)
        self.assertIn("confirmed finding lacks evidence_ids", summary["smoke_failures"][0])

    def _run(self, checkpoint: dict, *args: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "checkpoint.json"
            path.write_text(json.dumps(checkpoint), encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(SCRIPT), "--checkpoint", str(path), "--target", "http://target.local/login.php", *args],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )


if __name__ == "__main__":
    unittest.main()