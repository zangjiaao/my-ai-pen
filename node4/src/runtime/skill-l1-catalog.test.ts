/**
 * Wave 2 host L1 skill catalog (Spec #274).
 * Run: npx tsx src/runtime/skill-l1-catalog.test.ts
 */
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillStore } from "../stores/skill.js";
import {
  formatSkillL1CatalogInjection,
  loadSkillL1Catalog,
  skillL1InjectionHasNoBodies,
  toSkillL1Entries,
} from "./skill-l1-catalog.js";

const root = join(tmpdir(), `node4-skill-l1-${Date.now()}`);
await mkdir(join(root, "demo-skill"), { recursive: true });
await writeFile(
  join(root, "demo-skill", "SKILL.md"),
  `---
name: Demo Skill
description: Short index description only
---

# How to exploit demo

This is the full body that must NOT appear in L1 catalog injection.
`.repeat(3),
  "utf8",
);

const skills = new SkillStore(root);
const l1 = await loadSkillL1Catalog(skills, ["demo-skill"]);
assert.equal(l1.length, 1);
assert.equal(l1[0]!.id, "demo-skill");
assert.equal(l1[0]!.name, "Demo Skill");
assert.match(l1[0]!.description, /Short index/);
assert.ok(!("body" in l1[0]!));

const injection = formatSkillL1CatalogInjection(l1);
assert.match(injection, /skill-l1-catalog/);
assert.match(injection, /demo-skill/);
assert.doesNotMatch(injection, /How to exploit demo/);
assert.equal(skillL1InjectionHasNoBodies(injection), true);

// Load still required for body
const body = await skills.load("demo-skill");
assert.ok(!("error" in body));
if (!("error" in body)) {
  assert.match(body.body, /How to exploit demo/);
}

// Orthogonal: catalog works without hypothesis mode (no hyp dependency in API)
const l1b = toSkillL1Entries(await skills.list());
assert.ok(formatSkillL1CatalogInjection(l1b).includes("skill-l1-catalog"));

await rm(root, { recursive: true, force: true });
console.log("skill-l1-catalog.test.ts: ok");
