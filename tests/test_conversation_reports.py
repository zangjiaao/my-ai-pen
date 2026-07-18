"""Pure tests for conversation report helpers + delivery download render."""
from __future__ import annotations

import sys
import types
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "platform" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.conversation_reports import (
    content_disposition_attachment,
    render_report_download,
    report_to_dict,
    safe_download_filename,
)
from app.services.engagement_report import (
    build_engagement_report_html,
    build_engagement_report_markdown,
    normalize_report_markdown_sections,
)


class ConversationReportHelpersTests(unittest.TestCase):
    def test_report_to_dict_and_download_formats(self):
        md = build_engagement_report_markdown(
            title="DVWA session report",
            findings=[
                {
                    "title": "SQLi",
                    "severity": "high",
                    "location": "http://127.0.0.1:8080/vulnerabilities/sqli/",
                    "description": "id parameter injectable",
                    "poc": "GET id=1' OR '1'='1",
                    "impact": "Data read",
                    "remediation": "Parameterized queries",
                }
            ],
            target="http://127.0.0.1:8080",
        )
        row = types.SimpleNamespace(
            id=uuid.uuid4(),
            conversation_id=uuid.uuid4(),
            title="DVWA session report",
            summary="User-requested delivery report",
            markdown=md,
            source="agent",
            created_by="工作台助手",
            finding_ids=["v1", "v2"],
            meta={"seat": "default"},
            created_at=None,
        )
        meta = report_to_dict(row, include_markdown=False)
        self.assertEqual(meta["title"], "DVWA session report")
        self.assertEqual(meta["finding_count"], 2)
        self.assertEqual(meta["source"], "agent")
        self.assertNotIn("markdown", meta)

        full = report_to_dict(row, include_markdown=True)
        self.assertIn("Executive summary", full["markdown"])

        body_md, media_md, name_md = render_report_download(row, "markdown")
        self.assertIn("text/markdown", media_md)
        self.assertTrue(name_md.endswith(".md"))
        self.assertIn("SQLi", body_md)
        self.assertIn("Parameterized queries", body_md)

        body_html, media_html, name_html = render_report_download(row, "html")
        self.assertIn("text/html", media_html)
        self.assertTrue(name_html.endswith(".html"))
        self.assertIn("SQLi", body_html)
        self.assertIn("<h1>", body_html)
        self.assertNotIn("Workflow Stage", body_html)

    def test_create_report_rejects_short_markdown(self):
        from app.services.conversation_reports import validate_report_markdown

        with self.assertRaises(ValueError):
            validate_report_markdown("too short")
        ok = validate_report_markdown("# Title\n\n" + ("body " * 20))
        self.assertIn("Title", ok)

    def test_download_filename_and_content_disposition_are_latin1_safe(self):
        """Chinese report titles must not break HTTP Content-Disposition (latin-1)."""
        name = safe_download_filename("DVWA 安全渗透测试交付检测报告", "html")
        self.assertTrue(name.endswith(".html"))
        name.encode("latin-1")  # must not raise
        disp = content_disposition_attachment(name)
        disp.encode("latin-1")
        self.assertIn("filename=", disp)
        # Pure Chinese title → ascii slug fallback
        name2 = safe_download_filename("安全评估报告", "md")
        self.assertEqual(name2, "detection-report.md")
        content_disposition_attachment(name2).encode("latin-1")

        row = types.SimpleNamespace(
            id=uuid.uuid4(),
            conversation_id=uuid.uuid4(),
            title="DVWA 安全渗透测试交付检测报告",
            summary="",
            markdown="# T\n\n" + ("body line\n" * 30),
            source="agent",
            created_by="x",
            finding_ids=[],
            meta={},
            created_at=None,
        )
        body, media, filename = render_report_download(row, "html")
        self.assertIn("text/html", media)
        filename.encode("latin-1")
        content_disposition_attachment(filename).encode("latin-1")
        self.assertGreater(len(body), 100)

    def test_normalize_fills_missing_appendix_and_renumbers(self):
        """Agent drafts that skip chapter 5 must get appendix + continuous numbers."""
        agent_md = """# Agent report

## 1. Executive summary

Overview.

## 2. Scope and methodology

Lab only.

## 3. Findings

### 3.1 Short finding

ok

### 3.6 SQL注入漏洞 - 数据库信息泄露 (低安全等级) 以及很长很长很长的标题后缀用来测试换行

PoC details.

## 4. Remediation roadmap

- P0: fix critical

## 6. Disclaimer

Legal text.
"""
        fixed = normalize_report_markdown_sections(agent_md)
        self.assertIn("## 5. Appendix — finding index", fixed)
        self.assertIn("SQL注入漏洞", fixed)
        self.assertRegex(fixed, r"## 5\. Appendix")
        self.assertRegex(fixed, r"## 6\. Disclaimer")
        # Continuous 1..6 only (no orphan ## 7 or second ## 6)
        nums = [
            int(m.group(1))
            for ln in fixed.splitlines()
            if (m := __import__("re").match(r"^##\s+(\d+)\.", ln))
        ]
        self.assertEqual(nums, list(range(1, max(nums) + 1)))
        self.assertEqual(max(nums), 6)

        html = build_engagement_report_html(title="wrap test", markdown=agent_md)
        self.assertIn("Appendix", html)
        self.assertIn("Disclaimer", html)
        self.assertIn("finding-card", html)
        self.assertIn("cover", html)
        self.assertIn("overflow-wrap: anywhere", html)
        self.assertIn("word-break: break-word", html)
        self.assertIn("SQL注入漏洞", html)
        self.assertIn("finding-title", html)


if __name__ == "__main__":
    unittest.main()
