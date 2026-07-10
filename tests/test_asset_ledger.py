"""Unit tests for shipped asset ledger helpers (P0–P3 pure logic)."""
from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "platform" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.asset_ledger import (  # noqa: E402
    apply_discover_to_asset_fields,
    compute_security_changes,
    extract_ports,
    normalize_address,
    ports_summary,
    render_remediation_markdown,
    risk_summary_from_vulns,
    tech_summary,
)


class AssetLedgerNormalizeTests(unittest.TestCase):
    def test_normalize_address_host_and_url(self):
        self.assertEqual(normalize_address("Example.COM"), "example.com")
        self.assertEqual(normalize_address("https://APP.example.com/path"), "app.example.com")
        self.assertEqual(normalize_address("10.0.0.5:8080"), "10.0.0.5:8080")
        # Manual bare host and agent URL share one merge key.
        self.assertEqual(normalize_address("pay.corp.local"), normalize_address("https://pay.corp.local/app"))


class AssetLedgerMergeTests(unittest.TestCase):
    def test_discover_twice_merges_ports_and_services(self):
        first = apply_discover_to_asset_fields(
            existing=None,
            address="https://target.local/login",
            name="target",
            open_ports=[80, 443],
            services=[{"port": 443, "name": "https", "product": "nginx"}],
        )
        second = apply_discover_to_asset_fields(
            existing=first,
            address="TARGET.local",
            open_ports=[22, 443],
            services=[{"port": 22, "name": "ssh", "version": "OpenSSH"}],
        )
        # Same normalized address key family
        self.assertEqual(first["address"], "target.local")
        self.assertEqual(second["address"], "target.local")
        ports = extract_ports(second["properties"])
        self.assertEqual(ports, ["22", "80", "443"])
        services = second["properties"]["services"]
        names = {str(s.get("name") or s.get("service")) for s in services}
        self.assertIn("https", names)
        self.assertIn("ssh", names)
        self.assertEqual(ports_summary(second["properties"]), "22, 80, 443")
        self.assertIn("https", tech_summary(second["properties"]))

    def test_second_discover_does_not_drop_existing_ports_when_payload_omits_ports(self):
        base = apply_discover_to_asset_fields(
            existing=None,
            address="10.1.1.9",
            open_ports=[80],
            services=[{"port": 80, "name": "http"}],
        )
        again = apply_discover_to_asset_fields(
            existing=base,
            address="10.1.1.9",
            open_ports=None,
            services=None,
        )
        self.assertEqual(extract_ports(again["properties"]), ["80"])

    def test_rediscover_without_name_type_preserves_ledger_identity(self):
        """Agent re-discover omitting hostname/type must not clobber manual identity."""
        existing = apply_discover_to_asset_fields(
            existing=None,
            address="pay.example.com",
            name="支付网关",
            asset_type="web_app",
            open_ports=[443],
            services=[{"port": 443, "name": "https"}],
        )
        # Simulate WS path that used to pass name=address and type=host defaults.
        rediscover = apply_discover_to_asset_fields(
            existing=existing,
            address="https://pay.example.com/login",
            name=None,
            asset_type=None,
            open_ports=[22],
            services=[{"port": 22, "name": "ssh"}],
        )
        self.assertEqual(rediscover["name"], "支付网关")
        self.assertEqual(rediscover["type"], "web_app")
        self.assertEqual(extract_ports(rediscover["properties"]), ["22", "443"])
        # Explicit non-empty override still wins.
        renamed = apply_discover_to_asset_fields(
            existing=rediscover,
            address="pay.example.com",
            name="支付网关-v2",
            asset_type="web",
            open_ports=None,
        )
        self.assertEqual(renamed["name"], "支付网关-v2")
        self.assertEqual(renamed["type"], "web")


