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
from pentest_node.tools.http import assess_http_risk  # noqa: E402


class DummyPlatform:
    def __init__(self):
        self.events = []

    async def send(self, event):
        self.events.append(event)




class FakeEvidenceStore:
    workspace = ROOT

    def __init__(self, ids=("ev-222222222222",)):
        self.records = [SimpleNamespace(evidence_id=eid) for eid in ids]

    def get_by_ids(self, ids):
        wanted = set(ids)
        return [record for record in self.records if record.evidence_id in wanted]

class WebVerifierTests(unittest.TestCase):
    def test_get_admin_path_is_safe_http_risk(self):
        self.assertEqual(assess_http_risk("GET", "http://target.local/rest/admin/application-version"), "safe")
        self.assertEqual(assess_http_risk("DELETE", "http://target.local/rest/admin/application-version"), "destructive")

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
        self.assertGreaterEqual(result.candidate["confidence"], 0.75)
        self.assertEqual(result.evidence_ids, ["ev-1"])

    def test_sqli_mariadb_error_is_high_confidence(self):
        result = evaluate_web_probe(
            vuln_type="sqli",
            target_url="http://target.local/vulnerabilities/sqli/",
            method="GET",
            parameter="id",
            payload="'",
            baseline_body="ID: 1 First name: admin",
            probe_body="You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near '''' at line 1",
            evidence_ids=["ev-2"],
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.candidate["vuln_type"], "sql_injection")
        self.assertGreaterEqual(result.candidate["confidence"], 0.75)
    def test_sqli_union_credential_dump_is_failed_finding(self):
        result = evaluate_web_probe(
            vuln_type="sqli",
            target_url="http://target.local/rest/products/search",
            method="GET",
            parameter="q",
            payload="nonexistent')) UNION ALL SELECT id,email,password,4,5,6,7,8,9 FROM Users--",
            baseline_body='{"status":"success","data":[{"name":"Apple Juice"}]}',
            probe_body='{"status":"success","data":[{"name":"admin@juice-sh.op","description":"0192023a7bbd73250516f069df18b500"}]}',
            evidence_ids=["ev-222222222222"],
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.candidate["vuln_type"], "sql_injection")
        self.assertEqual(result.candidate["severity"], "critical")
        self.assertIn("credential", result.coverage_notes.lower())
        self.assertEqual(result.evidence_ids, ["ev-222222222222"])
    def test_info_disclosure_detects_listing_directory_title(self):
        result = evaluate_web_probe(
            vuln_type="info_disclosure",
            target_url="http://target.local/ftp",
            method="GET",
            probe_body="<html><head><title>listing directory /ftp</title></head><body><a href='legal.md'>legal.md</a></body></html>",
            status_code=200,
            evidence_ids=["ev-info"],
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.candidate["vuln_type"], "info_disclosure")
        self.assertGreaterEqual(result.candidate["confidence"], 0.7)
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
    def test_command_injection_fails_on_command_output(self):
        result = evaluate_web_probe(
            vuln_type="command_injection",
            target_url="http://target.local/exec.php",
            method="POST",
            parameter="ip",
            payload="127.0.0.1; id",
            probe_body="uid=33(www-data) gid=33(www-data) groups=33(www-data)",
            evidence_ids=["ev-cmdi"],
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.candidate["vuln_type"], "command_injection")
        self.assertEqual(result.candidate["severity"], "critical")

    def test_lfi_fails_on_passwd_content(self):
        result = evaluate_web_probe(
            vuln_type="lfi",
            target_url="http://target.local/file.php",
            method="GET",
            parameter="page",
            payload="../../../../etc/passwd",
            probe_body="root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
            evidence_ids=["ev-lfi"],
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.candidate["vuln_type"], "lfi")

    def test_open_redirect_fails_on_external_location(self):
        result = evaluate_web_probe(
            vuln_type="open_redirect",
            target_url="http://target.local/redirect.php",
            method="GET",
            parameter="url",
            payload="https://example.com/",
            status_code=302,
            response_headers={"location": "https://example.com/"},
            evidence_ids=["ev-redirect"],
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.candidate["vuln_type"], "open_redirect")

    def test_weak_credentials_fails_on_authenticated_state(self):
        result = evaluate_web_probe(
            vuln_type="weak_credentials",
            target_url="http://target.local/login.php",
            method="POST",
            parameter="username",
            payload="admin:password",
            status_code=200,
            response_headers={"set-cookie": "PHPSESSID=abc; path=/"},
            probe_body="Welcome admin <a href='logout.php'>Logout</a>",
            evidence_ids=["ev-login"],
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.candidate["vuln_type"], "weak_credentials")
    def test_xss_raw_script_reflection_is_high_confidence(self):
        result = evaluate_web_probe(
            vuln_type="xss",
            target_url="http://target.local/search.php",
            method="GET",
            parameter="q",
            payload="<script>alert(1337)</script>",
            probe_body="<html><body><script>alert(1337)</script></body></html>",
            evidence_ids=["ev-xss"],
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.candidate["vuln_type"], "xss")
        self.assertEqual(result.candidate["severity"], "high")
        self.assertGreaterEqual(result.candidate["confidence"], 0.8)
        self.assertIn("Executable XSS", result.coverage_notes)

    def test_xss_in_textarea_stays_candidate_confidence(self):
        result = evaluate_web_probe(
            vuln_type="xss",
            target_url="http://target.local/comment.php",
            method="POST",
            parameter="message",
            payload="<script>alert(1337)</script>",
            probe_body="<html><textarea><script>alert(1337)</script></textarea></html>",
            evidence_ids=["ev-xss"],
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.candidate["vuln_type"], "xss")
        self.assertEqual(result.candidate["severity"], "medium")
        self.assertLess(result.candidate["confidence"], 0.7)
    def test_workflow_web_verifier_marks_coverage_and_candidate(self):
        platform = DummyPlatform()
        loop = PentestAgentLoop(
            task={"conversation_id": "conv-1", "scope": {"allow": ["http://target.local"], "deny": []}},
            tools=SimpleNamespace(),
            sandbox=None,
            llm=None,
            platform_sync=platform,
            evidence_store=FakeEvidenceStore(),
        )
        tool = next(t for t in make_workflow_tools(loop) if t.name == "evaluate_web_verifier")

        result = asyncio.run(tool.handler(
            vuln_type="xss",
            target_url="http://target.local/search.php",
            method="GET",
            parameter="q",
            payload="<script>alert(1)</script>",
            probe_body="<html><script>alert(1)</script></html>",
            evidence_ids=["ev-222222222222"],
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


