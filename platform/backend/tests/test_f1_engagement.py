"""F1 focus fields + graph_execution continue regression (map #81)."""
from __future__ import annotations

import unittest

from app.services.case_engagement import focus_fields_from_message, resolve_graph_execution


class TestFocusFieldsAndContinue(unittest.TestCase):
    def test_focus_fields_from_message(self):
        self.assertEqual(focus_fields_from_message(None), {})
        self.assertEqual(focus_fields_from_message({}), {})
        self.assertEqual(
            focus_fields_from_message({"text": "please retest vuln abc"}),
            {},
        )
        got = focus_fields_from_message(
            {
                "focus_finding_ids": ["a", " b ", ""],
                "focus_note": "  cover authz paths  ",
            }
        )
        self.assertEqual(got["focus_finding_ids"], ["a", "b"])
        self.assertEqual(got["focus_note"], "cover authz paths")
        camel = focus_fields_from_message(
            {"focusFindingIds": "id1,id2", "focusNote": "note"}
        )
        self.assertEqual(camel["focus_finding_ids"], ["id1", "id2"])
        self.assertEqual(camel["focus_note"], "note")
        legacy = focus_fields_from_message({"retest_finding_ids": ["old"]})
        self.assertEqual(legacy["focus_finding_ids"], ["old"])
        # Prefer focus_* over legacy when both set
        prefer = focus_fields_from_message(
            {"focus_finding_ids": ["new"], "retest_finding_ids": ["old"]}
        )
        self.assertEqual(prefer["focus_finding_ids"], ["new"])

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
