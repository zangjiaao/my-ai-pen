"""Unit tests for agent vulnerability dedupe fingerprints."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "platform" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.finding_dedupe import (  # noqa: E402
    append_discovery_event,
    is_same_finding,
    normalize_finding_title,
    ports_equal,
)


class FindingDedupeTests(unittest.TestCase):
    def test_title_normalize(self):
        self.assertEqual(normalize_finding_title("  SQL  Injection  "), "sql injection")
        self.assertEqual(
            normalize_finding_title("Level 1 - Login Bypass"),
            normalize_finding_title("level 1 - login bypass"),
        )

    def test_same_finding_same_asset_port_title(self):
        existing = {"title": "SQLi on login", "asset_id": "aid-1", "port": "80"}
        self.assertTrue(
            is_same_finding(existing, title="sqli on login", asset_id="aid-1", port="80")
        )
        self.assertFalse(
            is_same_finding(existing, title="sqli on login", asset_id="aid-1", port="443")
        )
        self.assertFalse(
            is_same_finding(existing, title="sqli on login", asset_id="aid-2", port="80")
        )
        self.assertFalse(
            is_same_finding(existing, title="XSS elsewhere", asset_id="aid-1", port="80")
        )

    def test_ports_equal_nulls(self):
        self.assertTrue(ports_equal(None, None))
        self.assertTrue(ports_equal("", None))
        self.assertFalse(ports_equal("22", None))

    def test_discovery_timeline_append(self):
        h1 = append_discovery_event([], event="discovered", conversation_id="c1", evidence_ids=["e1"])
        self.assertEqual(len(h1), 1)
        self.assertEqual(h1[0]["event"], "discovered")
        h2 = append_discovery_event(h1, event="rediscovered", conversation_id="c2", evidence_ids=["e2"])
        self.assertEqual(len(h2), 2)
        self.assertEqual(h2[1]["event"], "rediscovered")
        self.assertEqual(h2[1]["conversation_id"], "c2")


if __name__ == "__main__":
    unittest.main()
