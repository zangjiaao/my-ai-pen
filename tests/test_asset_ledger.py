"""Unit tests for asset ledger: one host per asset, ports+services, tags."""
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
    conversation_target_blobs,
    enrich_properties_ports,
    extract_api_endpoints,
    extract_ports,
    extract_ports_for_host,
    extract_services,
    extract_urls,
    is_valid_ledger_address,
    merge_discover_properties,
    merge_tags,
    normalize_address,
    normalize_port,
    normalize_tags,
    ports_summary,
    render_remediation_markdown,
    risk_summary_from_vulns,
    service_hints_for_host,
    split_host_port,
    tech_summary,
)


class AssetLedgerNormalizeTests(unittest.TestCase):
    def test_normalize_address_is_host_only(self):
        self.assertEqual(normalize_address("Example.COM"), "example.com")
        self.assertEqual(normalize_address("https://APP.example.com/path"), "app.example.com")
        # Port is NOT part of the asset key.
        self.assertEqual(normalize_address("10.0.0.5:8080"), "10.0.0.5")
        self.assertEqual(normalize_address("https://pay.example.com:8443/login"), "pay.example.com")
        self.assertEqual(normalize_address("pay.corp.local"), normalize_address("https://pay.corp.local/app"))
        self.assertEqual(normalize_address("reflected.php"), "")
        self.assertEqual(normalize_address("/vulnerabilities/fi/?page=include.php"), "")

    def test_split_host_port(self):
        host, port = split_host_port("10.0.0.5:8080")
        self.assertEqual(host, "10.0.0.5")
        self.assertEqual(port, "8080")
        host, port = split_host_port("https://pay.example.com:8443/x")
        self.assertEqual(host, "pay.example.com")
        self.assertEqual(port, "8443")
        host, port = split_host_port("pay.example.com")
        self.assertEqual(host, "pay.example.com")
        self.assertIsNone(port)
        self.assertEqual(normalize_port("80/tcp"), "80")
        self.assertIsNone(normalize_port("0"))
        self.assertIsNone(normalize_port("99999"))

    def test_extract_ports_from_task_target_url(self):
        """CTF targets often use high ports only present in task URL, not open_ports."""
        host = "115.190.179.231"
        blobs = conversation_target_blobs(
            {
                "task": {
                    "target": {"type": "url", "value": "http://115.190.179.231:52799"},
                    "scope": {"allow": ["http://115.190.179.231:52799"]},
                }
            }
        )
        self.assertEqual(extract_ports_for_host(host, *blobs), ["52799"])
        hints = service_hints_for_host(host, *blobs)
        self.assertTrue(any(h.get("port") == "52799" and h.get("name") == "http" for h in hints))
        props = enrich_properties_ports(
            {"open_ports": [], "services": []},
            host=host,
            related=[],
            extra_blobs=blobs,
        )
        self.assertEqual(extract_ports(props), ["52799"])
        self.assertIn("52799", ports_summary(props))

    def test_rejects_dirty_agent_path_assets(self):
        self.assertFalse(is_valid_ledger_address("reflected.php"))
        self.assertFalse(is_valid_ledger_address("include.php"))
        self.assertFalse(is_valid_ledger_address("/admin/login.php"))
        self.assertFalse(is_valid_ledger_address("unknown"))
        self.assertFalse(is_valid_ledger_address(""))
        self.assertTrue(is_valid_ledger_address("pay.example.com"))
        self.assertTrue(is_valid_ledger_address("https://pay.example.com/app/login.php"))
        self.assertTrue(is_valid_ledger_address("10.0.0.8"))
        self.assertTrue(is_valid_ledger_address("localhost:3000"))


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
        self.assertEqual(first["address"], "target.local")
        self.assertEqual(second["address"], "target.local")
        ports = extract_ports(second["properties"])
        self.assertEqual(ports, ["22", "80", "443"])
        services = extract_services(second["properties"])
        by_port = {str(s.get("port")): s for s in services}
        self.assertEqual(by_port["443"]["name"], "https")
        self.assertEqual(by_port["22"]["name"], "ssh")
        # One service per port.
        self.assertEqual(len(by_port), 3)
        self.assertIn("443/https", ports_summary(second["properties"]))
        self.assertIn("https", tech_summary(second["properties"]))

    def test_address_with_port_attaches_port_not_host_port_key(self):
        fields = apply_discover_to_asset_fields(
            existing=None,
            address="10.0.0.8:8443",
            services=[{"port": 8443, "name": "https"}],
        )
        self.assertEqual(fields["address"], "10.0.0.8")
        self.assertEqual(extract_ports(fields["properties"]), ["8443"])

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

    def test_different_hosts_are_not_merged_as_aliases(self):
        """IP and domain are separate assets; tags group them, not aliases."""
        first = apply_discover_to_asset_fields(
            existing=None,
            address="203.0.113.10",
            name="支付网关-IP",
            open_ports=[443],
        )
        # Caller only passes existing when host matches; simulate accidental wrong merge
        # is not desired — new discover of domain is a separate apply with existing=None.
        domain = apply_discover_to_asset_fields(
            existing=None,
            address="https://pay.example.com/login",
            open_ports=[80],
        )
        self.assertEqual(first["address"], "203.0.113.10")
        self.assertEqual(domain["address"], "pay.example.com")
        self.assertNotEqual(first["address"], domain["address"])

    def test_one_service_per_port_merges_fields(self):
        base = apply_discover_to_asset_fields(
            existing=None,
            address="10.0.0.1",
            services=[{"port": 80, "name": "http"}],
        )
        again = apply_discover_to_asset_fields(
            existing=base,
            address="10.0.0.1",
            services=[{"port": 80, "name": "http", "product": "nginx", "version": "1.24"}],
        )
        services = extract_services(again["properties"])
        self.assertEqual(len(services), 1)
        self.assertEqual(services[0]["port"], "80")
        self.assertEqual(services[0]["product"], "nginx")
        self.assertEqual(services[0]["version"], "1.24")

    def test_port_note_preserved_on_agent_rediscover(self):
        """User notes must survive agent rediscover that omits note."""
        from app.services.asset_ledger import merge_discover_properties

        with_note = merge_discover_properties(
            {},
            services=[{"port": "52799", "name": "http", "note": "CTF 靶场 9 关"}],
        )
        self.assertEqual(extract_services(with_note)[0].get("note"), "CTF 靶场 9 关")
        rediscover = merge_discover_properties(
            with_note,
            open_ports=["52799", "22"],
            services=[{"port": "22", "name": "ssh"}],
        )
        by_port = {s["port"]: s for s in extract_services(rediscover)}
        self.assertEqual(by_port["52799"].get("note"), "CTF 靶场 9 关")
        self.assertEqual(by_port["22"].get("name"), "ssh")
        # Explicit empty note clears.
        cleared = merge_discover_properties(
            rediscover,
            services=[{"port": "52799", "name": "http", "note": ""}],
        )
        self.assertFalse(extract_services(cleared)[0].get("note"))

    def test_tags_normalize_and_merge(self):
        self.assertEqual(normalize_tags("支付, 生产, 支付"), ["支付", "生产"])
        self.assertEqual(merge_tags(["生产"], ["支付", "生产"]), ["生产", "支付"])

    def test_rediscover_without_name_type_preserves_ledger_identity(self):
        existing = apply_discover_to_asset_fields(
            existing=None,
            address="pay.example.com",
            name="支付网关",
            asset_type="domain",
            open_ports=[443],
            services=[{"port": 443, "name": "https"}],
            source="manual",
        )
        rediscover = apply_discover_to_asset_fields(
            existing=existing,
            address="https://pay.example.com/login",
            name=None,
            asset_type=None,
            open_ports=[22],
            services=[{"port": 22, "name": "ssh"}],
            source="agent_discovered",
        )
        self.assertEqual(rediscover["name"], "支付网关")
        self.assertEqual(rediscover["type"], "domain")
        self.assertEqual(extract_ports(rediscover["properties"]), ["22", "443"])
        # Agent enrich must not rewrite user ownership source.
        self.assertEqual(rediscover["source"], "manual")

    def test_agent_enrich_merges_urls_and_api_endpoints(self):
        base = apply_discover_to_asset_fields(
            existing=None,
            address="app.example.com",
            source="manual",
            open_ports=[443],
            services=[{"port": 443, "name": "https", "url": "https://app.example.com"}],
        )
        again = apply_discover_to_asset_fields(
            existing=base,
            address="app.example.com",
            services=[{"port": 443, "name": "https", "product": "nginx"}],
            urls=["https://app.example.com/login", "https://app.example.com/admin"],
            api_endpoints=[
                {"method": "GET", "path": "/api/v1/users"},
                {"method": "POST", "path": "/api/v1/login", "url": "https://app.example.com/api/v1/login"},
            ],
        )
        props = again["properties"]
        self.assertEqual(again["source"], "manual")
        self.assertEqual(extract_urls(props), [
            "https://app.example.com/login",
            "https://app.example.com/admin",
        ])
        apis = extract_api_endpoints(props)
        self.assertEqual(len(apis), 2)
        self.assertEqual(apis[0]["method"], "GET")
        self.assertEqual(apis[0]["path"], "/api/v1/users")
        by_port = {s["port"]: s for s in extract_services(props)}
        self.assertEqual(by_port["443"].get("url"), "https://app.example.com")
        self.assertEqual(by_port["443"].get("product"), "nginx")

        # Second enrich unions without dropping prior surface.
        third = merge_discover_properties(
            props,
            urls=["https://app.example.com/login", "https://app.example.com/health"],
            api_endpoints=[{"method": "GET", "path": "/api/v1/users"}, {"path": "/api/health"}],
        )
        self.assertEqual(extract_urls(third), [
            "https://app.example.com/login",
            "https://app.example.com/admin",
            "https://app.example.com/health",
        ])
        self.assertEqual(len(extract_api_endpoints(third)), 3)

    def test_service_url_merges_on_rediscover(self):
        first = merge_discover_properties(
            {},
            services=[{"port": "8080", "name": "http"}],
        )
        second = merge_discover_properties(
            first,
            services=[{"port": "8080", "name": "http", "url": "http://10.0.0.5:8080/app"}],
        )
        self.assertEqual(extract_services(second)[0].get("url"), "http://10.0.0.5:8080/app")


