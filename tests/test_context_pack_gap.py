"""Playbook hint breadth-gap tests.

Guards that discovered-but-untested attack surface is surfaced back to the model
so it is nudged to widen coverage instead of only replaying captured traffic.
"""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.agent.attack_surface import AttackSurfaceInventory  # noqa: E402
from pentest_node.agent.playbook_hints import build_playbook_hints  # noqa: E402
from pentest_node.agent.coverage import CoverageStore  # noqa: E402
from pentest_node.agent.plan_tree import ExplorationPlanTree  # noqa: E402


class _StubTraffic:
    def summary(self):
        return {}

    def rank_candidates(self, limit=8):
        return []


def _agent_loop():
    return SimpleNamespace(
        plan_tree=ExplorationPlanTree("c"),
        traffic_capture=_StubTraffic(),
        coverage=CoverageStore("c"),
        attack_surface=AttackSurfaceInventory("c"),
    )


class PlaybookHintsGapTest(unittest.TestCase):
    def test_untested_surface_listed_and_covered_hidden(self):
        loop = _agent_loop()
        loop.attack_surface.add_item(kind="url", url="http://t/vulnerabilities/csrf/", method="GET")
        loop.attack_surface.add_item(kind="form", url="http://t/vulnerabilities/sqli/", method="GET", parameters=["id"])
        # sqli endpoint has been probed; csrf has not.
        loop.coverage.mark(endpoint="GET http://t/vulnerabilities/sqli/", parameter="id", vuln_type="sqli", status="tried")

        pack = build_playbook_hints(loop, skills_dir=Path("/nonexistent"))

        self.assertIn("Untested attack surface", pack)
        self.assertIn("/vulnerabilities/csrf", pack)
        # The probed sqli endpoint must not appear in the untested section.
        self.assertNotIn("/vulnerabilities/sqli", pack.split("Untested attack surface", 1)[1])

    def test_guidance_encourages_visiting_unvisited_endpoints(self):
        loop = _agent_loop()
        pack = build_playbook_hints(loop, skills_dir=Path("/nonexistent"))
        self.assertIn("visit any discovered-but-unvisited endpoints", pack)


if __name__ == "__main__":
    unittest.main()
