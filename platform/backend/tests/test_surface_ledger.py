"""Spec #368 / #373 / #379 — Case surface_ledger pure merge + status v2 + snapshot."""
from __future__ import annotations

import unittest

from app.services.surface_ledger import (
    LEGACY_STATUS_MAP,
    apply_booked_side_effect,
    apply_status_advance,
    can_transition_status,
    compose_http_location,
    empty_ledger,
    extract_surfaces_from_upsert_message,
    is_surface_status,
    is_write_surface_status,
    map_legacy_attack_surface_item,
    merge_import_package_into_context,
    merge_methods,
    merge_params,
    merge_surface_into_context,
    merge_surfaces_into_context,
    normalize_surface_row,
    normalize_surface_status,
    parse_location,
    path_from_location_blob,
    project_surface_upsert_event,
    resolve_booking_location,
    resolve_upsert_status,
    status_rank,
    surface_ledger_for_snapshot,
    surface_row_key,
    surfaces_do_not_cross_cases,
    surfaces_from_import_package,
    upsert_into_ledger,
)


def _row(**overrides):
    base = {
        "origin_key": "https://example.com:443",
        "path_key": "/api/users",
        "location": "https://example.com/api/users",
        "kind": "url",
        "methods": ["GET"],
        "params": ["id"],
        "status": "seen",
        "conversation_id": "conv-a",
        "source": "agent",
    }
    base.update(overrides)
    return base


class TestSurfaceIdentityPure(unittest.TestCase):
    def test_parse_location_https_defaults_and_path(self):
        p = parse_location("https://Host.Docker.Internal:3000/api/Users?x=1")
        self.assertTrue(p["ok"])
        self.assertEqual(p["origin_key"], "https://host.docker.internal:3000")
        self.assertEqual(p["path_key"], "/api/users")
        self.assertEqual(p["kind"], "url")
        self.assertEqual(
            surface_row_key(p["origin_key"], p["path_key"]),
            "https://host.docker.internal:3000/api/users",
        )

    def test_parse_location_default_ports(self):
        p = parse_location("https://h")
        self.assertTrue(p["ok"])
        self.assertEqual(p["origin_key"], "https://h:443")
        self.assertEqual(p["path_key"], "/")

        p2 = parse_location("http://example.com/a/b/")
        self.assertTrue(p2["ok"])
        self.assertEqual(p2["origin_key"], "http://example.com:80")
        self.assertEqual(p2["path_key"], "/a/b")

    def test_parse_location_non_http(self):
        p = parse_location("ssh://1.1.1.1:22")
        self.assertTrue(p["ok"])
        self.assertEqual(p["origin_key"], "ssh://1.1.1.1:22")
        self.assertEqual(p["path_key"], "")
        self.assertEqual(p["kind"], "ssh")
        self.assertEqual(surface_row_key(p["origin_key"], p["path_key"]), "ssh://1.1.1.1:22")

        p2 = parse_location("ssh://1.1.1.1")
        self.assertTrue(p2["ok"])
        self.assertEqual(p2["origin_key"], "ssh://1.1.1.1:22")

        p3 = parse_location("redis://10.0.0.1:6379")
        self.assertTrue(p3["ok"])
        self.assertEqual(p3["origin_key"], "redis://10.0.0.1:6379")
        self.assertEqual(p3["path_key"], "")
        self.assertEqual(p3["kind"], "redis")

    def test_query_not_in_identity(self):
        a = parse_location("https://t:443/api?id=1#frag")
        b = parse_location("https://t/api?id=2")
        self.assertTrue(a["ok"] and b["ok"])
        self.assertEqual(a["origin_key"], b["origin_key"])
        self.assertEqual(a["path_key"], b["path_key"])

    def test_ipv6_bracket_form(self):
        p = parse_location("https://[2001:db8::1]/v1")
        self.assertTrue(p["ok"])
        self.assertEqual(p["origin_key"], "https://[2001:db8::1]:443")
        self.assertEqual(p["path_key"], "/v1")
        self.assertEqual(p["host"], "[2001:db8::1]")

    def test_parse_location_rejects(self):
        self.assertFalse(parse_location("")["ok"])
        self.assertFalse(parse_location("not-a-url")["ok"])
        self.assertFalse(parse_location("/relative/path")["ok"])

    def test_merge_methods_params(self):
        self.assertEqual(
            merge_methods(["get", "POST"], ["post", "PUT", ""]),
            ["GET", "POST", "PUT"],
        )
        self.assertEqual(merge_methods(None, ["get"]), ["GET"])
        self.assertEqual(merge_methods(["GET"], None), ["GET"])
        self.assertEqual(merge_methods(), [])

        self.assertEqual(
            merge_params(["id", "name"], ["name", "token", ""]),
            ["id", "name", "token"],
        )
        self.assertEqual(merge_params(["a"], ["b", "a"]), ["a", "b"])
        self.assertEqual(merge_params(None, None), [])


