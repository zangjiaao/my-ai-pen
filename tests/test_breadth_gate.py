"""Breadth-gate tests for loop convergence.

Guards that the loop reports unexplored breadth (unvisited in-scope links /
pending surface-expansion nodes) so recon/analysis do not advance prematurely,
and that the Goal Keeper prompt no longer tells the agent to stop early.
"""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.agent.loop import PentestAgentLoop  # noqa: E402
from pentest_node.agent.state import Phase  # noqa: E402


class _DummyPlatform:
    def __init__(self):
        self.events = []

    async def send(self, event):
        self.events.append(event)


def _loop():
    return PentestAgentLoop(
        task={
            "conversation_id": "c",
            "target": {"type": "url", "value": "http://target.local"},
            "resolved_target": "http://target.local",
            "scope": {"allow": ["http://target.local"], "deny": []},
        },
        tools=SimpleNamespace(list_tools=lambda: [], get=lambda name: None),
        sandbox=None,
        llm=None,
        platform_sync=_DummyPlatform(),
    )


class BreadthGateTest(unittest.TestCase):
    def test_fresh_loop_without_discovered_surface_has_no_breadth_debt(self):
        loop = _loop()
        # No discovered/seeded surface nodes yet -> nothing to hold on.
        self.assertFalse(loop._has_unexplored_breadth())

    def test_pending_surface_node_counts_as_unexplored(self):
        loop = _loop()
        self.assertFalse(loop._has_unexplored_breadth())
        loop.plan_tree.add_node(
            title="Explore url",
            kind="surface",
            target="http://target.local/vulnerabilities/csrf",
            endpoint="GET http://target.local/vulnerabilities/csrf",
        )
        self.assertTrue(loop._has_unexplored_breadth())

    def test_recon_holds_when_breadth_pending(self):
        loop = _loop()
        loop.plan_tree.add_node(
            title="Explore url",
            kind="surface",
            target="http://target.local/vulnerabilities/csrf",
            endpoint="GET http://target.local/vulnerabilities/csrf",
        )
        # Even if executable test nodes exist, an unexplored surface holds recon
        # (phase_iteration 0 is below the cap).
        for i in range(3):
            loop.plan_tree.add_node(
                title=f"Test sqli {i}",
                kind="test",
                target=f"http://target.local/x{i}?id=1",
                endpoint=f"GET http://target.local/x{i}",
                parameter="id",
                vuln_type="sqli",
            )
        loop.state.phase_iteration = 0
        self.assertEqual(loop._runtime_phase_advance_reason(Phase.RECON), "")

    def test_goal_keeper_prompt_no_longer_stops_early(self):
        loop = _loop()
        prompt = loop._goal_keeper_prompt(Phase.RECON)
        self.assertNotIn("stop low-yield observation once executable tests exist", prompt)
        self.assertIn("still unexplored", prompt)


if __name__ == "__main__":
    unittest.main()
