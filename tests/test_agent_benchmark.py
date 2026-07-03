import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "agent_benchmark.py"
sys.path.insert(0, str(ROOT / "scripts"))

from agent_benchmark import build_report, build_review_template, load_answers, load_checkpoint_file, load_report_file, parse_markdown_cases  # noqa: E402


class AgentBenchmarkTests(unittest.TestCase):
    def test_parse_markdown_cases_uses_answer_key_tables(self):
        text = """
### DVWA P0

| Case | 类型 | 目标能力 | 命中标准 |
|---|---|---|---|
| DVWA-XSS-REFLECTED | verification | 反射型 XSS 探测 | confirmed finding |
| JS-AUTH-SESSION | discovery | JWT/cookie/session 观察 | coverage + evidence |
"""

        cases = parse_markdown_cases(text)

        self.assertEqual([case["id"] for case in cases], ["DVWA-XSS-REFLECTED", "JS-AUTH-SESSION"])
        self.assertEqual(cases[0]["section"], "DVWA P0")
        self.assertEqual(cases[1]["type"], "discovery")

    def test_checkpoint_report_extracts_facts_without_auto_scoring(self):
        checkpoint = {
            "conversation_id": "conv-1",
            "resolved_target": "http://target.local/login.php",
            "state": {"phase": "complete"},
            "confirmed_findings": [
                {
                    "id": "finding-1",
                    "title": "Reflected XSS",
                    "vuln_type": "xss",
                    "status": "confirmed",
                    "location": "http://target.local/vulnerabilities/xss_r/",
                    "evidence_ids": ["ev-1"],
                }
            ],
            "coverage": [
                {
                    "coverage_id": "cov-1",
                    "endpoint": "GET http://target.local/vulnerabilities/xss_r/",
                    "vuln_type": "xss",
                    "status": "passed",
                    "evidence_ids": ["ev-1"],
                }
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            checkpoint_path = Path(tmp) / "checkpoint.json"
            checkpoint_path.write_text(json.dumps(checkpoint), encoding="utf-8")
            facts = load_checkpoint_file(checkpoint_path)
            report = build_report(facts, load_answers(ROOT / "docs" / "agent-autonomy-benchmark.md"))

        self.assertEqual(report["session"]["session_id"], "conv-1")
        self.assertEqual(report["counts"]["confirmed_findings"], 1)
        self.assertEqual(report["answer_key"]["scoring_mode"], "manual_review_against_markdown")
        xss_case = next(case for case in report["expected_cases"] if case["id"] == "DVWA-LOW-XSS-REFLECTED")
        self.assertEqual(xss_case["review_status"], "manual_review")
        self.assertTrue(xss_case["related_findings"])

    def test_report_package_loader_reads_phase4_export_shape(self):
        raw = _make_report_package_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "report.tar.gz"
            report_path.write_bytes(raw)
            facts = load_report_file(report_path)

        self.assertEqual(facts.source_type, "report")
        self.assertEqual(facts.session_id, "s1")
        self.assertEqual(facts.target, "http://192.0.2.1/")
        self.assertEqual(len(facts.confirmed_findings), 1)
        self.assertEqual(len(facts.evidence), 1)


    def test_report_loader_falls_back_to_checkpoint_coverage(self):
        raw = _make_report_package_bytes(coverage_rows=[], checkpoint={"phase": "complete", "coverage": [{"coverage_id": "cov-cp", "endpoint": "GET http://192.0.2.1/", "vuln_type": "web_baseline", "status": "tried"}]})
        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "report.tar.gz"
            report_path.write_bytes(raw)
            facts = load_report_file(report_path)

        self.assertEqual(len(facts.coverage), 1)
        self.assertEqual(facts.coverage[0]["coverage_id"], "cov-cp")
    def test_review_file_computes_manual_score_without_auto_judgment(self):
        checkpoint = {"conversation_id": "conv-score", "resolved_target": "http://target.local/"}
        with tempfile.TemporaryDirectory() as tmp:
            checkpoint_path = Path(tmp) / "checkpoint.json"
            checkpoint_path.write_text(json.dumps(checkpoint), encoding="utf-8")
            review_path = Path(tmp) / "review.json"
            review_path.write_text(json.dumps({"hits": ["DVWA-LOW-BRUTE-FORCE", "DVWA-LOW-COMMAND-INJECTION"]}), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--checkpoint", str(checkpoint_path), "--review", str(review_path), "--output-dir", tmp, "--print-json"],
                cwd=ROOT,
                text=True,
                encoding="utf-8",
                capture_output=True,
                check=False,
            )
            report = json.loads(result.stdout)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["score"]["mode"], "manual_review")
        self.assertEqual(report["score"]["hit"], 2)
        self.assertFalse(report["score"]["passed"])
        self.assertGreater(report["score"]["denominator"], 2)


    def test_require_passing_score_fails_when_review_is_below_target(self):
        checkpoint = {"conversation_id": "conv-low-score", "resolved_target": "http://target.local/"}
        with tempfile.TemporaryDirectory() as tmp:
            checkpoint_path = Path(tmp) / "checkpoint.json"
            checkpoint_path.write_text(json.dumps(checkpoint), encoding="utf-8")
            review_path = Path(tmp) / "review.json"
            review_path.write_text(json.dumps({"hits": ["DVWA-LOW-BRUTE-FORCE"]}), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--checkpoint", str(checkpoint_path), "--review", str(review_path), "--require-passing-score", "--output-dir", tmp],
                cwd=ROOT,
                text=True,
                encoding="utf-8",
                capture_output=True,
                check=False,
            )

        self.assertEqual(result.returncode, 2)
        self.assertIn("TASK-042 score gate failed", result.stderr)

    def test_require_passing_score_passes_at_target(self):
        checkpoint = {"conversation_id": "conv-pass-score", "resolved_target": "http://target.local/"}
        answers = load_answers(ROOT / "docs" / "agent-autonomy-benchmark.md")
        denominator_hits = [case["id"] for case in answers["cases"] if "P0" in case["section"] or "P1" in case["section"]]
        required_hits = denominator_hits[:108]
        with tempfile.TemporaryDirectory() as tmp:
            checkpoint_path = Path(tmp) / "checkpoint.json"
            checkpoint_path.write_text(json.dumps(checkpoint), encoding="utf-8")
            review_path = Path(tmp) / "review.json"
            review_path.write_text(json.dumps({"hits": required_hits}), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--checkpoint", str(checkpoint_path), "--review", str(review_path), "--require-passing-score", "--output-dir", tmp, "--print-json"],
                cwd=ROOT,
                text=True,
                encoding="utf-8",
                capture_output=True,
                check=False,
            )
            report = json.loads(result.stdout)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report["score"]["passed"])
        self.assertGreaterEqual(report["score"]["percent"], 80.0)
    def test_review_template_contains_only_scored_cases(self):
        checkpoint = {"conversation_id": "conv-template", "resolved_target": "http://target.local/"}
        with tempfile.TemporaryDirectory() as tmp:
            checkpoint_path = Path(tmp) / "checkpoint.json"
            checkpoint_path.write_text(json.dumps(checkpoint), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--checkpoint", str(checkpoint_path), "--output-dir", tmp, "--write-review-template"],
                cwd=ROOT,
                text=True,
                encoding="utf-8",
                capture_output=True,
                check=False,
            )
            template = json.loads((Path(tmp) / "benchmark-review-template.json").read_text(encoding="utf-8"))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(template["review_schema"], "agent-benchmark-manual-review-v1")
        self.assertEqual(len(template["cases"]), 135)
        self.assertTrue(all(case["status"] == "manual_review" for case in template["cases"]))
        self.assertFalse(any("P2" in case["section"] for case in template["cases"]))

    def test_cli_writes_json_and_markdown_reports(self):
        checkpoint = {
            "conversation_id": "conv-cli",
            "resolved_target": "http://target.local/",
            "attack_surface": [{"surface_id": "as-1", "kind": "url", "url": "http://target.local/"}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            checkpoint_path = Path(tmp) / "checkpoint.json"
            checkpoint_path.write_text(json.dumps(checkpoint), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--checkpoint", str(checkpoint_path), "--output-dir", tmp],
                cwd=ROOT,
                text=True,
                encoding="utf-8",
                capture_output=True,
                check=False,
            )
            json_report = Path(tmp) / "benchmark-report.json"
            md_report = Path(tmp) / "benchmark-report.md"
            json_exists = json_report.exists()
            md_exists = md_report.exists()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json_exists)
        self.assertTrue(md_exists)


def _make_report_package_bytes(coverage_rows: list[dict] | None = None, checkpoint: dict | None = None) -> bytes:
    payloads = {
        "manifest.json": {
            "format_version": "mvp-demo-v1",
            "session_id": "s1",
            "target": {"value": "http://192.0.2.1/"},
            "status": "completed",
            "instruction": "test target",
        },
        "vulnerabilities.json": [
            {"title": "Reflected XSS", "vuln_type": "xss", "status": "confirmed", "evidence_ids": ["ev-1"]}
        ],
        "evidence.json": [{"evidence_id": "ev-1", "evidence_type": "http_trace", "summary": "payload reflected"}],
        "attack_surface.json": [{"surface_id": "as-1", "kind": "url", "url": "http://192.0.2.1/"}],
        "coverage.json": [{"coverage_id": "cov-1", "endpoint": "GET http://192.0.2.1/", "vuln_type": "xss"}] if coverage_rows is None else coverage_rows,
        "checkpoints/latest.json": checkpoint or {"phase": "complete"},
    }
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        for name, payload in payloads.items():
            raw = json.dumps(payload).encode("utf-8")
            info = tarfile.TarInfo(name)
            info.size = len(raw)
            tar.addfile(info, io.BytesIO(raw))
        raw = (json.dumps({"id": "msg-1", "role": "agent", "content": {"text": "done"}}) + "\n").encode("utf-8")
        info = tarfile.TarInfo("conversation.jsonl")
        info.size = len(raw)
        tar.addfile(info, io.BytesIO(raw))
    return out.getvalue()


if __name__ == "__main__":
    unittest.main()