class TestSurfaceStatusMachine(unittest.TestCase):
    """#379 — v2 seen|touched|booked + legacy map; never downgrade; no upsert booked."""

    def test_accept_and_normalize(self):
        self.assertTrue(is_surface_status("open"))
        self.assertTrue(is_surface_status("seen"))
        self.assertTrue(is_surface_status("touched"))
        self.assertTrue(is_surface_status("booked"))
        self.assertFalse(is_surface_status("nope"))
        self.assertFalse(is_write_surface_status("open"))
        self.assertTrue(is_write_surface_status("seen"))
        self.assertFalse(is_write_surface_status("probed"))
        self.assertEqual(normalize_surface_status("open"), "seen")
        self.assertEqual(normalize_surface_status("in_probe"), "touched")
        self.assertEqual(normalize_surface_status("probed"), "touched")
        self.assertEqual(normalize_surface_status("booked"), "booked")
        self.assertEqual(normalize_surface_status("deadend"), "deadend")
        self.assertEqual(normalize_surface_status("skipped_roe"), "skipped_roe")
        self.assertEqual(LEGACY_STATUS_MAP["open"], "seen")
        self.assertEqual(LEGACY_STATUS_MAP["probed"], "touched")
        self.assertEqual(normalize_surface_status("  Open "), "seen")
        self.assertIsNone(normalize_surface_status("nope"))

    def test_ranks(self):
        self.assertGreater(status_rank("booked"), status_rank("touched"))
        self.assertGreater(status_rank("touched"), status_rank("seen"))
        self.assertEqual(status_rank("probed"), status_rank("touched"))
        self.assertEqual(status_rank("open"), status_rank("seen"))
        self.assertEqual(status_rank("in_probe"), status_rank("touched"))
        self.assertEqual(status_rank("deadend"), status_rank("touched"))

    def test_never_downgrade(self):
        self.assertEqual(resolve_upsert_status("probed", "open"), "touched")
        self.assertEqual(resolve_upsert_status("touched", "seen"), "touched")
        self.assertFalse(can_transition_status("probed", "open"))
        self.assertFalse(can_transition_status("touched", "seen"))
        adv = apply_status_advance("probed", "open")
        self.assertEqual(adv["status"], "touched")
        self.assertFalse(adv["changed"])

    def test_upsert_cannot_set_booked(self):
        self.assertEqual(resolve_upsert_status(None, "booked"), "seen")
        self.assertEqual(resolve_upsert_status("open", "booked"), "seen")
        self.assertEqual(resolve_upsert_status("seen", "booked"), "seen")
        self.assertEqual(resolve_upsert_status("probed", "booked"), "touched")
        self.assertFalse(can_transition_status("open", "booked"))
        self.assertFalse(can_transition_status("seen", "booked"))
        self.assertTrue(can_transition_status("open", "booked", allow_booked=True))
        self.assertTrue(can_transition_status("seen", "booked", allow_booked=True))
        via = apply_status_advance("open", "booked", allow_booked=True)
        self.assertEqual(via["status"], "booked")
        self.assertTrue(via["changed"])

    def test_forward_advances(self):
        self.assertEqual(resolve_upsert_status("seen", "touched"), "touched")
        self.assertEqual(resolve_upsert_status("open", "in_probe"), "touched")
        self.assertEqual(resolve_upsert_status("in_probe", "probed"), "touched")
        self.assertEqual(resolve_upsert_status(None, "in_probe"), "touched")
        self.assertEqual(resolve_upsert_status(None, "touched"), "touched")
        self.assertEqual(resolve_upsert_status(None, None), "seen")
        self.assertEqual(resolve_upsert_status("open", "deadend"), "seen")
        self.assertEqual(resolve_upsert_status("seen", "probed"), "touched")

    def test_no_lateral_terminals(self):
        self.assertFalse(can_transition_status("probed", "deadend"))
        self.assertFalse(can_transition_status("touched", "deadend"))
        self.assertFalse(can_transition_status("deadend", "probed"))
        self.assertFalse(can_transition_status("deadend", "touched"))
        self.assertFalse(can_transition_status("booked", "probed"))
        self.assertFalse(can_transition_status("booked", "touched"))
        self.assertFalse(can_transition_status("booked", "open"))
        self.assertFalse(can_transition_status("booked", "seen"))
        self.assertTrue(can_transition_status("deadend", "booked", allow_booked=True))
        self.assertFalse(can_transition_status("skipped_roe", "open"))

    def test_same_status_noop(self):
        self.assertTrue(can_transition_status("open", "open"))
        self.assertTrue(can_transition_status("seen", "seen"))
        same = apply_status_advance("in_probe", "in_probe")
        self.assertEqual(same["status"], "touched")
        self.assertFalse(same["changed"])
        same_v2 = apply_status_advance("touched", "touched")
        self.assertEqual(same_v2["status"], "touched")
        self.assertFalse(same_v2["changed"])


