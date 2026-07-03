"""Breadth-seeding tests for the Exploration Plan Tree.

Regression guard for the fix that param-less / navigational surfaces (nav links,
module landing pages) still seed an actionable baseline recon node instead of
being silently dropped at seeding time.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.agent.plan_tree import ExplorationPlanTree  # noqa: E402

# Mirror loop.DEFAULT_WEB_VULN_TYPES so the test exercises the real seeding path.
DEFAULT_WEB_VULN_TYPES = [
    "sqli", "xss", "command_injection", "lfi", "open_redirect",
    "weak_credentials", "auth_session", "idor", "info_disclosure",
]


class PlanTreeBreadthTest(unittest.TestCase):
    def _seed(self, surface):
        tree = ExplorationPlanTree("conv-1")
        created = tree.seed_from_attack_surface(surface, vuln_types=DEFAULT_WEB_VULN_TYPES)
        return tree, created

    def test_param_less_nav_link_seeds_recon_node(self):
        """A discovered menu link with no query params must become visitable work."""
        _tree, created = self._seed({
            "kind": "url",
            "url": "http://target/vulnerabilities/csrf/",
            "method": "GET",
            "parameters": [],
        })
        kinds = {n.kind for n in created}
        self.assertIn("surface", kinds, "expected an Explore parent node")
        recon = [n for n in created if n.kind == "test" and n.vuln_type == "web_baseline"]
        self.assertTrue(recon, "param-less nav link should seed a baseline recon test node")

    def test_param_less_form_seeds_recon_node(self):
        """A form whose only control is a submit button still gets visited."""
        _tree, created = self._seed({
            "kind": "form",
            "url": "http://target/vulnerabilities/weak_id/",
            "method": "GET",
            "parameters": ["submit"],  # low-value; dropped by _param_vuln_types
        })
        recon = [n for n in created if n.kind == "test" and n.vuln_type == "web_baseline"]
        self.assertTrue(recon, "param-less form should seed a baseline recon test node")

    def test_parametrized_form_still_seeds_specific_vuln_tests(self):
        """Regression: real params must still fan out to specific vuln classes."""
        _tree, created = self._seed({
            "kind": "form",
            "url": "http://target/vulnerabilities/sqli/",
            "method": "GET",
            "parameters": ["id"],
        })
        vuln_types = {n.vuln_type for n in created if n.kind == "test"}
        self.assertIn("sqli", vuln_types)
        # It should not collapse into a bare recon-only node.
        self.assertNotEqual(vuln_types, {"web_baseline"})


if __name__ == "__main__":
    unittest.main()
