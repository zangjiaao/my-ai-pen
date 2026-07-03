"""Link-crawl frontier selection tests.

Guards the pure selection logic that turns discovered same-origin nav links into
a bounded crawl frontier so the agent widens breadth beyond the fixed wordlist.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.agent.loop import compute_link_crawl_frontier  # noqa: E402


def _in_scope(url: str) -> bool:
    return url.startswith("http://target/")


INDEX = ["http://target/", "http://target/index.php"]


class LinkCrawlFrontierTest(unittest.TestCase):
    def test_discovered_navlinks_included_covered_and_offscope_excluded(self):
        surface = [
            {"kind": "url", "method": "GET", "url": "http://target/vulnerabilities/csrf"},
            {"kind": "url", "method": "GET", "url": "http://target/vulnerabilities/sqli"},  # covered
            {"kind": "url", "method": "GET", "url": "http://evil/other"},                    # off-scope
            {"kind": "url", "method": "GET", "url": "http://target/app.css"},                # static
            {"kind": "form", "method": "POST", "url": "http://target/login"},               # not a GET url surface
        ]
        frontier = compute_link_crawl_frontier(
            surface,
            covered_endpoints={"GET http://target/vulnerabilities/sqli"},
            attempted=set(),
            index_urls=INDEX,
            index_seeded=True,
            in_scope=_in_scope,
            limit=10,
        )
        self.assertIn("http://target/vulnerabilities/csrf", frontier)
        self.assertNotIn("http://target/vulnerabilities/sqli", frontier)
        self.assertNotIn("http://evil/other", frontier)
        self.assertNotIn("http://target/app.css", frontier)

    def test_index_seeded_only_when_not_yet_seeded(self):
        seeded = compute_link_crawl_frontier(
            [], covered_endpoints=set(), attempted=set(), index_urls=INDEX,
            index_seeded=True, in_scope=_in_scope, limit=10,
        )
        self.assertEqual(seeded, [])
        first_pass = compute_link_crawl_frontier(
            [], covered_endpoints=set(), attempted=set(), index_urls=INDEX,
            index_seeded=False, in_scope=_in_scope, limit=10,
        )
        self.assertIn("http://target/index.php", first_pass)

    def test_attempted_urls_are_skipped_and_limit_respected(self):
        surface = [
            {"kind": "url", "method": "GET", "url": f"http://target/m{i}"} for i in range(5)
        ]
        frontier = compute_link_crawl_frontier(
            surface,
            covered_endpoints=set(),
            attempted={"http://target/m0"},
            index_urls=INDEX,
            index_seeded=True,
            in_scope=_in_scope,
            limit=2,
        )
        self.assertNotIn("http://target/m0", frontier)
        self.assertEqual(len(frontier), 2)


if __name__ == "__main__":
    unittest.main()
