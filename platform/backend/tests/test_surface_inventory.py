"""Spec #410 — Durable surface inventory + NEW on first admit (pure)."""
from __future__ import annotations

import unittest

from app.services.surface_inventory import (
    admit_identity_memory,
    admit_many_memory,
    empty_memory_inventory,
    host_from_origin_key,
    inventory_identity_key,
    merge_with_inventory_novelty,
    stamp_is_new_from_novelty,
)
from app.services.surface_ledger import (
    merge_surface_row,
    merge_surfaces_into_context,
    normalize_surface_row,
    resolve_upsert_status,
    surface_ledger_for_snapshot,
    surface_row_key,
    upsert_into_ledger,
)


def _row(**overrides):
    base = {
        "origin_key": "https://example.com:443",
        "path_key": "/api/users",
        "location": "https://example.com/api/users",
        "kind": "url",
        "methods": ["GET"],
        "status": "seen",
        "conversation_id": "conv-a",
        "source": "traffic",
    }
    base.update(overrides)
    return base


class TestInventoryIdentity(unittest.TestCase):
    def test_identity_aligns_with_surface_row_key(self):
        ok = "https://example.com:443"
        pk = "/api/users"
        self.assertEqual(
            inventory_identity_key(ok, pk),
            surface_row_key(ok, pk),
        )

    def test_host_from_origin_key(self):
        self.assertEqual(host_from_origin_key("https://Example.COM:443"), "example.com")
        self.assertEqual(host_from_origin_key("http://10.0.0.5:8080"), "10.0.0.5")
        self.assertEqual(host_from_origin_key(""), "")


class TestInventoryAdmitMemory(unittest.TestCase):
    def test_first_admit_is_new_second_not(self):
        inv = empty_memory_inventory()
        first = admit_identity_memory(
            inv,
            "https://example.com:443",
            "/novel",
            conversation_id="conv-1",
        )
        self.assertTrue(first["is_new"])
        self.assertIn(first["key"], inv)

        second = admit_identity_memory(
            inv,
            "https://example.com:443",
            "/novel",
            conversation_id="conv-2",
        )
        self.assertFalse(second["is_new"])
        # Same inventory record; last conversation updated
        self.assertEqual(inv[first["key"]]["last_conversation_id"], "conv-2")
        self.assertEqual(inv[first["key"]]["first_conversation_id"], "conv-1")

    def test_admit_many_and_stamp(self):
        inv = empty_memory_inventory()
        rows = [
            _row(path_key="/a", location="https://example.com/a"),
            _row(path_key="/b", location="https://example.com/b"),
        ]
        novelty = admit_many_memory(inv, rows, conversation_id="c1")
        self.assertTrue(novelty[inventory_identity_key("https://example.com:443", "/a")])
        self.assertTrue(novelty[inventory_identity_key("https://example.com:443", "/b")])

        stamped = stamp_is_new_from_novelty(rows, novelty)
        self.assertTrue(stamped[0]["is_new"])
        self.assertTrue(stamped[1]["is_new"])

        # Re-admit same identities → not NEW
        novelty2 = admit_many_memory(inv, rows, conversation_id="c2")
        stamped2 = stamp_is_new_from_novelty(rows, novelty2)
        self.assertFalse(stamped2[0]["is_new"])
        self.assertFalse(stamped2[1]["is_new"])