class AssetLedgerRiskAndExportTests(unittest.TestCase):
    def test_risk_summary_counts_open_by_severity(self):
        risk = risk_summary_from_vulns(
            [
                {"severity": "high", "status": "confirmed"},
                {"severity": "critical", "status": "pending"},
                {"severity": "high", "status": "fixed"},
                {"severity": "low", "status": "open"},
            ]
        )
        self.assertEqual(risk["open_total"], 3)
        self.assertEqual(risk["by_severity"]["critical"], 1)
        self.assertEqual(risk["by_severity"]["high"], 1)
        self.assertEqual(risk["by_severity"]["low"], 1)
        self.assertEqual(risk["highest"], "critical")
        self.assertIn("3 开放", risk["label"])

    def test_remediation_markdown_includes_asset_and_finding(self):
        md = render_remediation_markdown(
            {
                "name": "支付网关",
                "address": "pay.example.com",
                "type": "web_app",
                "source": "manual",
                "properties": {"open_ports": [443], "services": [{"name": "nginx", "version": "1.24"}]},
            },
            [
                {
                    "title": "SQL 注入 - 登录接口",
                    "severity": "high",
                    "status": "confirmed",
                    "confidence": "high",
                    "description": "id 参数可注入",
                    "remediation": "使用参数化查询",
                }
            ],
        )
        self.assertIn("支付网关", md)
        self.assertIn("pay.example.com", md)
        self.assertIn("SQL 注入 - 登录接口", md)
        self.assertIn("high", md)
        self.assertIn("使用参数化查询", md)


class AssetLedgerChangesTests(unittest.TestCase):
    def test_seven_day_window_excludes_old_events(self):
        now = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)
        assets = [
            {
                "id": "a-new",
                "name": "new",
                "address": "new.example",
                "type": "host",
                "created_at": (now - timedelta(days=2)).isoformat(),
                "updated_at": (now - timedelta(days=2)).isoformat(),
            },
            {
                "id": "a-old",
                "name": "old",
                "address": "old.example",
                "type": "host",
                "created_at": (now - timedelta(days=30)).isoformat(),
                "updated_at": (now - timedelta(days=20)).isoformat(),
            },
            {
                "id": "a-upd",
                "name": "upd",
                "address": "upd.example",
                "type": "host",
                "created_at": (now - timedelta(days=40)).isoformat(),
                "updated_at": (now - timedelta(days=1)).isoformat(),
            },
        ]
        vulns = [
            {
                "id": "v-new",
                "title": "New XSS",
                "severity": "medium",
                "status": "confirmed",
                "asset_id": "a-new",
                "discovered_at": (now - timedelta(days=3)).isoformat(),
                "updated_at": (now - timedelta(days=3)).isoformat(),
            },
            {
                "id": "v-old",
                "title": "Old SQLi",
                "severity": "high",
                "status": "confirmed",
                "asset_id": "a-old",
                "discovered_at": (now - timedelta(days=40)).isoformat(),
                "updated_at": (now - timedelta(days=40)).isoformat(),
            },
            {
                "id": "v-status",
                "title": "Status flip",
                "severity": "low",
                "status": "fixed",
                "asset_id": "a-upd",
                "discovered_at": (now - timedelta(days=20)).isoformat(),
                "updated_at": (now - timedelta(days=1)).isoformat(),
            },
        ]
        summary = compute_security_changes(assets, vulns, now=now, days=7)
        self.assertEqual(summary["counts"]["new_assets"], 1)
        self.assertEqual(summary["counts"]["updated_assets"], 1)
        self.assertEqual(summary["counts"]["new_findings"], 1)
        self.assertEqual(summary["counts"]["updated_findings"], 1)
        self.assertEqual(summary["new_assets"][0]["address"], "new.example")
        self.assertEqual(summary["new_findings"][0]["title"], "New XSS")
        self.assertEqual(summary["updated_findings"][0]["title"], "Status flip")
        # Old rows must not appear
        self.assertFalse(any(a["id"] == "a-old" for a in summary["new_assets"] + summary["updated_assets"]))
        self.assertFalse(any(v["id"] == "v-old" for v in summary["new_findings"] + summary["updated_findings"]))


if __name__ == "__main__":
    unittest.main()
