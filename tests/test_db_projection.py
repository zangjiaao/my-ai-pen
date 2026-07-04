import asyncio
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.db import NodeDB  # noqa: E402


class NodeDBProjectionTests(unittest.TestCase):
    def test_checkpoint_update_projects_surface_coverage_and_traffic_tables(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                db = NodeDB(Path(tmp) / "node.sqlite3")
                await db.init()
                await db.create_session(
                    session_id="s1",
                    task_id="t1",
                    target={"type": "url", "value": "http://target.local"},
                    scope={"allow": ["http://target.local"], "deny": []},
                    instruction="test",
                    output_dir=tmp,
                    status="running",
                )
                await db.save_event("s1", {
                    "type": "checkpoint_update",
                    "checkpoint": {
                        "conversation_id": "s1",
                        "state": {"iteration": 3, "phase": "verify", "phase_iteration": 2},
                        "attack_surface": [{
                            "surface_id": "as-1",
                            "kind": "form",
                            "url": "http://target.local/login",
                            "method": "POST",
                            "parameters": ["username"],
                        }],
                        "coverage": [{
                            "coverage_id": "cov-1",
                            "endpoint": "POST http://target.local/login",
                            "parameter": "username",
                            "vuln_type": "sqli",
                            "status": "tried",
                            "evidence_ids": ["ev-111111111111"],
                        }],
                        "captured_traffic": [{
                            "request_id": "req-1",
                            "method": "POST",
                            "url": "http://target.local/login",
                            "status_code": 200,
                            "rank_score": 100,
                        }],
                    },
                })
                snapshot = await db.snapshot("s1")
                await db.close()
                return snapshot

        snapshot = asyncio.run(scenario())

        self.assertEqual(len(snapshot["attack_surface"]), 1)
        self.assertEqual(len(snapshot["coverage"]), 1)
        self.assertEqual(len(snapshot["traffic"]), 1)


if __name__ == "__main__":
    unittest.main()