class TestIsNewOnCaseLedger(unittest.TestCase):
    def test_first_admit_case_row_is_new(self):
        inv = empty_memory_inventory()
        row = normalize_surface_row(_row(), conversation_id="conv-a")
        assert row
        ctx, landed, novelty = merge_with_inventory_novelty(
            {},
            [row],
            inv,
            conversation_id="conv-a",
        )
        self.assertEqual(len(landed), 1)
        self.assertTrue(landed[0]["is_new"])
        self.assertTrue(novelty[inventory_identity_key(row["origin_key"], row["path_key"])])
        panel = surface_ledger_for_snapshot(ctx, conversation_id="conv-a")
        self.assertTrue(panel["surfaces"][0]["is_new"])

    def test_second_case_same_identity_not_new(self):
        inv = empty_memory_inventory()
        row1 = normalize_surface_row(
            _row(conversation_id="conv-a"), conversation_id="conv-a"
        )
        assert row1
        merge_with_inventory_novelty({}, [row1], inv, conversation_id="conv-a")

        # Second Case, same durable inventory → not NEW
        row2 = normalize_surface_row(
            _row(conversation_id="conv-b", status="seen"),
            conversation_id="conv-b",
        )
        assert row2
        ctx_b, landed_b, novelty_b = merge_with_inventory_novelty(
            {},
            [row2],
            inv,
            conversation_id="conv-b",
        )
        self.assertEqual(len(landed_b), 1)
        self.assertFalse(landed_b[0]["is_new"])
        self.assertFalse(
            novelty_b[inventory_identity_key(row2["origin_key"], row2["path_key"])]
        )
        panel = surface_ledger_for_snapshot(ctx_b, conversation_id="conv-b")
        self.assertFalse(panel["surfaces"][0]["is_new"])

    def test_retest_old_identity_can_be_tested_without_new(self):
        """Retest: inventory-known path still advances TESTED (touched) this Case."""
        inv = empty_memory_inventory()
        # Prior Case admitted the path
        prior = normalize_surface_row(
            _row(status="seen", conversation_id="conv-old"),
            conversation_id="conv-old",
        )
        assert prior
        merge_with_inventory_novelty({}, [prior], inv, conversation_id="conv-old")

        # This Case: first hit seen (not NEW), later traffic → touched (TESTED)
        hit1 = normalize_surface_row(
            _row(status="seen", methods=["GET"], conversation_id="conv-new"),
            conversation_id="conv-new",
        )
        assert hit1
        ctx, landed1, _ = merge_with_inventory_novelty(
            {}, [hit1], inv, conversation_id="conv-new"
        )
        self.assertFalse(landed1[0]["is_new"])
        self.assertEqual(landed1[0]["status"], "seen")

        # Second traffic → touched (operator TESTED); is_new stays false
        hit2 = normalize_surface_row(
            _row(status="touched", methods=["POST"], conversation_id="conv-new"),
            conversation_id="conv-new",
        )
        assert hit2
        # Re-admit inventory (still not new)
        novelty = admit_many_memory(inv, [hit2], conversation_id="conv-new")
        stamped = stamp_is_new_from_novelty([hit2], novelty)
        ctx2, landed2 = merge_surfaces_into_context(ctx, stamped)
        self.assertEqual(len(landed2), 1)
        self.assertFalse(landed2[0]["is_new"])
        self.assertEqual(landed2[0]["status"], "touched")
        self.assertEqual(landed2[0]["methods"], ["GET", "POST"])

    def test_same_case_second_traffic_keeps_new_sticky(self):
        """First inventory admit → NEW; later settle (is_new false from re-admit) sticky-true."""
        inv = empty_memory_inventory()
        first = normalize_surface_row(
            _row(status="seen", methods=["GET"]), conversation_id="conv-a"
        )
        assert first
        ctx, landed1, _ = merge_with_inventory_novelty(
            {}, [first], inv, conversation_id="conv-a"
        )
        self.assertTrue(landed1[0]["is_new"])

        later = normalize_surface_row(
            _row(status="touched", methods=["POST"]), conversation_id="conv-a"
        )
        assert later
        novelty = admit_many_memory(inv, [later], conversation_id="conv-a")
        self.assertFalse(
            novelty[inventory_identity_key(later["origin_key"], later["path_key"])]
        )
        stamped = stamp_is_new_from_novelty([later], novelty)
        self.assertFalse(stamped[0]["is_new"])  # inventory says not first admit
        ctx2, landed2 = merge_surfaces_into_context(ctx, stamped)
        # Sticky engagement NEW
        self.assertTrue(landed2[0]["is_new"])
        self.assertEqual(landed2[0]["status"], "touched")

    def test_no_auto_tested_from_inventory_alone(self):
        """Inventory age does not invent TESTED — status still traffic-objective."""
        inv = empty_memory_inventory()
        # Pretend path was known for years
        admit_identity_memory(
            inv,
            "https://example.com:443",
            "/old",
            conversation_id="ancient",
        )
        row = normalize_surface_row(
            _row(
                path_key="/old",
                location="https://example.com/old",
                status="seen",
                methods=["GET"],
            ),
            conversation_id="conv-now",
        )
        assert row
        _, landed, _ = merge_with_inventory_novelty(
            {}, [row], inv, conversation_id="conv-now"
        )
        self.assertFalse(landed[0]["is_new"])
        # Still first-touch this Case → seen, not touched
        self.assertEqual(landed[0]["status"], "seen")
        # resolve_upsert_status still traffic-driven
        self.assertEqual(resolve_upsert_status("seen", "touched"), "touched")
        self.assertEqual(resolve_upsert_status(None, "seen"), "seen")

    def test_merge_sticky_true_or_incoming(self):
        existing = merge_surface_row(None, _row(is_new=False, status="seen"))
        self.assertFalse(existing["is_new"])
        upgraded = merge_surface_row(existing, _row(is_new=True, status="seen"))
        self.assertTrue(upgraded["is_new"])
        # Cannot clear
        cleared = merge_surface_row(upgraded, _row(is_new=False, status="touched"))
        self.assertTrue(cleared["is_new"])
        self.assertEqual(cleared["status"], "touched")

    def test_false_safe_default_without_stamp(self):
        row = normalize_surface_row(_row(), conversation_id="conv-a")
        assert row
        # No is_new on row from normalize
        self.assertNotIn("is_new", row)
        ctx, landed = merge_surfaces_into_context({}, [row])
        self.assertFalse(landed[0]["is_new"])


class TestInventoryDoesNotAffectStatusRank(unittest.TestCase):
    def test_status_advance_independent_of_is_new(self):
        a = normalize_surface_row(_row(status="seen", is_new=True), conversation_id="c")
        b = normalize_surface_row(
            _row(status="touched", is_new=False), conversation_id="c"
        )
        assert a and b
        a["is_new"] = True
        b["is_new"] = False
        ledger = upsert_into_ledger({}, a)
        ledger = upsert_into_ledger(ledger, b)
        row = ledger["surfaces"][0]
        self.assertEqual(row["status"], "touched")
        self.assertTrue(row["is_new"])


if __name__ == "__main__":
    unittest.main()
