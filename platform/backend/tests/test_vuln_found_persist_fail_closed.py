"""Spec #280: live vuln_found is post-persist success only (fail-closed)."""
from __future__ import annotations

import unittest

from app.ws.router import apply_vuln_persist_result, _vuln_found_error_frame


def _incoming_vuln_found(**overrides):
    base = {
        "type": "vuln_found",
        "conversation_id": "conv-1",
        "task_id": "task-9",
        "title": "SQLi on /login",
        "status": "confirmed",
        "severity": "high",
        "evidence_ids": ["ev-1"],
    }
    base.update(overrides)
    return base


class TestApplyVulnPersistResult(unittest.TestCase):
    def test_none_rewrites_to_vuln_found_error(self):
        """Review finding: bare None must never leave original success frame."""
        msg = _incoming_vuln_found()
        out = apply_vuln_persist_result(msg, None)
        self.assertEqual(out["type"], "vuln_found_error")
        self.assertEqual(out["created"], False)
        self.assertEqual(out["conversation_id"], "conv-1")
        self.assertEqual(out["task_id"], "task-9")
        self.assertEqual(out["title"], "SQLi on /login")
        self.assertIn("error", out)
        self.assertNotEqual(out.get("type"), "vuln_found")

    def test_structured_error_replaces_frame(self):
        msg = _incoming_vuln_found()
        persisted = _vuln_found_error_frame(msg, "evidence_ids required (evidence gate)")
        out = apply_vuln_persist_result(msg, persisted)
        self.assertEqual(out["type"], "vuln_found_error")
        self.assertEqual(out["error"], "evidence_ids required (evidence gate)")
        self.assertEqual(out["created"], False)
        self.assertEqual(out["conversation_id"], "conv-1")
        self.assertEqual(out["title"], "SQLi on /login")

    def test_structured_error_fills_missing_context_from_msg(self):
        msg = _incoming_vuln_found(title="From wire")
        # Gate return omitted title — helper preserves from original frame.
        persisted = {
            "type": "vuln_found_error",
            "conversation_id": "conv-1",
            "error": "status must be confirmed",
            "created": False,
        }
        out = apply_vuln_persist_result(msg, persisted)
        self.assertEqual(out["type"], "vuln_found_error")
        self.assertEqual(out["title"], "From wire")
        self.assertEqual(out["task_id"], "task-9")
        self.assertEqual(out["error"], "status must be confirmed")

    def test_success_merges_ledger_ids(self):
        msg = _incoming_vuln_found()
        persisted = {
            "id": "uuid-ledger-1",
            "vulnerability_id": "uuid-ledger-1",
            "created": True,
            "severity": "high",
            "status": "to_fix",
        }
        out = apply_vuln_persist_result(msg, persisted)
        self.assertEqual(out["type"], "vuln_found")
        self.assertEqual(out["id"], "uuid-ledger-1")
        self.assertEqual(out["vulnerability_id"], "uuid-ledger-1")
        self.assertIs(out["created"], True)
        self.assertEqual(out["title"], "SQLi on /login")
        self.assertEqual(out["conversation_id"], "conv-1")

    def test_success_does_not_wipe_with_none_fields(self):
        msg = _incoming_vuln_found(agent_name="scout")
        persisted = {
            "id": "uuid-2",
            "vulnerability_id": "uuid-2",
            "created": False,
            "agent_name": None,  # must not clobber
        }
        out = apply_vuln_persist_result(msg, persisted)
        self.assertEqual(out["agent_name"], "scout")
        self.assertEqual(out["id"], "uuid-2")

    def test_non_dict_persisted_is_error(self):
        msg = _incoming_vuln_found()
        out = apply_vuln_persist_result(msg, "oops")  # type: ignore[arg-type]
        self.assertEqual(out["type"], "vuln_found_error")
        self.assertEqual(out["created"], False)

    def test_error_frame_never_reports_created_true(self):
        msg = _incoming_vuln_found()
        persisted = {
            "type": "vuln_found_error",
            "error": "boom",
            "created": True,  # hostile / mistaken — force False
        }
        out = apply_vuln_persist_result(msg, persisted)
        self.assertEqual(out["type"], "vuln_found_error")
        self.assertIs(out["created"], False)


class TestVulnFoundErrorFrame(unittest.TestCase):
    def test_preserves_context_fields(self):
        frame = _vuln_found_error_frame(
            {"conversation_id": "c", "task_id": "t", "title": "T"},
            "missing conversation_id",
        )
        self.assertEqual(frame["type"], "vuln_found_error")
        self.assertEqual(frame["conversation_id"], "c")
        self.assertEqual(frame["task_id"], "t")
        self.assertEqual(frame["title"], "T")
        self.assertEqual(frame["error"], "missing conversation_id")
        self.assertIs(frame["created"], False)


if __name__ == "__main__":
    unittest.main()
