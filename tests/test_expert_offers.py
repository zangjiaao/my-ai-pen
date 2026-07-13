"""Unit tests for node expert offers, dispatch gate, install/uninstall, usage billing hooks."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "platform" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.expert_catalog import catalog_pack_ids, load_experts_catalog
from app.services.expert_offers import (
    ACTION_INSTALL,
    ACTION_UNINSTALL,
    ACTION_USAGE,
    DEFAULT_OFFER,
    DEFAULT_OFFERS,
    billing_code_for,
    dispatch_gate_error,
    effective_offers,
    engagement_allowed,
    engagement_from_task_message,
    install_offer,
    known_pack_ids,
    normalize_pack_id,
    uninstall_offer,
    usage_billing_detail,
)


class EffectiveOffersTests(unittest.TestCase):
    def test_missing_config_defaults_to_pentest_only(self):
        self.assertEqual(effective_offers(None), ["pentest"])
        self.assertEqual(effective_offers({}), ["pentest"])
        self.assertEqual(effective_offers({"token": "x"}), ["pentest"])

    def test_empty_offers_list_defaults_to_pentest(self):
        self.assertEqual(effective_offers({"offers": []}), ["pentest"])
        self.assertEqual(effective_offers({"offers": None}), ["pentest"])

    def test_explicit_offers_preserved_and_deduped(self):
        self.assertEqual(
            effective_offers({"offers": ["ctf", "pentest", "ctf"]}),
            ["ctf", "pentest"],
        )

    def test_aliases_fold_to_canonical_pack_ids(self):
        self.assertEqual(effective_offers({"offers": ["assess", "ctf-web"]}), ["pentest", "ctf"])

    def test_unknown_entries_dropped(self):
        self.assertEqual(effective_offers({"offers": ["nope", "pentest"]}), ["pentest"])
        # all unknown → default
        self.assertEqual(effective_offers({"offers": ["nope"]}), ["pentest"])


class NormalizeEngagementTests(unittest.TestCase):
    def test_aliases(self):
        self.assertEqual(normalize_pack_id("CTF"), "ctf")
        self.assertEqual(normalize_pack_id("assess"), "pentest")
        self.assertEqual(normalize_pack_id("retest"), "pentest")
        self.assertEqual(normalize_pack_id("consult"), "consult")
        self.assertEqual(normalize_pack_id("challenge"), "ctf")
        self.assertIsNone(normalize_pack_id(""))
        self.assertIsNone(normalize_pack_id("unknown-pack"))


class DispatchGateTests(unittest.TestCase):
    def test_default_engagement_allowed_when_pentest_offered(self):
        offers = effective_offers({})
        self.assertTrue(engagement_allowed(offers, None))
        self.assertTrue(engagement_allowed(offers, ""))
        self.assertTrue(engagement_allowed(offers, "pentest"))
        self.assertTrue(engagement_allowed(offers, "assess"))
        self.assertIsNone(dispatch_gate_error({}, None))
        self.assertIsNone(dispatch_gate_error({}, "retest"))

    def test_ctf_blocked_when_only_pentest(self):
        offers = effective_offers({})
        self.assertFalse(engagement_allowed(offers, "ctf"))
        err = dispatch_gate_error({}, "ctf")
        self.assertIsNotNone(err)
        self.assertIn("ctf", err.lower())
        self.assertIn("pentest", err.lower())

    def test_ctf_allowed_after_install(self):
        cfg, detail = install_offer({}, "ctf")
        self.assertIn("ctf", cfg["offers"])
        self.assertEqual(detail["action"], "install")
        self.assertEqual(detail["expert_id"], "ctf")
        self.assertEqual(detail["billing_code"], billing_code_for("ctf"))
        self.assertTrue(engagement_allowed(effective_offers(cfg), "ctf"))
        self.assertIsNone(dispatch_gate_error(cfg, "ctf"))
        self.assertTrue(engagement_allowed(effective_offers(cfg), "challenge"))

    def test_unknown_engagement_blocked(self):
        self.assertFalse(engagement_allowed(["pentest"], "made-up-role"))
        self.assertIsNotNone(dispatch_gate_error({"offers": ["pentest"]}, "made-up-role"))


class InstallUninstallTests(unittest.TestCase):
    def test_install_then_uninstall_roundtrip(self):
        cfg0 = {}
        cfg1, d_inst = install_offer(cfg0, "ctf")
        self.assertEqual(sorted(cfg1["offers"]), ["ctf", "pentest"])
        self.assertEqual(d_inst["billing_code"], "expert.ctf")
        self.assertEqual(d_inst["action"], "install")

        cfg2, d_rm = uninstall_offer(cfg1, "ctf")
        self.assertEqual(cfg2["offers"], ["pentest"])
        self.assertEqual(d_rm["action"], "remove")
        self.assertTrue(d_rm["was_installed"])
        self.assertEqual(d_rm["billing_code"], "expert.ctf")
        self.assertFalse(engagement_allowed(effective_offers(cfg2), "ctf"))

    def test_cannot_uninstall_last_offer(self):
        cfg, _ = install_offer({}, "ctf")
        cfg, _ = uninstall_offer(cfg, "ctf")  # back to pentest only
        with self.assertRaises(ValueError) as ctx:
            uninstall_offer(cfg, "pentest")
        self.assertIn("at least one", str(ctx.exception).lower())

    def test_unknown_expert_raises(self):
        with self.assertRaises(ValueError):
            install_offer({}, "not-a-pack")
        with self.assertRaises(ValueError):
            uninstall_offer({}, "not-a-pack")

    def test_idempotent_install(self):
        cfg, d1 = install_offer({}, "ctf")
        cfg2, d2 = install_offer(cfg, "ctf")
        self.assertEqual(cfg2["offers"].count("ctf"), 1)
        self.assertTrue(d2["already_installed"])

    def test_action_constants_stable(self):
        self.assertEqual(ACTION_INSTALL, "expert.install")
        self.assertEqual(ACTION_UNINSTALL, "expert.uninstall")
        self.assertEqual(ACTION_USAGE, "expert.usage")


class UsageBillingTests(unittest.TestCase):
    def test_usage_detail_includes_pack_and_billing_code(self):
        detail = usage_billing_detail(
            engagement="ctf",
            task_id="t-1",
            conversation_id="c-1",
            node_id="n-1",
            status="completed",
        )
        self.assertEqual(detail["expert_id"], "ctf")
        self.assertEqual(detail["billing_code"], "expert.ctf")
        self.assertEqual(detail["action"], "usage")
        self.assertEqual(detail["task_id"], "t-1")
        self.assertEqual(detail["status"], "completed")

    def test_usage_defaults_to_pentest(self):
        detail = usage_billing_detail()
        self.assertEqual(detail["expert_id"], DEFAULT_OFFER)
        self.assertEqual(detail["billing_code"], "expert.pentest")


class TaskMessageEngagementTests(unittest.TestCase):
    def test_reads_structured_fields_only(self):
        self.assertEqual(engagement_from_task_message({"engagement": "ctf"}), "ctf")
        self.assertEqual(engagement_from_task_message({"role": "consult"}), "consult")
        self.assertEqual(
            engagement_from_task_message({"snapshot": {"engagement": "retest"}}),
            "retest",
        )
        # Free-text instruction must NOT invent engagement.
        self.assertEqual(
            engagement_from_task_message(
                {"text": "please run a CTF challenge engagement verify"}
            ),
            "",
        )


class AssignPayloadBuilderTests(unittest.TestCase):
    """Structural payload builder: engagement select → task_assign fields."""

    def test_builder_sets_engagement_without_nlp(self):
        # Pure helper mirrors what UI/WS should put on the wire.
        def build_assign(engagement: str | None, goal_mode: bool = False) -> dict:
            out: dict = {
                "type": "task_assign",
                "initial_instruction": "scan target",
            }
            eng = (engagement or "").strip()
            if eng:
                out["engagement"] = eng
                pack = normalize_pack_id(eng)
                if pack:
                    out["role"] = pack
            if goal_mode:
                out["goal_mode"] = True
            return out

        ctf = build_assign("ctf", goal_mode=True)
        pentest = build_assign("pentest")
        default = build_assign(None)
        self.assertEqual(ctf["engagement"], "ctf")
        self.assertEqual(ctf["role"], "ctf")
        self.assertTrue(ctf.get("goal_mode"))
        self.assertEqual(pentest["engagement"], "pentest")
        self.assertNotIn("engagement", default)
        self.assertNotEqual(ctf["engagement"], pentest["engagement"])


class CatalogAlignmentTests(unittest.TestCase):
    def test_known_ids_from_experts_catalog_file(self):
        cat = load_experts_catalog()
        self.assertEqual(cat["source"], "file", f"expected file catalog, got {cat}")
        ids = known_pack_ids()
        self.assertIn("pentest", ids)
        self.assertIn("ctf", ids)
        self.assertIn("consult", ids)
        self.assertEqual(ids, catalog_pack_ids())
        # Must not be a hand-maintained set that ignores catalog path
        self.assertTrue(str(cat["path"]).endswith("experts/catalog.json") or "experts" in str(cat["path"]))


if __name__ == "__main__":
    unittest.main()
