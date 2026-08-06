"""Spec #299 / map #242 batch-2: preferred seat offline never falls through."""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.ws import router as ws_router


class TestPickOnlineNodeIdSeatStrict(unittest.IsolatedAsyncioTestCase):
    """Seam A: preferred / explicit seat is live-socket-or-fail."""

    async def test_preferred_online_returns_preferred(self):
        fake_ws = object()
        caps = [
            SimpleNamespace(node_id="other", online=True, agent_type="pentest"),
            SimpleNamespace(node_id="preferred", online=True, agent_type="pentest"),
        ]
        with patch.object(ws_router, "node_connections", {"preferred": fake_ws, "other": fake_ws}):
            got = await ws_router._pick_online_node_id(
                preferred="preferred",
                bound="other",
                capabilities=caps,
            )
        self.assertEqual(got, "preferred")

    async def test_preferred_offline_does_not_fallthrough_to_other_online(self):
        fake_ws = object()
        caps = [
            SimpleNamespace(node_id="other-online", online=True, agent_type="pentest"),
            SimpleNamespace(node_id="preferred-offline", online=False, agent_type="pentest"),
        ]
        with patch.object(ws_router, "node_connections", {"other-online": fake_ws}):
            got = await ws_router._pick_online_node_id(
                preferred="preferred-offline",
                bound=None,
                capabilities=caps,
            )
        self.assertIsNone(got)

    async def test_preferred_offline_does_not_use_bound_online(self):
        """Explicit preferred seat wins over conversation bound; no substitute."""
        fake_ws = object()
        caps = [
            SimpleNamespace(node_id="bound-online", online=True, agent_type="pentest"),
        ]
        with patch.object(ws_router, "node_connections", {"bound-online": fake_ws}):
            got = await ws_router._pick_online_node_id(
                preferred="preferred-offline",
                bound="bound-online",
                capabilities=caps,
            )
        self.assertIsNone(got)

    async def test_no_preferred_bound_online_may_use_bound(self):
        fake_ws = object()
        caps = [
            SimpleNamespace(node_id="bound", online=True, agent_type="pentest"),
            SimpleNamespace(node_id="worker", online=True, agent_type="pentest"),
        ]
        with patch.object(
            ws_router,
            "node_connections",
            {"bound": fake_ws, "worker": fake_ws},
        ):
            got = await ws_router._pick_online_node_id(
                preferred=None,
                bound="bound",
                capabilities=caps,
            )
        self.assertEqual(got, "bound")

    async def test_no_preferred_uses_online_worker_when_bound_offline(self):
        fake_ws = object()
        caps = [
            SimpleNamespace(node_id="bound-off", online=False, agent_type="pentest"),
            SimpleNamespace(node_id="worker", online=True, agent_type="pentest"),
        ]
        with patch.object(ws_router, "node_connections", {"worker": fake_ws}):
            got = await ws_router._pick_online_node_id(
                preferred=None,
                bound="bound-off",
                capabilities=caps,
            )
        self.assertEqual(got, "worker")

    async def test_empty_preferred_string_treated_as_unset(self):
        fake_ws = object()
        caps = [SimpleNamespace(node_id="worker", online=True, agent_type="pentest")]
        with patch.object(ws_router, "node_connections", {"worker": fake_ws}):
            got = await ws_router._pick_online_node_id(
                preferred="  ",
                bound=None,
                capabilities=caps,
            )
        self.assertEqual(got, "worker")


class TestDispatchSeatOfflineErrorCopy(unittest.TestCase):
    """Error text distinguishes preferred-offline from no-node-at-all."""

    def test_preferred_offline_message(self):
        msg = ws_router._dispatch_no_node_error_message(preferred="seat-a")
        self.assertIn("offline", msg.lower())
        self.assertNotIn("Start a Node runtime", msg)

    def test_no_preferred_message(self):
        msg = ws_router._dispatch_no_node_error_message(preferred=None)
        self.assertIn("No online Node", msg)


if __name__ == "__main__":
    unittest.main()
