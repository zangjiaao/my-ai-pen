"""Unit tests for Node ledger policy + pure helpers (default seat tools)."""
from __future__ import annotations

import unittest

from app.services.node_ledger import (
    deny_host_create_payload,
    normalize_finding_status,
)
from app.services.expert_offers import engagement_allowed, normalize_pack_id, dispatch_gate_error


class NodeLedgerPolicyTests(unittest.TestCase):
    def test_deny_host_create(self):
        self.assertIsNotNone(deny_host_create_payload({"create_host": True}))
        self.assertIsNotNone(deny_host_create_payload({"op": "create_asset"}))
        self.assertIsNone(deny_host_create_payload({"asset_id": "x", "ports": [80]}))
        self.assertIsNone(deny_host_create_payload(None))

    def test_normalize_finding_status(self):
        self.assertEqual(normalize_finding_status("to_fix"), "to_fix")
        self.assertEqual(normalize_finding_status("pending"), "to_fix")
        self.assertEqual(normalize_finding_status("fixing"), "fixing")
        self.assertEqual(normalize_finding_status("fixed"), "fixed")
        self.assertIsNone(normalize_finding_status("nope"))

    def test_default_seat_not_offers_gated(self):
        self.assertEqual(normalize_pack_id("default"), "default")
        self.assertEqual(normalize_pack_id("consult"), "default")
        self.assertTrue(engagement_allowed([], "default"))
        self.assertTrue(engagement_allowed([], "consult"))
        self.assertTrue(engagement_allowed([], ""))
        self.assertIsNone(dispatch_gate_error({"offers": []}, "default"))
        self.assertIsNone(dispatch_gate_error({"offers": []}, None))

    def test_is_default_participant_helper(self):
        from app.ws.router import _is_default_participant, _message_has_task_target

        self.assertTrue(_is_default_participant({"text": "你好"}))
        self.assertTrue(_is_default_participant({"text": "你好", "engagement": "default"}))
        self.assertTrue(_is_default_participant({"agent_target": "platform"}))
        self.assertFalse(
            _is_default_participant(
                {"text": "scan", "expert_id": "e1", "expert_name": "渗透", "engagement": "pentest"}
            )
        )
        self.assertFalse(_message_has_task_target({"text": "你好"}))
        self.assertTrue(_message_has_task_target({"text": "http://example.com"}))


if __name__ == "__main__":
    unittest.main()