class AssetLedgerRiskAndExportTests(unittest.TestCase):
    def test_risk_summary_counts_open_by_severity(self):
        risk = risk_summary_from_vulns(
            [
                {"severity": "high", "status": "confirmed", "port": "443"},
                {"severity": "critical", "status": "pending", "port": "80"},
                {"severity": "high", "status": "fixed", "port": "443"},
                {"severity": "low", "status": "open", "port": "22"},
            ]
        )
        self.assertEqual(risk["open_total"], 3)
        self.assertEqual(risk["by_severity"]["critical"], 1)
        self.assertEqual(risk["by_severity"]["high"], 1)
        self.assertEqual(risk["by_severity"]["low"], 1)
        self.assertEqual(risk["highest"], "critical")
        self.assertIn("3 开放", risk["label"])

    def test_remediation_markdown_includes_port(self):
        md = render_remediation_markdown(
            {
                "name": "支付网关",
                "address": "pay.example.com",
                "type": "domain",
                "source": "manual",
                "tags": ["支付系统"],
                "properties": {
                    "open_ports": [443],
                    "services": [{"port": 443, "name": "https", "product": "nginx", "version": "1.24"}],
                },
            },
            [
                {
                    "title": "SQL 注入 - 登录接口",
                    "severity": "high",
                    "status": "confirmed",
                    "confidence": "high",
                    "port": "443",
                    "description": "id 参数可注入",
                    "remediation": "使用参数化查询",
                }
            ],
        )
        self.assertIn("支付网关", md)
        self.assertIn("pay.example.com", md)
        self.assertIn("支付系统", md)
        self.assertIn("端口：`443`", md)
        self.assertIn("SQL 注入 - 登录接口", md)
        self.assertIn("使用参数化查询", md)


class AssetLedgerChangesTests(unittest.TestCase):
    def test_seven_day_window_excludes_old_events(self):
        now = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)
        assets = [
            {
                "id": "a-new",
                "name": "new",
                "address": "new.example",
                "type": "domain",
                "created_at": (now - timedelta(days=2)).isoformat(),
                "updated_at": (now - timedelta(days=2)).isoformat(),
            },
            {
                "id": "a-old",
                "name": "old",
                "address": "old.example",
                "type": "domain",
                "created_at": (now - timedelta(days=30)).isoformat(),
                "updated_at": (now - timedelta(days=20)).isoformat(),
            },
            {
                "id": "a-upd",
                "name": "upd",
                "address": "upd.example",
                "type": "domain",
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
                "port": "443",
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


if __name__ == "__main__":
    unittest.main()
