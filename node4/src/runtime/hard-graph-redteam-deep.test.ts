/**
 * Phase 2 product hard Graph: redteam_deep (#78 / #85).
 * Run: npx tsx src/runtime/hard-graph-redteam-deep.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyHardGraphToolProfile,
  isHardGraphDefinition,
  listHardGraphIds,
  loadHardGraphFile,
  resolveHardGraph,
} from "./hard-graph-definition.js";

const repoExperts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../experts/pentest",
);

const deep = await loadHardGraphFile(repoExperts, "redteam_deep");
assert.ok(deep, "redteam_deep hard graph loads");
assert.equal(deep!.discipline, "hard");
assert.equal(deep!.id, "redteam_deep");
assert.equal(deep!.roe?.allow_postex, true, "deep Graph file post-ex ON");
assert.ok(isHardGraphDefinition(deep));

const stageIds = deep!.stages.map((s) => s.id);
const expected = [
  "init",
  "surface",
  "auth_session",
  "class_probe",
  "authz_logic",
  "component",
  "chain",
  "postex",
  "lateral",
  "validate_book",
];
assert.deepEqual(stageIds, expected, "locked stage order from #79");

// Prefix assessment alignment except surface success (R1 thickened)
const assess = await loadHardGraphFile(repoExperts, "app_assessment");
assert.ok(assess);
for (const id of [
  "init",
  "auth_session",
  "class_probe",
  "authz_logic",
  "component",
  "validate_book",
]) {
  const a = assess!.stages.find((s) => s.id === id)!;
  const d = deep!.stages.find((s) => s.id === id)!;
  assert.equal(d.success, a.success, `${id} success matches assessment`);
  assert.deepEqual(d.require, a.require, `${id} require matches assessment`);
  assert.deepEqual(d.tools?.allow, a.tools?.allow, `${id} tools match assessment`);
  assert.equal(d.max_retries, a.max_retries, `${id} max_retries match assessment`);
}

const surface = deep!.stages.find((s) => s.id === "surface")!;
assert.ok(
  /asset|attack surface|external|exposure/i.test(String(surface.success || "")),
  "surface success thickened for recon (R1)",
);
assert.equal(surface.require?.surfaces_min, 1);

// Suffix: summary-only, no finding tool, max_retries 1, honest-deadend language
const actTools = [
  "todo",
  "read",
  "fact",
  "surface",
  "skill",
  "write",
  "shell",
  "http",
  "session",
  "browser",
  "script",
  "subagent",
  "hypothesis", // Spec #274 optional hypothesis queue on probe/deep stages
  "platform_list_assets",
  "platform_get_asset",
  "platform_list_groups",
  "request_user_decision",
];
for (const id of ["chain", "postex", "lateral"]) {
  const st = deep!.stages.find((s) => s.id === id)!;
  assert.equal(st.require?.summary, true);
  assert.equal(st.max_retries, 1);
  assert.ok(/honest deadend/i.test(String(st.success || "")), `${id} allows honest deadend`);
  assert.deepEqual(st.tools?.allow, actTools, `${id} component-class tools`);
  assert.equal(st.hypothesis_work_mode, true, `${id} hypothesis work mode on`);
  const tools = applyHardGraphToolProfile(
    ["todo", "write", "shell", "http", "subagent", "finding", "skill", "hypothesis"],
    st.tools,
  );
  assert.ok(tools.includes("write"));
  assert.ok(tools.includes("subagent"));
  assert.ok(tools.includes("hypothesis"));
  assert.ok(!tools.includes("finding"), `${id} does not book`);
}

const book = deep!.stages.find((s) => s.id === "validate_book")!;
assert.equal(book.max_retries, 1, "validate_book retries align with app_assessment");
assert.ok(book.tools?.allow?.includes("finding"));
assert.notEqual(book.hypothesis_work_mode, true, "book stage does not enable hypothesis mode");

const ids = await listHardGraphIds(repoExperts);
assert.ok(ids.includes("redteam_deep"));

// Resolve product template id → hard load
const r = await resolveHardGraph({
  task: { engagementTemplate: "redteam_deep" },
  packRoot: repoExperts,
  packId: "pentest",
  env: {},
});
assert.equal(r.mode, "hard", "product deep template loads Expert Graph");
if (r.mode === "hard") {
  assert.equal(r.graph.id, "redteam_deep");
  assert.equal(r.graph.roe?.allow_postex, true);
}

// Deep aliases
for (const alias of ["redteam", "red-team", "deep"]) {
  const ra = await resolveHardGraph({
    task: { graphId: alias },
    packRoot: repoExperts,
    packId: "pentest",
    env: {},
  });
  assert.equal(ra.mode, "hard", `alias ${alias} → hard deep`);
  if (ra.mode === "hard") assert.equal(ra.graph.id, "redteam_deep");
}

console.log("hard-graph-redteam-deep: ok");
