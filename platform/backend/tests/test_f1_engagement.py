"""F1 envelope fields + graph_execution continue regression (map #81)."""
from __future__ import annotations

import unittest

from app.services.case_engagement import f1_focus_fields_from_message, resolve_graph_execution


class TestF1AndContinue(unittest.TestCase):
    def test_f1_focus_fields_from_message(self):
        self.assertEqual(f1_focus_fields_from_message(None), {})
        self.assertEqual(f1_focus_fields_from_message({}), {})
        # Never invent from free text
        self.assertEqual(
            f1_focus_fields_from_message({"text": "please retest vuln abc"}),
            {},
        )
        got = f1_focus_fields_from_message(
            {
                "retest_finding_ids": ["a", " b ", ""],
                "focus_note": "  cover authz paths  ",
            }
        )
        self.assertEqual(got["retest_finding_ids"], ["a", "b"])
        self.assertEqual(got["focus_note"], "cover authz paths")
        camel = f1_focus_fields_from_message(
            {"retestFindingIds": "id1,id2", "focusNote": "note"}
        )
        self.assertEqual(camel["retest_finding_ids"], ["id1", "id2"])
        self.assertEqual(camel["focus_note"], "note")

    def test_resolve_graph_execution_continue_regression(self):
        self.assertEqual(
            resolve_graph_execution(
                engagement_template="app_assessment",
                conversation_status="completed",
                explicit_execution=None,
            ),
            "continue",
        )
        self.assertEqual(
            resolve_graph_execution(
                engagement_template="app_assessment",
                conversation_status="completed",
                explicit_execution="full",
            ),
            "full",
        )


if __name__ == "__main__":
    unittest.main()
