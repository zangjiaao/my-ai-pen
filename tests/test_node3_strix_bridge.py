import asyncio
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NODE3 = ROOT / "node3"
if str(NODE3) not in sys.path:
    sys.path.insert(0, str(NODE3))

import strix_node  # noqa: E402
from strix_node import StrixPlatformBridge  # noqa: E402


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, payload: str) -> None:
        self.sent.append(json.loads(payload))


def test_node3_reporting_tool_is_used_by_vendored_strix():
    import strix.agents.factory as factory
    from strix.tools.reporting.node3_tool import create_vulnerability_report

    assert create_vulnerability_report.name == "create_vulnerability_report"
    assert factory.create_vulnerability_report is create_vulnerability_report


def test_bridge_vulnerability_callback_emits_platform_evidence_and_finding():
    async def run_bridge():
        ws = FakeWebSocket()
        task = {
            "task_id": "task-1",
            "conversation_id": "conv-1",
            "target": {"value": "http://target.local"},
            "scope": {},
            "snapshot": {},
        }
        bridge = StrixPlatformBridge(ws, task)
        pump = asyncio.create_task(bridge.pump())
        bridge.vulnerability_found({
            "id": "vuln-0001",
            "title": "Reflected XSS",
            "severity": "high",
            "target": "http://target.local",
            "endpoint": "/search",
            "description": "Confirmed reflected XSS.",
            "impact": "Session theft.",
            "remediation_steps": "Encode output.",
        })
        await bridge.close()
        await pump
        return ws.sent

    sent = asyncio.run(run_bridge())

    assert [message["type"] for message in sent] == ["evidence_created", "vuln_found"]
    assert sent[0]["evidence_type"] == "strix_vulnerability_report"
    assert sent[1]["title"] == "Reflected XSS"
    assert sent[1]["severity"] == "high"
    assert sent[1]["evidence_ids"] == [sent[0]["evidence_id"]]


def test_reporting_shim_calculates_cvss_and_persists(monkeypatch):
    class FakeReportState:
        def __init__(self) -> None:
            self.reports: list[dict] = []

        def get_existing_vulnerabilities(self) -> list[dict]:
            return []

        def add_vulnerability_report(self, **kwargs):
            self.reports.append(kwargs)
            return "vuln-0001"

    state = FakeReportState()
    monkeypatch.setattr(strix_node.ReportStateShim, "current_report_state", staticmethod(lambda: state))

    result = asyncio.run(strix_node._do_create_vulnerability_report(
        title="Unauthenticated RCE",
        description="Remote command execution is confirmed.",
        impact="An attacker can execute arbitrary commands.",
        target="http://target.local",
        technical_analysis="The endpoint passes user input to a shell.",
        poc_description="Send the payload and observe command output.",
        poc_script_code="print('poc')",
        remediation_steps="Avoid shell invocation and validate input.",
        cvss_breakdown={
            "attack_vector": "N",
            "attack_complexity": "L",
            "privileges_required": "N",
            "user_interaction": "N",
            "scope": "U",
            "confidentiality": "H",
            "integrity": "H",
            "availability": "H",
        },
        endpoint="/run",
        method="POST",
        cve=None,
        cwe="CWE-78",
        code_locations=None,
    ))

    assert result["success"] is True
    assert result["severity"] == "critical"
    assert result["cvss_score"] == 9.8
    assert state.reports[0]["severity"] == "critical"
    assert state.reports[0]["cvss"] == 9.8
