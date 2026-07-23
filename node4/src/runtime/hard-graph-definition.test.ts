/**
 * Hard vs soft graph definition seam.
 * Run: npx tsx src/runtime/hard-graph-definition.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyHardGraphToolProfile,
  isHardGraphDefinition,
  isSoftScenarioGraphDefinition,
  listHardGraphIds,
  loadHardGraphFile,
  loadSoftScenarioGraphFile,
  resolveHardGraph,
} from "./hard-graph-definition.js";
import { loadPentestGraphFile } from "./pentest-graph.js";

const repoExperts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../experts/pentest",
);

// Soft scenario (existing) is soft, not hard
const soft = await loadSoftScenarioGraphFile(repoExperts, "app_assessment");
assert.ok(soft);
assert.equal(isSoftScenarioGraphDefinition(soft), true);
assert.equal(isHardGraphDefinition(soft), false);

// Existing loadPentestGraphFile still works (soft menu)
const softLegacy = await loadPentestGraphFile(repoExperts, "app_assessment");
assert.ok(softLegacy);
assert.equal(isHardGraphDefinition(softLegacy), false);
assert.equal(isSoftScenarioGraphDefinition(softLegacy), true);

// Hard thin path loads
const hard = await loadHardGraphFile(repoExperts, "app_assessment_thin");
assert.ok(hard);
assert.equal(hard!.discipline, "hard");
assert.equal(hard!.id, "app_assessment_thin");
assert.ok(hard!.stages.length >= 3);
assert.equal(hard!.stages[0]!.id, "init");
assert.equal(isHardGraphDefinition(hard), true);
assert.equal(isSoftScenarioGraphDefinition(hard), false);

// List includes thin path
const ids = await listHardGraphIds(repoExperts);
assert.ok(ids.includes("app_assessment_thin"));

// Resolve via graphId alias
const r1 = await resolveHardGraph({
  task: { graphId: "app_assessment_thin" },
  packRoot: repoExperts,
  packId: "pentest",
});
assert.equal(r1.mode, "hard");
if (r1.mode === "hard") {
  assert.equal(r1.graph.id, "app_assessment_thin");
}

// Resolve via graphDiscipline hard + default thin id
const r2 = await resolveHardGraph({
  task: { graphDiscipline: "hard" },
  packRoot: repoExperts,
  packId: "pentest",
});
assert.equal(r2.mode, "hard");

// Soft graphId alone without discipline → not hard
const r3 = await resolveHardGraph({
  task: { graphId: "app_assessment" },
  packRoot: repoExperts,
  packId: "pentest",
  env: {},
});
assert.equal(r3.mode, "not_hard");

// Non-pentest pack never hard
const r4 = await resolveHardGraph({
  task: { graphId: "app_assessment_thin" },
  packRoot: repoExperts,
  packId: "ctf",
});
assert.equal(r4.mode, "not_hard");

// Env NODE4_HARD_GRAPH enables thin path
const r5 = await resolveHardGraph({
  task: {},
  packRoot: repoExperts,
  packId: "pentest",
  env: { NODE4_HARD_GRAPH: "1" } as NodeJS.ProcessEnv,
});
assert.equal(r5.mode, "hard");

// Tool profile apply
assert.deepEqual(
  applyHardGraphToolProfile(["shell", "http", "finding", "todo"], {
    allow: ["shell", "todo"],
    deny: ["shell"],
  }),
  ["todo"],
);

console.log("hard-graph-definition.test.ts: ok");