class TestSurfaceLedgerStore(unittest.TestCase):
    def test_empty_ledger_valid(self):
        led = empty_ledger()
        self.assertEqual(led["version"], 2)
        self.assertEqual(led["surfaces"], [])
        panel = surface_ledger_for_snapshot({})
        self.assertEqual(panel["surfaces"], [])
        self.assertEqual(panel["version"], 2)

    def test_normalize_from_location(self):
        row = normalize_surface_row(
            {
                "location": "https://Example.COM/api/Users?x=1",
                "methods": ["get"],
                "params": ["id"],
                "status": "open",  # legacy accepted; write normalizes to seen
            },
            conversation_id="conv-a",
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["origin_key"], "https://example.com:443")
        self.assertEqual(row["path_key"], "/api/users")
        self.assertEqual(row["methods"], ["GET"])
        self.assertEqual(row["status"], "seen")

    def test_normalize_rejects_booked_on_ordinary_upsert(self):
        row = normalize_surface_row(
            {
                "origin_key": "https://h:443",
                "path_key": "/x",
                "status": "booked",
            },
            conversation_id="conv-a",
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["status"], "seen")

    def test_normalize_preserves_case_tested_from_dual_write(self):
        """Spec #413: Node surface_upsert may still carry case_tested as audit (not TESTED chip)."""
        row = normalize_surface_row(
            _row(status="touched", case_tested=True, source="traffic"),
            conversation_id="conv-a",
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertTrue(row["case_tested"])

        missing = normalize_surface_row(_row(status="touched"), conversation_id="conv-a")
        assert missing is not None
        self.assertFalse(missing["case_tested"], "missing case_tested is false-safe")

        # extract + merge path (same as WS surface_upsert) must land sticky true
        extracted = extract_surfaces_from_upsert_message(
            {
                "conversation_id": "conv-a",
                "surfaces": [
                    {
                        "origin_key": "https://example.com:443",
                        "path_key": "/api/users",
                        "location": "https://example.com/api/users",
                        "status": "touched",
                        "methods": ["GET"],
                        "case_tested": True,
                        "source": "traffic",
                    }
                ],
            },
            conversation_id="conv-a",
        )
        self.assertEqual(len(extracted), 1)
        self.assertTrue(extracted[0]["case_tested"])
        ctx, landed = merge_surfaces_into_context({}, extracted, allow_booked=False)
        self.assertEqual(len(landed), 1)
        self.assertTrue(landed[0]["case_tested"])
        self.assertTrue(ctx["surface_ledger"]["surfaces"][0]["case_tested"])

        # Later dual-write without case_tested must not clear sticky true
        later = extract_surfaces_from_upsert_message(
            {
                "conversation_id": "conv-a",
                "surfaces": [
                    {
                        "origin_key": "https://example.com:443",
                        "path_key": "/api/users",
                        "location": "https://example.com/api/users",
                        "status": "touched",
                        "methods": ["POST"],
                        "case_tested": False,
                    }
                ],
            },
            conversation_id="conv-a",
        )
        ctx2, landed2 = merge_surfaces_into_context(ctx, later, allow_booked=False)
        self.assertTrue(ctx2["surface_ledger"]["surfaces"][0]["case_tested"])
        self.assertTrue(landed2[0]["case_tested"])

    def test_coverage_work_state_from_mark_dual_write(self):
        """Spec #518: coverage is Agent-maintained; unmark must not be sticky-OR."""
        marked = extract_surfaces_from_upsert_message(
            {
                "conversation_id": "conv-a",
                "surfaces": [
                    {
                        "origin_key": "https://example.com:443",
                        "path_key": "/login",
                        "location": "https://example.com/login",
                        "status": "seen",
                        "coverage": "tested",
                        "coverage_marked_by": "pentest",
                    }
                ],
            },
            conversation_id="conv-a",
        )
        ctx, landed = merge_surfaces_into_context({}, marked, allow_booked=False)
        self.assertEqual(landed[0]["coverage"], "tested")
        self.assertEqual(ctx["surface_ledger"]["surfaces"][0]["coverage"], "tested")

        unmarked = extract_surfaces_from_upsert_message(
            {
                "conversation_id": "conv-a",
                "surfaces": [
                    {
                        "origin_key": "https://example.com:443",
                        "path_key": "/login",
                        "location": "https://example.com/login",
                        "status": "seen",
                        "coverage": "untested",
                    }
                ],
            },
            conversation_id="conv-a",
        )
        ctx2, landed2 = merge_surfaces_into_context(ctx, unmarked, allow_booked=False)
        self.assertEqual(landed2[0]["coverage"], "untested")
        self.assertEqual(ctx2["surface_ledger"]["surfaces"][0]["coverage"], "untested")

        traffic = extract_surfaces_from_upsert_message(
            {
                "conversation_id": "conv-a",
                "surfaces": [
                    {
                        "origin_key": "https://example.com:443",
                        "path_key": "/login",
                        "location": "https://example.com/login",
                        "status": "touched",
                        "source": "traffic",
                    }
                ],
            },
            conversation_id="conv-a",
        )
        # Traffic omit coverage → keep existing work-state.
        ctx3, _ = merge_surfaces_into_context(ctx, traffic, allow_booked=False)
        self.assertEqual(ctx3["surface_ledger"]["surfaces"][0]["coverage"], "tested")

    def test_legacy_deadend_status_maps_to_skipped_coverage(self):
        row = normalize_surface_row(
            _row(status="deadend"),
            conversation_id="conv-a",
        )
        assert row is not None
        self.assertEqual(row["coverage"], "skipped")
        self.assertEqual(row["coverage_skip_reason"], "deadend")
        self.assertEqual(row["status"], "touched")

        roe = normalize_surface_row(
            _row(status="skipped_roe"),
            conversation_id="conv-a",
        )
        assert roe is not None
        self.assertEqual(roe["coverage"], "skipped")
        self.assertEqual(roe["coverage_skip_reason"], "roe")
        self.assertEqual(roe["status"], "touched")

    def test_identity_merge_methods_params_no_duplicate_rows(self):
        a = normalize_surface_row(
            _row(methods=["GET"], params=["id"], status="open"),
            conversation_id="conv-a",
        )
        b = normalize_surface_row(
            _row(methods=["POST"], params=["token"], status="in_probe"),
            conversation_id="conv-a",
        )
        assert a and b
        ledger = upsert_into_ledger({}, a)
        ledger = upsert_into_ledger(ledger, b)
        self.assertEqual(len(ledger["surfaces"]), 1)
        row = ledger["surfaces"][0]
        self.assertEqual(row["methods"], ["GET", "POST"])
        self.assertEqual(row["params"], ["id", "token"])
        self.assertEqual(row["status"], "touched")

    def test_never_downgrade_on_reupsert(self):
        a = normalize_surface_row(_row(status="probed"), conversation_id="conv-a")
        b = normalize_surface_row(_row(status="open", methods=["PUT"]), conversation_id="conv-a")
        assert a and b
        ledger = upsert_into_ledger({}, a)
        ledger = upsert_into_ledger(ledger, b)
        row = ledger["surfaces"][0]
        self.assertEqual(row["status"], "touched")
        self.assertEqual(row["methods"], ["GET", "PUT"])

    def test_upsert_cannot_set_booked_on_merge(self):
        a = normalize_surface_row(_row(status="open"), conversation_id="conv-a")
        assert a
        self.assertEqual(a["status"], "seen")
        ledger = upsert_into_ledger({}, a)
        # Even if a raw row sneaks in with booked, ordinary merge refuses.
        sneaky = dict(a)
        sneaky["status"] = "booked"
        ledger = upsert_into_ledger(ledger, sneaky, allow_booked=False)
        self.assertEqual(ledger["surfaces"][0]["status"], "seen")

    def test_no_cross_case_leak(self):
        led_a = empty_ledger()
        led_b = empty_ledger()
        row = normalize_surface_row(_row(conversation_id="conv-a"), conversation_id="conv-a")
        assert row
        next_a, next_b = surfaces_do_not_cross_cases(led_a, led_b, row)
        self.assertEqual(len(next_a["surfaces"]), 1)
        self.assertEqual(len(next_b["surfaces"]), 0)
        # Snapshot of B stays empty even if conversation_id filter applied.
        ctx_b = {"surface_ledger": next_b}
        panel_b = surface_ledger_for_snapshot(ctx_b, conversation_id="conv-b")
        self.assertEqual(panel_b["surfaces"], [])

    def test_context_merge_and_snapshot(self):
        row = normalize_surface_row(_row(), conversation_id="conv-a")
        assert row
        ctx = merge_surface_into_context({}, row)
        self.assertIn("surface_ledger", ctx)
        self.assertEqual(len(ctx["surface_ledger"]["surfaces"]), 1)
        panel = surface_ledger_for_snapshot(ctx, conversation_id="conv-a")
        self.assertEqual(panel["version"], 2)
        self.assertEqual(len(panel["surfaces"]), 1)
        self.assertEqual(panel["surfaces"][0]["path_key"], "/api/users")

    def test_snapshot_filters_foreign_conversation_id_on_rows(self):
        row_a = normalize_surface_row(_row(conversation_id="conv-a"), conversation_id="conv-a")
        row_b = normalize_surface_row(
            _row(
                conversation_id="conv-b",
                path_key="/other",
                location="https://example.com/other",
            ),
            conversation_id="conv-b",
        )
        assert row_a and row_b
        # Manually put both in one context (would not happen if Case-scoped correctly).
        ledger = upsert_into_ledger({}, row_a)
        ledger = upsert_into_ledger(ledger, row_b)
        panel = surface_ledger_for_snapshot(
            {"surface_ledger": ledger},
            conversation_id="conv-a",
        )
        self.assertEqual(len(panel["surfaces"]), 1)
        self.assertEqual(panel["surfaces"][0]["path_key"], "/api/users")

    def test_extract_upsert_message_batch_and_project_event(self):
        msg = {
            "type": "surface_upsert",
            "conversation_id": "conv-a",
            "surfaces": [
                {
                    "location": "https://example.com/a",
                    "methods": ["GET"],
                    "status": "open",  # legacy → seen
                },
                {
                    "origin_key": "https://example.com:443",
                    "path_key": "/b",
                    "methods": ["POST"],
                    "status": "in_probe",  # legacy → touched
                },
            ],
        }
        rows = extract_surfaces_from_upsert_message(msg)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["status"], "seen")
        self.assertEqual(rows[1]["status"], "touched")
        ctx, landed = merge_surfaces_into_context({}, rows)
        self.assertEqual(len(landed), 2)
        self.assertEqual(len(ctx["surface_ledger"]["surfaces"]), 2)
        event = project_surface_upsert_event(
            conversation_id="conv-a",
            surfaces=landed,
            updated_at=ctx["surface_ledger"]["updated_at"],
        )
        self.assertEqual(event["type"], "surface_upsert")
        self.assertEqual(event["conversation_id"], "conv-a")
        self.assertEqual(len(event["surfaces"]), 2)

    def test_hard_cap_rejects_new_identity(self):
        ledger = empty_ledger()
        for i in range(3):
            row = normalize_surface_row(
                _row(
                    path_key=f"/p{i}",
                    location=f"https://example.com/p{i}",
                    conversation_id="conv-a",
                ),
                conversation_id="conv-a",
            )
            assert row
            ledger = upsert_into_ledger(ledger, row, row_cap=3)
        self.assertEqual(len(ledger["surfaces"]), 3)
        extra = normalize_surface_row(
            _row(path_key="/p99", location="https://example.com/p99"),
            conversation_id="conv-a",
        )
        assert extra
        ledger2 = upsert_into_ledger(ledger, extra, row_cap=3)
        self.assertEqual(len(ledger2["surfaces"]), 3)
        # Existing identity still merges under cap.
        existing = normalize_surface_row(
            _row(path_key="/p0", location="https://example.com/p0", methods=["HEAD"]),
            conversation_id="conv-a",
        )
        assert existing
        ledger3 = upsert_into_ledger(ledger2, existing, row_cap=3)
        row0 = next(s for s in ledger3["surfaces"] if s["path_key"] == "/p0")
        self.assertIn("HEAD", row0["methods"])


