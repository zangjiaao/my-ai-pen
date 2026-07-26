"""Agent language catalog + worker_limits (#134 / #136)."""
from __future__ import annotations

import unittest

from app.api.nodes import worker_limits_from_config
from app.services.agent_language import (
    ALLOWED_AGENT_LANGUAGES,
    SHIPPED_AGENT_LANGUAGES,
    merge_worker_limits_into_message,
    normalize_agent_language,
    parse_agent_language_for_update,
)


# Lockstep with node4 AGENT_LANGUAGE_CODES / FE AGENT_LANGUAGE_CODES.
EXPECTED_CODES = ("auto", "zh-CN", "zh-TW", "en", "ja")


class TestAgentLanguageCatalog(unittest.TestCase):
    def test_shipped_catalog_order(self):
        self.assertEqual(SHIPPED_AGENT_LANGUAGES, EXPECTED_CODES)
        self.assertEqual(ALLOWED_AGENT_LANGUAGES, frozenset(EXPECTED_CODES))

    def test_normalize_aliases(self):
        cases = [
            (None, "auto"),
            ("", "auto"),
            ("auto", "auto"),
            ("follow", "auto"),
            ("zh-CN", "zh-CN"),
            ("zh", "zh-CN"),
            ("中文", "zh-CN"),
            ("zh-TW", "zh-TW"),
            ("繁體", "zh-TW"),
            ("繁体", "zh-TW"),
            ("en", "en"),
            ("english", "en"),
            ("ja", "ja"),
            ("jp", "ja"),
            ("日本語", "ja"),
            ("de", "auto"),  # unregistered → safe default
            ("not-a-lang", "auto"),
        ]
        for raw, want in cases:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_agent_language(raw), want)

    def test_zh_cn_and_zh_tw_never_collapse(self):
        self.assertNotEqual(
            normalize_agent_language("zh-CN"),
            normalize_agent_language("zh-TW"),
        )
        self.assertNotEqual(
            normalize_agent_language("简体"),
            normalize_agent_language("繁體"),
        )

    def test_parse_for_update_accepts_shipped_and_aliases(self):
        self.assertEqual(parse_agent_language_for_update("ja"), "ja")
        self.assertEqual(parse_agent_language_for_update("jp"), "ja")
        self.assertEqual(parse_agent_language_for_update("zh-TW"), "zh-TW")
        self.assertEqual(parse_agent_language_for_update("繁體"), "zh-TW")
        self.assertEqual(parse_agent_language_for_update("en"), "en")

    def test_parse_for_update_rejects_unknown(self):
        with self.assertRaises(ValueError):
            parse_agent_language_for_update("de")
        with self.assertRaises(ValueError):
            parse_agent_language_for_update("not-a-lang")
        with self.assertRaises(ValueError):
            parse_agent_language_for_update("")

    def test_worker_limits_include_agent_language(self):
        for code in EXPECTED_CODES:
            limits = worker_limits_from_config({"agent_language": code})
            self.assertEqual(limits["agent_language"], code, code)
        # alias through config
        limits_jp = worker_limits_from_config({"agent_language": "jp"})
        self.assertEqual(limits_jp["agent_language"], "ja")
        # missing → auto
        limits_default = worker_limits_from_config({})
        self.assertEqual(limits_default["agent_language"], "auto")

    def test_merge_worker_limits_preserves_language_on_steer_rebuild(self):
        """#138: steer/re-burst shaped messages must carry Node language."""
        limits = worker_limits_from_config({"agent_language": "ja"})
        steer = {"type": "user_steer", "text": "继续扫", "conversation_id": "c1"}
        merged = merge_worker_limits_into_message(steer, limits)
        self.assertEqual(merged["worker_limits"]["agent_language"], "ja")
        self.assertEqual(merged["agent_language"], "ja")
        # input not mutated
        self.assertNotIn("worker_limits", steer)
        # does not overwrite explicit top-level
        explicit = merge_worker_limits_into_message(
            {"type": "task_assign", "agent_language": "zh-TW"},
            limits,
        )
        self.assertEqual(explicit["agent_language"], "zh-TW")
        self.assertEqual(explicit["worker_limits"]["agent_language"], "ja")
        # empty limits → passthrough
        bare = merge_worker_limits_into_message({"type": "user_steer"}, None)
        self.assertEqual(bare, {"type": "user_steer"})


if __name__ == "__main__":
    unittest.main()
