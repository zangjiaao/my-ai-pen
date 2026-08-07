"""Spec #309 S2 — Case-scoped traffic store/project + upsert by exchange_id."""
from __future__ import annotations

import unittest

from app.services.traffic_exchange import (
    exchanges_do_not_cross_cases,
    merge_traffic_into_context,
    normalize_traffic_exchange,
    project_exchange_detail,
    traffic_exchanges_for_panel,
    upsert_into_store,
)


def _pending(**overrides):
    base = {
        "type": "traffic_exchange",
        "exchange_id": "tx_http_1",
        "conversation_id": "conv-a",
        "sequence": 1,
        "source": "http",
        "phase": "pending",
        "method": "GET",
        "url": "https://example.com/api",
        "request_headers": {"accept": "application/json"},
        "request_body": None,
        "started_at": "2026-08-07T10:00:00+00:00",
    }
    base.update(overrides)
    return base


def _completed(**overrides):
    base = _pending(
        phase="completed",
        status_code=200,
        response_headers={"content-type": "application/json"},
        response_body='{"ok":true}',
        completed_at="2026-08-07T10:00:01+00:00",
        duration_ms=1000,
        response_body_truncated=False,
        response_body_bytes=11,
        response_body_hash="abc",
    )
    base.update(overrides)
    return base


class TestTrafficExchangeStore(unittest.TestCase):
    def test_normalize_requires_id_url_conversation(self):
        self.assertIsNone(normalize_traffic_exchange({"url": "https://x"}))
        self.assertIsNone(
            normalize_traffic_exchange(
                {"exchange_id": "e1", "conversation_id": "c", "url": ""}
            )
        )
        ok = normalize_traffic_exchange(_pending())
        self.assertIsNotNone(ok)
        self.assertEqual(ok["exchange_id"], "tx_http_1")
        self.assertEqual(ok["phase"], "pending")

    def test_pending_then_complete_same_id(self):
        store: dict = {}
        p = normalize_traffic_exchange(_pending())
        assert p is not None
        store = upsert_into_store(store, p)
        c = normalize_traffic_exchange(
            _completed(exchange_id="tx_http_1", conversation_id="conv-a")
        )
        assert c is not None
        store = upsert_into_store(store, c)
        self.assertEqual(len(store), 1)
        row = store["tx_http_1"]
        self.assertEqual(row["phase"], "completed")
        self.assertEqual(row["status_code"], 200)
        self.assertEqual(row["request_headers"]["accept"], "application/json")
        self.assertEqual(row["response_body"], '{"ok":true}')

    def test_snapshot_reload_returns_rows(self):
        ctx = merge_traffic_into_context({}, normalize_traffic_exchange(_completed()) or {})
        panel = traffic_exchanges_for_panel(ctx, conversation_id="conv-a")
        self.assertEqual(len(panel), 1)
        self.assertEqual(panel[0]["method"], "GET")
        self.assertEqual(panel[0]["url"], "https://example.com/api")

    def test_no_cross_case_leak(self):
        store_a: dict = {}
        store_b: dict = {}
        ex = normalize_traffic_exchange(_completed(conversation_id="conv-a")) or {}
        next_a, next_b = exchanges_do_not_cross_cases(store_a, store_b, ex)
        self.assertEqual(len(next_a), 1)
        self.assertEqual(len(next_b), 0)
        # Independent B context
        ctx_b = {"traffic_exchanges": next_b}
        self.assertEqual(traffic_exchanges_for_panel(ctx_b, conversation_id="conv-b"), [])

    def test_failed_terminal(self):
        store = upsert_into_store(
            {},
            normalize_traffic_exchange(_pending()) or {},
        )
        failed = normalize_traffic_exchange(
            _pending(phase="failed", error="timeout", completed_at="2026-08-07T10:00:05+00:00")
        )
        store = upsert_into_store(store, failed or {})
        self.assertEqual(store["tx_http_1"]["phase"], "failed")
        self.assertEqual(store["tx_http_1"]["error"], "timeout")

    def test_browser_row_stored_fuller_than_view(self):
        """Store keeps static browser rows (F2); N3 filter is not store-side."""
        static = normalize_traffic_exchange(
            _completed(
                exchange_id="tx_browser_css",
                source="browser",
                url="https://example.com/app.css",
                browser_resource_class="stylesheet",
            )
        )
        store = upsert_into_store({}, static or {})
        panel = traffic_exchanges_for_panel({"traffic_exchanges": store})
        self.assertEqual(len(panel), 1)
        self.assertEqual(panel[0]["browser_resource_class"], "stylesheet")

    def test_detail_pending_waiting_response(self):
        detail = project_exchange_detail(normalize_traffic_exchange(_pending()))
        self.assertIsNotNone(detail)
        self.assertTrue(detail["waiting_response"])
        self.assertIsNone(detail["response_body"])
        completed = project_exchange_detail(normalize_traffic_exchange(_completed()))
        self.assertFalse(completed["waiting_response"])
        self.assertEqual(completed["status_code"], 200)
        self.assertEqual(completed["response_body"], '{"ok":true}')

    def test_truncation_markers_in_detail(self):
        row = normalize_traffic_exchange(
            _completed(
                response_body="partial...",
                response_body_truncated=True,
                response_body_bytes=99999,
                response_body_hash="deadbeef",
            )
        )
        detail = project_exchange_detail(row)
        self.assertTrue(detail["response_body_truncated"])
        self.assertEqual(detail["response_body_bytes"], 99999)
        self.assertEqual(detail["response_body_hash"], "deadbeef")

    def test_invalid_source_rejected(self):
        """Fail-closed: do not coerce unknown source → http."""
        bad = normalize_traffic_exchange(_pending(source="shell"))
        self.assertIsNone(bad)
        bad2 = normalize_traffic_exchange(_pending(source="not-a-source"))
        self.assertIsNone(bad2)

    def test_invalid_phase_rejected(self):
        """Fail-closed: do not coerce unknown phase → pending."""
        bad = normalize_traffic_exchange(_pending(phase="running"))
        self.assertIsNone(bad)
        bad2 = normalize_traffic_exchange(_pending(phase="done"))
        self.assertIsNone(bad2)

    def test_omitted_source_phase_defaults(self):
        msg = {
            "exchange_id": "tx_1",
            "conversation_id": "conv-a",
            "url": "https://example.com/",
            "method": "GET",
        }
        ok = normalize_traffic_exchange(msg)
        self.assertIsNotNone(ok)
        self.assertEqual(ok["source"], "http")
        self.assertEqual(ok["phase"], "pending")

    def test_merge_terminal_not_clobbered_by_stale_pending(self):
        store = upsert_into_store({}, normalize_traffic_exchange(_completed()) or {})
        stale = normalize_traffic_exchange(
            _pending(exchange_id="tx_http_1", conversation_id="conv-a")
        )
        store = upsert_into_store(store, stale or {})
        row = store["tx_http_1"]
        self.assertEqual(row["phase"], "completed")
        self.assertEqual(row["status_code"], 200)
        self.assertEqual(row["response_body"], '{"ok":true}')


if __name__ == "__main__":
    unittest.main()