class TestFindingBookedSideEffect(unittest.TestCase):
    """Spec #368 S5 / #376 — finding confirm → surface booked side-effect."""

    def test_match_advances_existing_to_booked(self):
        row = normalize_surface_row(
            _row(status="in_probe", methods=["GET"]),
            conversation_id="conv-a",
        )
        assert row
        self.assertEqual(row["status"], "touched")
        ctx = merge_surface_into_context({}, row)
        result = apply_booked_side_effect(
            ctx,
            "https://example.com/api/users?id=9",
            conversation_id="conv-a",
        )
        self.assertEqual(result["action"], "advanced")
        self.assertIsNotNone(result["landed"])
        self.assertEqual(result["landed"]["status"], "booked")
        surfaces = result["context"]["surface_ledger"]["surfaces"]
        self.assertEqual(len(surfaces), 1)
        self.assertEqual(surfaces[0]["status"], "booked")
        # Identity + attrs preserved
        self.assertEqual(surfaces[0]["path_key"], "/api/users")
        self.assertEqual(surfaces[0]["methods"], ["GET"])

    def test_match_from_probed_and_deadend(self):
        for prior in ("open", "seen", "probed", "touched", "deadend", "skipped_roe"):
            row = normalize_surface_row(
                _row(status=prior, path_key="/x", location="https://example.com/x"),
                conversation_id="conv-a",
            )
            assert row
            ctx = merge_surface_into_context({}, row)
            result = apply_booked_side_effect(
                ctx,
                "https://example.com/x",
                conversation_id="conv-a",
            )
            self.assertEqual(result["action"], "advanced", prior)
            self.assertEqual(result["landed"]["status"], "booked", prior)

    def test_already_booked_is_noop_identity(self):
        row = normalize_surface_row(
            _row(status="open"),
            conversation_id="conv-a",
            allow_booked=False,
        )
        assert row
        ctx = merge_surface_into_context({}, row)
        # Force booked via side-effect once
        first = apply_booked_side_effect(
            ctx,
            "https://example.com/api/users",
            conversation_id="conv-a",
        )
        self.assertEqual(first["action"], "advanced")
        second = apply_booked_side_effect(
            first["context"],
            "https://example.com/api/users",
            conversation_id="conv-a",
        )
        self.assertEqual(second["action"], "already_booked")
        self.assertEqual(second["landed"]["status"], "booked")
        self.assertEqual(len(second["context"]["surface_ledger"]["surfaces"]), 1)

    def test_create_when_none_source_finding(self):
        result = apply_booked_side_effect(
            {},
            "https://example.com/vuln/sqli",
            conversation_id="conv-a",
        )
        self.assertEqual(result["action"], "created")
        self.assertIsNotNone(result["landed"])
        landed = result["landed"]
        self.assertEqual(landed["status"], "booked")
        self.assertEqual(landed["source"], "finding")
        self.assertEqual(landed["origin_key"], "https://example.com:443")
        self.assertEqual(landed["path_key"], "/vuln/sqli")
        panel = surface_ledger_for_snapshot(
            result["context"],
            conversation_id="conv-a",
        )
        self.assertEqual(len(panel["surfaces"]), 1)
        self.assertEqual(panel["surfaces"][0]["status"], "booked")

    def test_create_non_http_ssh(self):
        result = apply_booked_side_effect(
            {},
            "ssh://10.0.0.5:22",
            conversation_id="conv-a",
        )
        self.assertEqual(result["action"], "created")
        self.assertEqual(result["landed"]["origin_key"], "ssh://10.0.0.5:22")
        self.assertEqual(result["landed"]["path_key"], "")
        self.assertEqual(result["landed"]["status"], "booked")
        self.assertEqual(result["landed"]["source"], "finding")
        self.assertEqual(result["landed"]["kind"], "ssh")

    def test_cap_skip_does_not_mutate_ledger(self):
        ledger = empty_ledger()
        for i in range(3):
            row = normalize_surface_row(
                _row(
                    path_key=f"/p{i}",
                    location=f"https://example.com/p{i}",
                ),
                conversation_id="conv-a",
            )
            assert row
            ledger = upsert_into_ledger(ledger, row, row_cap=3)
        ctx = {"surface_ledger": ledger}
        result = apply_booked_side_effect(
            ctx,
            "https://example.com/brand-new",
            conversation_id="conv-a",
            row_cap=3,
        )
        self.assertEqual(result["action"], "cap_skip")
        self.assertIsNone(result["landed"])
        self.assertIsNotNone(result["warning"])
        # Ledger unchanged — still 3 open rows, no new identity
        surfaces = result["context"]["surface_ledger"]["surfaces"]
        self.assertEqual(len(surfaces), 3)
        self.assertTrue(all(s["status"] != "booked" for s in surfaces))
        keys = {(s["origin_key"], s["path_key"]) for s in surfaces}
        self.assertNotIn(("https://example.com:443", "/brand-new"), keys)

    def test_cap_does_not_block_advance_of_existing(self):
        ledger = empty_ledger()
        for i in range(3):
            row = normalize_surface_row(
                _row(
                    path_key=f"/p{i}",
                    location=f"https://example.com/p{i}",
                    status="seen",
                ),
                conversation_id="conv-a",
            )
            assert row
            ledger = upsert_into_ledger(ledger, row, row_cap=3)
        ctx = {"surface_ledger": ledger}
        result = apply_booked_side_effect(
            ctx,
            "https://example.com/p1",
            conversation_id="conv-a",
            row_cap=3,
        )
        self.assertEqual(result["action"], "advanced")
        self.assertEqual(result["landed"]["status"], "booked")
        self.assertEqual(len(result["context"]["surface_ledger"]["surfaces"]), 3)

    def test_ordinary_upsert_still_cannot_set_booked(self):
        # Regression: side-effect path is separate; ordinary merge still refuses booked.
        row = normalize_surface_row(
            _row(status="open"),
            conversation_id="conv-a",
        )
        assert row
        ledger = upsert_into_ledger({}, row)
        sneaky = dict(row)
        sneaky["status"] = "booked"
        ledger2 = upsert_into_ledger(ledger, sneaky, allow_booked=False)
        self.assertEqual(ledger2["surfaces"][0]["status"], "seen")

    def test_unparseable_location_soft(self):
        result = apply_booked_side_effect(
            {},
            "/relative/only",
            conversation_id="conv-a",
        )
        self.assertEqual(result["action"], "unparseable")
        self.assertIsNone(result["landed"])
        self.assertEqual(result["context"].get("surface_ledger"), None)

    def test_put_method_path_with_host_port_location_key_creates(self):
        """#382 field bug: PUT /api/... without scheme must create-on-book with host+port+key."""
        result = apply_booked_side_effect(
            {},
            "PUT /api/Products/{id} (IDOR update)",
            conversation_id="conv-a",
            host="host.docker.internal",
            port=3000,
            location_key="/api/products/{id}",
        )
        self.assertEqual(result["action"], "created")
        self.assertIsNotNone(result["landed"])
        landed = result["landed"]
        self.assertEqual(landed["status"], "booked")
        self.assertEqual(landed["source"], "finding")
        self.assertEqual(landed["origin_key"], "http://host.docker.internal:3000")
        self.assertEqual(landed["path_key"], "/api/products/{id}")
        self.assertIn("host.docker.internal", landed["location"])
        self.assertIn("/api/products/{id}", landed["location"].lower())

    def test_put_method_path_extracts_path_when_location_key_absent(self):
        result = apply_booked_side_effect(
            {},
            "PUT /api/Products/42",
            conversation_id="conv-a",
            host="10.0.0.5",
            port="8080",
        )
        self.assertEqual(result["action"], "created")
        self.assertEqual(result["landed"]["origin_key"], "http://10.0.0.5:8080")
        self.assertEqual(result["landed"]["path_key"], "/api/products/42")
        self.assertEqual(result["landed"]["status"], "booked")

    def test_host_port_location_key_advances_existing(self):
        row = normalize_surface_row(
            _row(
                origin_key="http://app.local:3000",
                path_key="/api/products/{id}",
                location="http://app.local:3000/api/Products/{id}",
                status="touched",
            ),
            conversation_id="conv-a",
        )
        assert row
        ctx = merge_surface_into_context({}, row)
        result = apply_booked_side_effect(
            ctx,
            "PUT /api/Products/{id}",
            conversation_id="conv-a",
            host="app.local",
            port=3000,
            location_key="/api/Products/{id}",
        )
        self.assertEqual(result["action"], "advanced")
        self.assertEqual(result["landed"]["status"], "booked")
        self.assertEqual(len(result["context"]["surface_ledger"]["surfaces"]), 1)

    def test_proof_url_resolves_when_location_scheme_less(self):
        result = apply_booked_side_effect(
            {},
            "PUT /api/Orders/1",
            conversation_id="conv-a",
            proof="Request: PUT http://juice:3000/api/Orders/1\nStatus 200",
        )
        self.assertEqual(result["action"], "created")
        self.assertEqual(result["landed"]["origin_key"], "http://juice:3000")
        self.assertEqual(result["landed"]["path_key"], "/api/orders/1")

    def test_unresolvable_without_host_still_soft(self):
        result = apply_booked_side_effect(
            {},
            "PUT /api/Products/{id}",
            conversation_id="conv-a",
        )
        self.assertEqual(result["action"], "unparseable")
        self.assertIsNone(result["landed"])


