"""Unit tests for Node ledger policy + pure helpers (default seat tools)."""
from __future__ import annotations

import uuid
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.node_ledger import (
    asset_to_dict,
    deny_host_create_payload,
    normalize_finding_status,
    vuln_to_dict,
    NodeLedgerError,
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

    def test_ledger_shaped_asset_and_vuln_dicts(self):
        """asset_to_dict / vuln_to_dict return real ledger-shaped payloads (shipped serializers)."""
        aid = uuid.uuid4()
        asset = SimpleNamespace(
            id=aid,
            name="web",
            address="10.0.0.1",
            type="host",
            tags=["lab"],
            properties={"open_ports": ["80"], "services": [{"port": "80", "name": "http"}]},
            source="manual",
            conversation_id=None,
            created_at=None,
            updated_at=None,
        )
        out = asset_to_dict(asset)
        self.assertEqual(out["id"], str(aid))
        self.assertEqual(out["address"], "10.0.0.1")
        self.assertIn("services", out)
        self.assertTrue(any(s.get("port") == "80" for s in out["services"]))

        vid = uuid.uuid4()
        vuln = SimpleNamespace(
            id=vid,
            title="XSS",
            severity="high",
            status="to_fix",
            asset_id=aid,
            port="80",
            conversation_id=None,
            description="d",
            cve_id=None,
            cvss=None,
            discovered_at=None,
            updated_at=None,
        )
        vout = vuln_to_dict(vuln)
        self.assertEqual(vout["id"], str(vid))
        self.assertEqual(vout["title"], "XSS")
        self.assertEqual(vout["status_normalized"], "to_fix")
        self.assertEqual(vout["asset_id"], str(aid))

    def test_enrich_existing_asset_denies_host_create_and_requires_id(self):
        import asyncio
        from app.services import node_ledger as nl

        async def run_deny():
            db = MagicMock()
            with self.assertRaises(NodeLedgerError) as ctx:
                await nl.enrich_existing_asset(
                    db,
                    "",
                    user_id=None,
                    body={"create_host": True, "address": "evil.example"},
                )
            self.assertEqual(ctx.exception.status_code, 403)

        async def run_missing():
            db = MagicMock()
            # No matching asset
            result = MagicMock()
            result.scalar_one_or_none.return_value = None
            db.execute = AsyncMock(return_value=result)
            with self.assertRaises(NodeLedgerError) as ctx:
                await nl.enrich_existing_asset(
                    db,
                    str(uuid.uuid4()),
                    user_id=None,
                    body={"asset_id": str(uuid.uuid4()), "ports": [443]},
                )
            self.assertEqual(ctx.exception.status_code, 404)
            self.assertIn("only enrich", ctx.exception.message.lower() + " " + "users create")

        asyncio.run(run_deny())
        asyncio.run(run_missing())

    def test_update_finding_status_rejects_bad_status(self):
        import asyncio
        from app.services import node_ledger as nl

        async def run():
            db = MagicMock()
            with self.assertRaises(NodeLedgerError) as ctx:
                await nl.update_finding_status(
                    db, str(uuid.uuid4()), status="nope", user_id=None
                )
            self.assertEqual(ctx.exception.status_code, 400)

        asyncio.run(run())

    def test_default_seat_message_detection_and_strip(self):
        """role_pack=default + sticky expert must be recognized and stripped (criterion 4)."""
        from app.ws.router import (
            _is_default_seat_message,
            _strip_expert_fields,
            _pack_key_from_message,
        )

        self.assertEqual(_pack_key_from_message({"role_pack": "default"}), "default")
        self.assertTrue(
            _is_default_seat_message(
                {"type": "text", "role_pack": "default", "expert_id": "e-sticky"},
                sticky_engagement=None,
            )
        )
        self.assertTrue(
            _is_default_seat_message(
                {"type": "text", "content": {"text": "hi"}},
                sticky_engagement="default",
            )
        )
        self.assertFalse(
            _is_default_seat_message(
                {"type": "text", "role_pack": "pentest"},
                sticky_engagement=None,
            )
        )
        msg = {
            "expert_id": "e1",
            "expert_name": "渗透大师",
            "content": {"text": "你好", "expert_id": "e1", "expert_name": "渗透大师"},
        }
        _strip_expert_fields(msg)
        self.assertNotIn("expert_id", msg)
        self.assertNotIn("expert_name", msg)
        self.assertNotIn("expert_id", msg["content"])
        self.assertNotIn("expert_name", msg["content"])


if __name__ == "__main__":
    unittest.main()