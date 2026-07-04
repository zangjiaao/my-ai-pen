import asyncio
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.tools.load_skill import make_load_skill_tool  # noqa: E402
from pentest_node.tools.skill_loader import SkillRegistry  # noqa: E402


SKILLS_DIR = ROOT / "node" / "pentest_node" / "skills"


class LoadSkillToolTests(unittest.TestCase):
    def test_package_skill_lists_and_loads_references(self):
        tool = make_load_skill_tool(SKILLS_DIR)

        skill = asyncio.run(tool.handler(skill_name="xss"))
        reference = asyncio.run(tool.handler(skill_name="xss", resource_path="references/contexts.md"))

        self.assertEqual(skill["status"], "ok")
        self.assertIn({"type": "reference", "path": "references/contexts.md", "description": "XSS reflection context triage and evidence guidance."}, skill["resources"])
        self.assertEqual(reference["status"], "ok")
        self.assertIn("XSS Context Guide", reference["content"])

    def test_loads_migrated_legacy_skill_reference(self):
        tool = make_load_skill_tool(SKILLS_DIR)

        skill = asyncio.run(tool.handler(skill_name="idor"))
        reference = asyncio.run(tool.handler(skill_name="idor", resource_path="references/object_authorization.md"))

        self.assertEqual(skill["status"], "ok")
        self.assertIn("references/object_authorization.md", {item["path"] for item in skill["resources"]})
        self.assertEqual(reference["status"], "ok")
        self.assertIn("Object Authorization", reference["content"])
    def test_blocks_reference_path_traversal(self):
        tool = make_load_skill_tool(SKILLS_DIR)

        result = asyncio.run(tool.handler(skill_name="xss", resource_path="../xss.md"))

        self.assertEqual(result["status"], "blocked")

    def test_knowledge_only_skill_loads_package_reference(self):
        tool = make_load_skill_tool(SKILLS_DIR)

        skill = asyncio.run(tool.handler(skill_name="web_baseline"))
        reference = asyncio.run(tool.handler(skill_name="web_baseline", resource_path="references/attack_surface.md"))

        self.assertEqual(skill["status"], "ok")
        self.assertIn("knowledge-only Skill", skill["content"])
        self.assertIn("references/attack_surface.md", {item["path"] for item in skill["resources"]})
        self.assertEqual(reference["status"], "ok")
        self.assertIn("Plan Tree Seeding", reference["content"])
    def test_registry_exposes_package_references(self):
        package = SkillRegistry(SKILLS_DIR).select_package_for_vuln("sqli")

        self.assertIsNotNone(package)
        self.assertIn("references/evidence_patterns.md", {item.get("path") for item in package.references})


if __name__ == "__main__":
    unittest.main()
