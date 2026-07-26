"""Agent language catalog + worker_limits (#134 / #136) + review fixes."""
from __future__ import annotations

import unittest
from pathlib import Path

from app.api.nodes import worker_limits_from_config
from app.services.agent_language import (
    ALLOWED_AGENT_LANGUAGES,
    SHIPPED_AGENT_LANGUAGES,
    catalog_path,
    merge_worker_limits_into_message,
    normalize_agent_language,
    parse_agent_language_for_update,
    resolve_agent_language,
)


class TestAgentLanguageCatalog(unittest.TestCase):
    def test_catalog_file_drives_shipped_codes(self):
        path = catalog_path()
        self.assertTrue(path.is_file(), path)
        self.assertEqual(
            SHIPPED_AGENT_LANGUAGES,
            ("auto", "zh-CN", "zh-TW", "en", "ja"),
        )
        self.assertEqual(ALLOWED_AGENT_LANGUAGES, frozenset(SHIPPED_AGENT_LANGUAGES))

    def test_catalog_byte_identical_to_shared_and_siblings(self):
        """Shipped copies must stay in lockstep (edit shared/ then re-copy)."""
        ours = catalog_path().read_bytes()
        # platform/backend/app/services → repo root is 4 parents up
        repo = Path(__file__).resolve().parents[3]
        siblings = [
            repo / "shared" / "agent-language-catalog.json",
            repo / "node4" / "src" / "runtime" / "agent-language-catalog.json",
            repo / "platform" / "frontend" / "src" / "lib" / "agent-language-catalog.json",
        ]
        for p in siblings:
            self.assertTrue(p.is_file(), f"missing {p}")
            self.assertEqual(p.read_bytes(), ours, f"catalog drift: {p}")

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
            ("de", "auto"),
            ("not-a-lang", "auto"),
        ]
        for raw, want in cases:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_agent_language(raw), want)

    def test_resolve_unknown_modes(self):
        self.assertEqual(resolve_agent_language("de", unknown="auto"), "auto")
        with self.assertRaises(ValueError):
            resolve_agent_language("de", unknown="error")
        with self.assertRaises(ValueError):
            resolve_agent_language("", unknown="error")

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
        for code in SHIPPED_AGENT_LANGUAGES:
            limits = worker_limits_from_config({"agent_language": code})
            self.assertEqual(limits["agent_language"], code, code)
        limits_jp = worker_limits_from_config({"agent_language": "jp"})
        self.assertEqual(limits_jp["agent_language"], "ja")
        limits_default = worker_limits_from_config({})
        self.assertEqual(limits_default["agent_language"], "auto")

    def test_merge_worker_limits_preserves_language_on_steer_rebuild(self):
        limits = worker_limits_from_config({"agent_language": "ja"})
        steer = {"type": "user_steer", "text": "继续扫", "conversation_id": "c1"}
        merged = merge_worker_limits_into_message(steer, limits)
        self.assertEqual(merged["worker_limits"]["agent_language"], "ja")
        self.assertEqual(merged["agent_language"], "ja")
        self.assertNotIn("worker_limits", steer)
        explicit = merge_worker_limits_into_message(
            {"type": "task_assign", "agent_language": "zh-TW"},
            limits,
        )
        self.assertEqual(explicit["agent_language"], "zh-TW")
        self.assertEqual(explicit["worker_limits"]["agent_language"], "ja")
        bare = merge_worker_limits_into_message({"type": "user_steer"}, None)
        self.assertEqual(bare, {"type": "user_steer"})


if __name__ == "__main__":
    unittest.main()
