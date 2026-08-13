"""Owner ledger seams — Spec #454a (Group × Host × Service assembly).

Primary seam: asset_ledger projection. Worked examples come from
docs/specs/owner-ledger.md, not from ORM or React.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "platform" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.asset_ledger import (  # noqa: E402
    SERVICE_ADMIT_SOURCES,
    admit_owner_path,
    apply_service_tags,
    build_scope_allow,
    extract_services,
    merge_discover_properties,
    merge_official_service,
    owner_target_from_location,
    owner_target_from_surface_row,
    project_owner_ledger,
    read_host_services,
    service_source_admits,
)


def _company_sample() -> dict:
    """Spec sample: same Host in 公司 / 系统1 / 系统2 with different ports."""
    hosts = [
        {
            "id": "h1",
            "address": "1.1.1.1",
            "name": "1.1.1.1",
            "tags": ["部门1"],
            "properties": {
                "services": [
                    {"port": "80", "name": "http", "tags": ["系统1"]},
                    {"port": "443", "name": "https", "tags": ["系统2"]},
                    {"port": "8080", "name": "http"},
                ],
            },
        },
        {
            "id": "h2",
            "address": "2.2.2.2",
            "name": "2.2.2.2",
            "tags": ["系统2", "部门2"],
            "properties": {
                "services": [
                    {"port": "1143", "name": "tcp"},
                    {"port": "1443", "name": "tcp", "tags": ["数据库服务器"]},
                ],
            },
        },
    ]
    # Second view of h2 in 系统2 uses Host tag 数据库服务器 (spec sample 2).
    hosts[1]["tags"] = ["系统2", "部门2"]
    groups = [
        {"id": "g-co", "name": "XXX公司"},
        {"id": "g-s1", "name": "XXX系统1"},
        {"id": "g-s2", "name": "XXX系统2"},
    ]
    assemblies = [
        {"group_id": "g-co", "asset_id": "h1", "ports": ["80", "443"]},
        {"group_id": "g-co", "asset_id": "h2", "ports": ["1143"]},
        {"group_id": "g-s1", "asset_id": "h1", "ports": ["80", "443"]},
        {"group_id": "g-s2", "asset_id": "h1", "ports": ["8080"]},
        {"group_id": "g-s2", "asset_id": "h2", "ports": ["1443"]},
    ]
    # 系统2 Host tags from the spec diagram
    hosts_s2 = [
        {**hosts[0], "tags": ["应用服务器"]},
        {**hosts[1], "tags": ["数据库服务器"]},
    ]
    return {
        "hosts": hosts,
        "hosts_s2_tags": hosts_s2,
        "groups": groups,
        "assemblies": assemblies,
    }


def _group(tree: list[dict], name: str) -> dict:
    return next(g for g in tree if g["name"] == name)


def _host(group: dict, address: str) -> dict:
    return next(h for h in group["hosts"] if h["address"] == address)


def _ports(host: dict) -> list[str]:
    return [str(s["port"]) for s in host.get("services") or []]


class OwnerLedgerAssemblyTests(unittest.TestCase):
    def test_same_host_two_groups_keep_different_port_subsets(self):
        sample = _company_sample()
        tree = project_owner_ledger(
            hosts=sample["hosts"],
            groups=sample["groups"],
            assemblies=sample["assemblies"],
        )
        company = _group(tree, "XXX公司")
        system2 = _group(tree, "XXX系统2")
        self.assertEqual(_ports(_host(company, "1.1.1.1")), ["80", "443"])
        self.assertEqual(_ports(_host(system2, "1.1.1.1")), ["8080"])
        self.assertEqual(_ports(_host(company, "2.2.2.2")), ["1143"])
        self.assertEqual(_ports(_host(system2, "2.2.2.2")), ["1443"])

    def test_opening_system2_does_not_show_company_web_ports(self):
        sample = _company_sample()
        tree = project_owner_ledger(
            hosts=sample["hosts"],
            groups=sample["groups"],
            assemblies=sample["assemblies"],
            group_ids=["g-s2"],
        )
        self.assertEqual([g["name"] for g in tree], ["XXX系统2"])
        host = _host(tree[0], "1.1.1.1")
        self.assertEqual(_ports(host), ["8080"])
        self.assertNotIn("80", _ports(host))
        self.assertNotIn("443", _ports(host))

    def test_empty_port_subset_is_bare_host(self):
        tree = project_owner_ledger(
            hosts=[{
                "id": "h1",
                "address": "1.1.1.1",
                "tags": [],
                "properties": {"services": [{"port": "80"}]},
            }],
            groups=[{"id": "g1", "name": "项目A"}],
            assemblies=[{"group_id": "g1", "asset_id": "h1", "ports": []}],
        )
        host = _host(_group(tree, "项目A"), "1.1.1.1")
        self.assertEqual(_ports(host), [])

    def test_ungrouped_hosts_appear_under_ungrouped(self):
        tree = project_owner_ledger(
            hosts=[
                {"id": "h1", "address": "1.1.1.1", "tags": [], "properties": {"services": [{"port": "80"}]}},
                {"id": "h2", "address": "9.9.9.9", "tags": [], "properties": {"services": [{"port": "22"}]}},
            ],
            groups=[{"id": "g1", "name": "项目A"}],
            assemblies=[{"group_id": "g1", "asset_id": "h1", "ports": ["80"]}],
        )
        names = [g["name"] for g in tree]
        self.assertIn("未分组", names)
        self.assertEqual([h["address"] for h in _group(tree, "未分组")["hosts"]], ["9.9.9.9"])
        self.assertEqual(_ports(_group(tree, "未分组")["hosts"][0]), ["22"])


class OwnerLedgerTagSearchTests(unittest.TestCase):
    def test_host_and_service_tag_and_clips_to_matching_port(self):
        """部门1 ∧ 系统2 → 公司组里 1.1.1.1 只剩 :443。"""
        sample = _company_sample()
        tree = project_owner_ledger(
            hosts=sample["hosts"],
            groups=sample["groups"],
            assemblies=sample["assemblies"],
            tags=["部门1", "系统2"],
        )
        company = _group(tree, "XXX公司")
        self.assertEqual([h["address"] for h in company["hosts"]], ["1.1.1.1"])
        self.assertEqual(_ports(_host(company, "1.1.1.1")), ["443"])
        # 系统2 组装只有 :8080，对不上 系统2 这个 Service tag；组内也没有同时带 部门1 的 Host。
        self.assertNotIn("XXX系统2", [g["name"] for g in tree])

    def test_group_and_host_tag_keeps_system2_database_host(self):
        """Group=系统2 ∧ tag=数据库服务器 → 2.2.2.2 :1443 only."""
        sample = _company_sample()
        tree = project_owner_ledger(
            hosts=sample["hosts_s2_tags"],
            groups=sample["groups"],
            assemblies=sample["assemblies"],
            group_ids=["g-s2"],
            tags=["数据库服务器"],
        )
        self.assertEqual([g["name"] for g in tree], ["XXX系统2"])
        self.assertEqual([h["address"] for h in tree[0]["hosts"]], ["2.2.2.2"])
        self.assertEqual(_ports(tree[0]["hosts"][0]), ["1443"])

    def test_service_only_tag_clips_without_dropping_host(self):
        sample = _company_sample()
        tree = project_owner_ledger(
            hosts=sample["hosts"],
            groups=sample["groups"],
            assemblies=sample["assemblies"],
            tags=["系统2"],
        )
        company_h1 = _host(_group(tree, "XXX公司"), "1.1.1.1")
        self.assertEqual(_ports(company_h1), ["443"])
        # Host-level 系统2 on 2.2.2.2 keeps all assembly services in that group
        company_h2 = _host(_group(tree, "XXX公司"), "2.2.2.2")
        self.assertEqual(_ports(company_h2), ["1143"])

    def test_two_service_tags_on_different_ports_hide_host(self):
        sample = _company_sample()
        tree = project_owner_ledger(
            hosts=sample["hosts"],
            groups=sample["groups"],
            assemblies=sample["assemblies"],
            tags=["系统1", "系统2"],
        )
        # No single service carries both tags; AND clips to empty → host omitted
        company_hosts = [h["address"] for h in _group(tree, "XXX公司")["hosts"]] if any(
            g["name"] == "XXX公司" for g in tree
        ) else []
        self.assertNotIn("1.1.1.1", company_hosts)

    def test_tag_write_does_not_create_a_group(self):
        props = apply_service_tags(
            {"services": [{"port": "80", "name": "http"}]},
            {"80": ["系统1"]},
        )
        self.assertEqual(extract_services(props)[0].get("tags"), ["系统1"])
        tree = project_owner_ledger(
            hosts=[{"id": "h1", "address": "1.1.1.1", "tags": [], "properties": props}],
            groups=[],
            assemblies=[],
        )
        self.assertEqual([g["name"] for g in tree], ["未分组"])

    def test_service_merge_preserves_aliases(self):
        again = merge_discover_properties(
            {
                "aliases": ["example.com"],
                "services": [{"port": "80", "name": "http", "tags": ["系统1"]}],
            },
            services=[{"port": "80", "name": "http", "note": "web"}],
        )
        self.assertEqual(again.get("aliases"), ["example.com"])
        self.assertEqual(extract_services(again)[0].get("tags"), ["系统1"])

    def test_service_tags_survive_agent_rediscover(self):
        tagged = apply_service_tags(
            {"services": [{"port": "80", "name": "http"}]},
            {"80": ["系统1"]},
        )
        again = merge_discover_properties(
            tagged,
            open_ports=["80", "22"],
            services=[{"port": "22", "name": "ssh"}],
        )
        by_port = {s["port"]: s for s in extract_services(again)}
        self.assertEqual(by_port["80"].get("tags"), ["系统1"])
        self.assertEqual(by_port["22"].get("name"), "ssh")


class OwnerLedgerKeywordTests(unittest.TestCase):
    def test_keyword_on_alias_finds_host(self):
        tree = project_owner_ledger(
            hosts=[{
                "id": "h1",
                "address": "1.1.1.1",
                "tags": [],
                "properties": {
                    "aliases": ["example.com"],
                    "services": [{"port": "443"}],
                },
            }],
            groups=[],
            assemblies=[],
            keyword="example.com",
        )
        self.assertEqual(_host(_group(tree, "未分组"), "1.1.1.1")["aliases"], ["example.com"])

    def test_keyword_port_clips_to_that_port(self):
        sample = _company_sample()
        tree = project_owner_ledger(
            hosts=sample["hosts"],
            groups=sample["groups"],
            assemblies=sample["assemblies"],
            keyword="8080",
        )
        self.assertEqual([g["name"] for g in tree], ["XXX系统2"])
        self.assertEqual(_ports(_host(tree[0], "1.1.1.1")), ["8080"])

    def test_distinct_vhosts_stay_two_hosts(self):
        tree = project_owner_ledger(
            hosts=[
                {"id": "ha", "address": "a.example.com", "tags": [], "properties": {"services": [{"port": "443"}]}},
                {"id": "hb", "address": "b.example.com", "tags": [], "properties": {"services": [{"port": "443"}]}},
            ],
            groups=[],
            assemblies=[],
        )
        addrs = [h["address"] for h in _group(tree, "未分组")["hosts"]]
        self.assertEqual(addrs, ["a.example.com", "b.example.com"])


class OwnerLedgerScopeTests(unittest.TestCase):
    def test_assembly_does_not_change_scope_allow(self):
        host = {
            "address": "1.1.1.1",
            "properties": {
                "aliases": ["example.com"],
                "services": [{"port": "80"}, {"port": "8080"}],
            },
        }
        before = build_scope_allow([host])
        project_owner_ledger(
            hosts=[{**host, "id": "h1", "tags": []}],
            groups=[{"id": "g1", "name": "OA"}],
            assemblies=[{"group_id": "g1", "asset_id": "h1", "ports": ["8080"]}],
        )
        after = build_scope_allow([host])
        self.assertEqual(before, ["1.1.1.1", "example.com"])
        self.assertEqual(after, before)


class OwnerLedgerServiceRowTests(unittest.TestCase):
    def test_same_host_port_merges_and_ports_stay_distinct(self):
        first = merge_official_service(None, {"port": "80", "name": "http", "tags": ["系统1"]})
        again = merge_official_service(first, {"port": "80", "product": "nginx"})
        other = merge_official_service(None, {"port": "443", "name": "https", "tags": ["系统2"]})
        self.assertEqual(again["port"], "80")
        self.assertEqual(again["name"], "http")
        self.assertEqual(again["product"], "nginx")
        self.assertEqual(again["tags"], ["系统1"])
        self.assertEqual(other["tags"], ["系统2"])
        self.assertNotEqual(again["port"], other["port"])

    def test_scan_sized_enrich_does_not_admit_service_row(self):
        self.assertFalse(service_source_admits("scan"))
        self.assertFalse(service_source_admits("syn"))
        self.assertFalse(service_source_admits("agent_discovered"))
        self.assertFalse(service_source_admits("discover"))
        self.assertTrue(service_source_admits("user"))
        self.assertTrue(service_source_admits("book"))
        self.assertTrue(service_source_admits("http_settle"))
        self.assertEqual(SERVICE_ADMIT_SOURCES, frozenset({"user", "book", "http_settle"}))

    def test_dual_read_uses_json_until_rows_exist(self):
        props = {"services": [{"port": "80", "name": "http", "tags": ["系统1"]}]}
        listed = read_host_services(props, None)
        self.assertEqual([s["port"] for s in listed], ["80"])
        self.assertEqual(listed[0]["tags"], ["系统1"])

    def test_dual_read_keeps_json_ports_when_rows_partial(self):
        props = {
            "services": [
                {"port": "80", "name": "http"},
                {"port": "443", "name": "https", "tags": ["旧"]},
            ]
        }
        rows = [{"port": "443", "name": "https", "tags": ["系统2"]}]
        listed = read_host_services(props, rows)
        by_port = {s["port"]: s for s in listed}
        self.assertEqual(sorted(by_port), ["443", "80"])
        self.assertEqual(by_port["443"]["tags"], ["系统2"])
        self.assertEqual(by_port["80"]["name"], "http")


class OwnerLedgerPathBookTests(unittest.TestCase):
    def test_book_and_http_settle_admit_path_scan_does_not(self):
        booked = admit_owner_path([], path="/login", source="book")
        settled = admit_owner_path(booked, path="/admin", source="http_settle")
        self.assertEqual([p["path"] for p in booked], ["/login"])
        self.assertEqual([p["path"] for p in settled], ["/login", "/admin"])
        self.assertIsNone(admit_owner_path([], path="/scan", source="scan"))
        self.assertIsNone(admit_owner_path([], path="/syn", source="syn"))

    def test_same_path_merges_and_does_not_rewrite_surface_fields(self):
        first = admit_owner_path([], path="/login", source="book")
        again = admit_owner_path(first, path="/login", source="http_settle")
        self.assertEqual(len(again), 1)
        self.assertEqual(again[0]["path"], "/login")
        self.assertNotIn("origin_key", again[0])
        self.assertNotIn("status", again[0])
        self.assertNotIn("case_tested", again[0])
        self.assertNotIn("is_new", again[0])

    def test_http_location_yields_host_port_path_without_creating_host(self):
        target = owner_target_from_location("https://1.1.1.1:8443/admin/login?x=1")
        self.assertEqual(target["host"], "1.1.1.1")
        self.assertEqual(target["port"], "8443")
        self.assertEqual(target["path"], "/admin/login")
        self.assertEqual(target["scheme"], "https")
        self.assertIsNone(owner_target_from_location("ssh://1.1.1.1:22"))
        self.assertIsNone(owner_target_from_location("/only/path"))

    def test_surface_row_http_settle_maps_without_mutating_row(self):
        row = {
            "origin_key": "https://pay.example.com:443",
            "path_key": "/checkout",
            "status": "touched",
            "case_tested": True,
            "is_new": True,
        }
        snapshot = dict(row)
        target = owner_target_from_surface_row(row)
        self.assertEqual(target["host"], "pay.example.com")
        self.assertEqual(target["port"], "443")
        self.assertEqual(target["path"], "/checkout")
        self.assertEqual(row, snapshot)


if __name__ == "__main__":
    unittest.main()

