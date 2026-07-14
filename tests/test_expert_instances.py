"""Unit tests for product expert instances (name validation + pack/node gate helpers)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "platform" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.expert_instances import (
    match_expert_by_mention_token,
    validate_expert_name,
    validate_pack_for_node,
)
from app.services.expert_offers import install_offer


class ExpertNameTests(unittest.TestCase):
    def test_valid_names(self):
        self.assertEqual(validate_expert_name("WebHunter"), "WebHunter")
        self.assertEqual(validate_expert_name("@ctf-lab"), "ctf-lab")
        self.assertEqual(validate_expert_name("  a.b:c_1  "), "a.b:c_1")
        self.assertEqual(validate_expert_name("渗透专家"), "渗透专家")
        self.assertEqual(validate_expert_name("@Web渗透"), "Web渗透")

    def test_invalid_names(self):
        with self.assertRaises(ValueError):
            validate_expert_name("")
        with self.assertRaises(ValueError):
            validate_expert_name("has space")
        with self.assertRaises(ValueError):
            validate_expert_name("有 空格")


class PackGateTests(unittest.TestCase):
    def test_pack_must_be_offered(self):
        cfg, _ = install_offer({}, "pentest")
        self.assertEqual(validate_pack_for_node(cfg, "pentest"), "pentest")
        with self.assertRaises(ValueError):
            validate_pack_for_node(cfg, "ctf")

    def test_aliases_fold(self):
        cfg, _ = install_offer({}, "pentest")
        cfg, _ = install_offer(cfg, "ctf")
        self.assertEqual(validate_pack_for_node(cfg, "ctf-web"), "ctf")


class MentionMatchTests(unittest.TestCase):
    def test_exact_case_insensitive(self):
        experts = [
            SimpleNamespace(name="WebHunter", enabled=True, pack_id="pentest", node_id="n1"),
            SimpleNamespace(name="ctf-lab", enabled=True, pack_id="ctf", node_id="n1"),
            SimpleNamespace(name="渗透专家", enabled=True, pack_id="pentest", node_id="n1"),
        ]
        hit = match_expert_by_mention_token("webhunter", experts)
        self.assertIsNotNone(hit)
        self.assertEqual(hit.name, "WebHunter")
        self.assertEqual(match_expert_by_mention_token("渗透专家", experts).name, "渗透专家")
        self.assertIsNone(match_expert_by_mention_token("missing", experts))

    def test_disabled_skipped(self):
        experts = [
            SimpleNamespace(name="WebHunter", enabled=False, pack_id="pentest", node_id="n1"),
        ]
        self.assertIsNone(match_expert_by_mention_token("WebHunter", experts))


class ExpertRouteApplyTests(unittest.TestCase):
    """Expert is routing primary: pack engagement always comes from the instance."""

    def test_apply_expert_sets_pack_and_node(self):
        from app.ws.router import _apply_expert_route_to_message, _find_expert_in_list

        expert = SimpleNamespace(
            id="e1",
            name="渗透",
            display_name="渗透专家",
            pack_id="pentest",
            node_id="n-worker",
            enabled=True,
        )
        out = _apply_expert_route_to_message({"text": "@渗透 hello", "engagement": "stale"}, expert)
        self.assertEqual(out["engagement"], "pentest")
        self.assertEqual(out["role"], "pentest")
        self.assertEqual(out["agent_node_id"], "n-worker")
        self.assertEqual(out["expert_id"], "e1")
        self.assertEqual(out["expert_name"], "渗透")
        self.assertEqual(out["content"]["expert_display_name"], "渗透专家")

        found = _find_expert_in_list([expert], expert_id="e1")
        self.assertIs(found, expert)
        found_by_name = _find_expert_in_list([expert], expert_name="渗透")
        self.assertIs(found_by_name, expert)

    def test_pack_for_capability_maps_pentest_web(self):
        from app.ws.router import _pack_for_capability

        self.assertEqual(_pack_for_capability("pentest.web"), "pentest")
        self.assertEqual(_pack_for_capability("ctf.web"), "ctf")


if __name__ == "__main__":
    unittest.main()