class TestResolveBookingLocation(unittest.TestCase):
    """Spec #382 D7 resolve order pure tests."""

    def test_absolute_url_first(self):
        r = resolve_booking_location(
            "https://example.com/a",
            host="other",
            port=9,
            location_key="/nope",
        )
        self.assertTrue(r["ok"])
        self.assertEqual(r["origin_key"], "https://example.com:443")
        self.assertEqual(r["path_key"], "/a")

    def test_path_from_put_blob(self):
        self.assertEqual(
            path_from_location_blob("PUT /api/Products/{id} (note)"),
            "/api/products/{id}",
        )
        self.assertEqual(
            compose_http_location("h.local", 3000, "/api/x"),
            "http://h.local:3000/api/x",
        )

    def test_host_port_key_compose(self):
        r = resolve_booking_location(
            "not a url",
            host="h.local",
            port=443,
            location_key="/secure",
        )
        self.assertTrue(r["ok"])
        self.assertEqual(r["origin_key"], "https://h.local:443")
        self.assertEqual(r["path_key"], "/secure")


class TestSurfaceImportMergeS7(unittest.TestCase):
    """Spec #368 D13 / #377 S7 — package surface_ledger merge by identity into Case."""

    def test_map_legacy_attack_surface_url_method_parameters(self):
        mapped = map_legacy_attack_surface_item(
            {
                "surface_id": "as-1",
                "kind": "url",
                "url": "http://192.0.2.1/login",
                "method": "GET",
                "parameters": ["user", "pass"],
                "status": "probed",
            }
        )
        self.assertIsNotNone(mapped)
        assert mapped is not None
        self.assertEqual(mapped["location"], "http://192.0.2.1/login")
        self.assertEqual(mapped["methods"], ["GET"])
        self.assertEqual(mapped["params"], ["user", "pass"])
        self.assertEqual(mapped["id"], "as-1")
        # map_legacy passes status through; normalize_surface_row maps probed→touched.
        self.assertEqual(mapped["status"], "probed")
        self.assertEqual(mapped["source"], "import")
        normalized = normalize_surface_row(mapped, conversation_id="conv-import")
        assert normalized is not None
        self.assertEqual(normalized["status"], "touched")

    def test_map_legacy_skips_unusable_surface_id_only(self):
        self.assertIsNone(map_legacy_attack_surface_item({"surface_id": "surface-1"}))
        self.assertIsNone(map_legacy_attack_surface_item({"kind": "url"}))

    def test_import_accepts_surface_ledger_document(self):
        package_ledger = {
            "version": 1,
            "updated_at": "2026-08-10T00:00:00+00:00",
            "surfaces": [
                {
                    "origin_key": "https://example.com:443",
                    "path_key": "/api/users",
                    "location": "https://example.com/api/users",
                    "methods": ["GET"],
                    "params": ["id"],
                    "status": "open",
                },
                {
                    "location": "ssh://1.1.1.1:22",
                    "status": "probed",
                },
            ],
        }
        rows = surfaces_from_import_package(
            conversation_id="conv-import",
            surface_ledger=package_ledger,
        )
        self.assertEqual(len(rows), 2)
        keys = {surface_row_key(r["origin_key"], r.get("path_key") or "") for r in rows}
        self.assertIn("https://example.com:443/api/users", keys)
        self.assertIn("ssh://1.1.1.1:22", keys)
        self.assertTrue(all(r.get("source") == "import" for r in rows))
        by_key = {
            surface_row_key(r["origin_key"], r.get("path_key") or ""): r for r in rows
        }
        self.assertEqual(by_key["https://example.com:443/api/users"]["status"], "seen")
        self.assertEqual(by_key["ssh://1.1.1.1:22"]["status"], "touched")

    def test_import_maps_legacy_attack_surface_list(self):
        legacy = [
            {
                "surface_id": "as-1",
                "kind": "url",
                "url": "https://Example.COM/api/Users?x=1",
                "method": "get",
                "parameters": ["id"],
            },
            {
                "surface_id": "as-2",
                "kind": "url",
                "url": "https://example.com/api/users",
                "method": "POST",
                "parameters": ["token"],
            },
            {"surface_id": "orphan-no-url"},
        ]
        rows = surfaces_from_import_package(
            conversation_id="conv-import",
            attack_surface=legacy,
        )
        # Same identity after normalize → one row; methods/params union.
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["origin_key"], "https://example.com:443")
        self.assertEqual(rows[0]["path_key"], "/api/users")
        self.assertEqual(rows[0]["methods"], ["GET", "POST"])
        self.assertEqual(rows[0]["params"], ["id", "token"])

    def test_import_merge_into_context_and_snapshot_project(self):
        package_ledger = {
            "version": 1,
            "surfaces": [
                {
                    "location": "https://target.local/admin",
                    "methods": ["GET"],
                    "status": "in_probe",
                }
            ],
        }
        ctx, landed = merge_import_package_into_context(
            {},
            conversation_id="conv-import",
            surface_ledger=package_ledger,
        )
        self.assertEqual(len(landed), 1)
        self.assertIn("surface_ledger", ctx)
        self.assertEqual(len(ctx["surface_ledger"]["surfaces"]), 1)
        panel = surface_ledger_for_snapshot(ctx, conversation_id="conv-import")
        self.assertEqual(len(panel["surfaces"]), 1)
        self.assertEqual(panel["surfaces"][0]["path_key"], "/admin")
        self.assertEqual(panel["surfaces"][0]["status"], "touched")

    def test_second_import_merges_without_duplicate_identities(self):
        first = {
            "surfaces": [
                {
                    "location": "https://example.com/a",
                    "methods": ["GET"],
                    "params": ["id"],
                    "status": "open",
                }
            ]
        }
        second = {
            "surfaces": [
                {
                    "location": "https://example.com/a?x=2",
                    "methods": ["POST"],
                    "params": ["token"],
                    "status": "probed",
                },
                {
                    "location": "https://example.com/b",
                    "methods": ["GET"],
                    "status": "open",
                },
            ]
        }
        ctx, landed1 = merge_import_package_into_context(
            {},
            conversation_id="conv-import",
            surface_ledger=first,
        )
        self.assertEqual(len(landed1), 1)
        ctx, landed2 = merge_import_package_into_context(
            ctx,
            conversation_id="conv-import",
            surface_ledger=second,
        )
        # Second batch lands both identities (a merge + b create).
        self.assertEqual(len(landed2), 2)
        surfaces = ctx["surface_ledger"]["surfaces"]
        self.assertEqual(len(surfaces), 2)
        by_path = {s["path_key"]: s for s in surfaces}
        self.assertEqual(by_path["/a"]["methods"], ["GET", "POST"])
        self.assertEqual(by_path["/a"]["params"], ["id", "token"])
        self.assertEqual(by_path["/a"]["status"], "touched")  # probed→touched; never downgrade
        self.assertEqual(by_path["/b"]["status"], "seen")

    def test_import_preserves_booked_status_from_package(self):
        rows = surfaces_from_import_package(
            conversation_id="conv-import",
            surface_ledger={
                "surfaces": [
                    {
                        "location": "https://example.com/vuln",
                        "status": "booked",
                        "source": "finding",
                    }
                ]
            },
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "booked")
        self.assertEqual(rows[0]["source"], "finding")

    def test_attack_surface_json_ledger_shaped_accepted(self):
        # attack_surface.json may itself carry the ledger document.
        ledger_shaped = {
            "version": 1,
            "surfaces": [
                {
                    "origin_key": "https://h:443",
                    "path_key": "/x",
                    "methods": ["GET"],
                    "status": "open",
                }
            ],
        }
        ctx, landed = merge_import_package_into_context(
            {},
            conversation_id="conv-import",
            attack_surface=ledger_shaped,
        )
        self.assertEqual(len(landed), 1)
        self.assertEqual(ctx["surface_ledger"]["surfaces"][0]["path_key"], "/x")


if __name__ == "__main__":
    unittest.main()
