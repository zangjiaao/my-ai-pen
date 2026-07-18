"""Unit tests for product delivery finding mapping (booked-only + asset join shape).

Drives real ``map_vulnerability_to_delivery_finding`` / ``map_vulnerability_orm`` /
``filter_snapshot_findings_for_delivery`` — not hand-built report dicts alone.
"""
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

from app.services.delivery_findings import (
    extract_location_hint,
    filter_snapshot_findings_for_delivery,
    is_booked_finding_status,
    map_vulnerability_orm,
    map_vulnerability_to_delivery_finding,
)
from app.services.engagement_report import build_engagement_report_markdown


class DeliveryFindingsMappingTests(unittest.TestCase):
    def test_candidate_status_rejected(self):
        self.assertFalse(is_booked_finding_status("candidate"))
        self.assertFalse(is_booked_finding_status("false_positive"))
        self.assertTrue(is_booked_finding_status("to_fix"))
        self.assertTrue(is_booked_finding_status("confirmed"))
        self.assertTrue(is_booked_finding_status(""))  # ledger default empty/open

        rejected = map_vulnerability_to_delivery_finding(
            title="Maybe SQLi",
            severity="high",
            status="candidate",
            location="https://x/search",
        )
        self.assertIsNone(rejected)

    def test_product_shape_joins_asset_address_not_uuid_only(self):
        """Real product path shape: Vulnerability columns + Asset.address → host/location."""
        asset_id = uuid.uuid4()
        mapped = map_vulnerability_to_delivery_finding(
            id=uuid.uuid4(),
            title="SQL Injection on /api/search",
            severity="high",
            status="to_fix",  # real ledger status after booking
            description="Boolean differential on q=",
            poc="GET https://app.example.com/api/search?q=1'+OR+'1'='1",
            remediation="Use parameterized queries",
            cvss=8.6,
            port="443",
            asset_id=asset_id,
            evidence_ids=["ev-1"],
            asset_address="app.example.com",
            asset_name="app.example.com",
            # Platform Vulnerability has no location column — only asset + narrative
            location=None,
        )
        self.assertIsNotNone(mapped)
        assert mapped is not None
        self.assertEqual(mapped["host"], "app.example.com")
        self.assertEqual(mapped["port"], "443")
        # URL recovered from PoC when no location column
        self.assertIn("app.example.com/api/search", mapped.get("location", ""))
        # Must not be UUID-only presentation input
        self.assertNotEqual(mapped.get("host"), str(asset_id))

        md = build_engagement_report_markdown(
            title="Product path report",
            target="https://app.example.com",
            findings=[mapped],
            evidence_by_id={"ev-1": {"summary": "boolean differential"}},
        )
        self.assertIn("app.example.com", md)
        self.assertIn("SQL Injection on /api/search", md)
        # Affected asset line should show host, not bare asset_id=uuid alone as the only signal
        self.assertIn("**Affected asset / location:**", md)
        self.assertRegex(
            md,
            r"\*\*Affected asset / location:\*\*\s*`[^`]*app\.example\.com",
        )
        # With a resolved host, do not dump internal UUID as the primary asset label
        self.assertNotRegex(md, r"\*\*Affected asset / location:\*\*\s*`asset_id=")
        self.assertNotIn("Workflow Stage", md)

    def test_map_vulnerability_orm_uses_asset_attrs(self):
        vuln = types.SimpleNamespace(
            id=uuid.uuid4(),
            title="Open Redis",
            severity="critical",
            status="to_fix",
            description="Unauthenticated Redis on 6379",
            poc="redis-cli -h 10.0.0.5 ping => PONG",
            remediation="Bind + AUTH",
            cve_id=None,
            cvss=9.0,
            port="6379",
            asset_id=uuid.uuid4(),
            evidence_ids=["e-redis"],
        )
        asset = types.SimpleNamespace(address="10.0.0.5", name="redis-prod")
        mapped = map_vulnerability_orm(vuln, asset)
        self.assertIsNotNone(mapped)
        assert mapped is not None
        self.assertEqual(mapped["host"], "10.0.0.5")
        self.assertEqual(mapped["port"], "6379")
        self.assertEqual(mapped["title"], "Open Redis")

        # Without asset, still booked, host may be empty, port remains
        mapped_no_asset = map_vulnerability_orm(vuln, None)
        self.assertIsNotNone(mapped_no_asset)
        assert mapped_no_asset is not None
        self.assertEqual(mapped_no_asset.get("port"), "6379")
        self.assertNotIn("host", mapped_no_asset)  # stripped empty

    def test_snapshot_candidates_filtered_out(self):
        snapshot_rows = [
            {
                "title": "Candidate XSS",
                "severity": "medium",
                "status": "candidate",
                "location": "https://x/?q=",
                "evidence_ids": [],
            },
            {
                "title": "Confirmed IDOR",
                "severity": "high",
                "status": "confirmed",
                "location": "https://x/orders/1",
                "description": "cross-account read",
                "evidence_ids": ["ev-idor"],
            },
            {
                "title": "Checkpoint maybe",
                "severity": "low",
                "status": "candidate",
                "location": "https://x/admin",
            },
        ]
        kept = filter_snapshot_findings_for_delivery(snapshot_rows)
        titles = [k["title"] for k in kept]
        self.assertEqual(titles, ["Confirmed IDOR"])
        self.assertNotIn("Candidate XSS", titles)

        # Empty / candidate-only → empty report body, no invention
        only_candidates = filter_snapshot_findings_for_delivery(snapshot_rows[:1])
        self.assertEqual(only_candidates, [])
        md = build_engagement_report_markdown(findings=only_candidates)
        self.assertIn("**Confirmed findings:** **0**", md)
        self.assertNotIn("Candidate XSS", md)

    def test_extract_location_from_poc_narrative(self):
        self.assertIn(
            "example.com",
            extract_location_hint("See curl https://app.example.com/v1/items?id=1"),
        )
        self.assertEqual(
            extract_location_hint("Location: /admin/users\nmore text"),
            "/admin/users",
        )


if __name__ == "__main__":
    unittest.main()
