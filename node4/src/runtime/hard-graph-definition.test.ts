/**
 * Hard vs soft graph definition seam.
 * Run: npx tsx src/runtime/hard-graph-definition.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyHardGraphToolProfile,
  isContinueInEnvelopeExecution,
  isHardGraphDefinition,
  isSoftScenarioGraphDefinition,
  listHardGraphIds,
  loadHardGraphFile,
  loadSoftScenarioGraphFile,
  parseGraphExecution,
  resolveExpertWorkPath,
  resolveHardGraph,
} from "./hard-graph-definition.js";

const repoExperts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../experts/pentest",
);

// Product soft scenario files are retired (#76) — load returns null
const softGone = await loadSoftScenarioGraphFile(repoExperts, "app_assessment");
assert.equal(softGone, null, "soft app_assessment file removed from product pack");

// Synthetic soft shape still discriminated from hard
const syntheticSoft = {
  id: "synthetic_soft",
  nodes: { surface: {} },
  default_plan: ["surface"],
};
assert.equal(isSoftScenarioGraphDefinition(syntheticSoft), true);
assert.equal(isHardGraphDefinition(syntheticSoft), false);

// Hard thin path loads
const hard = await loadHardGraphFile(repoExperts, "app_assessment_thin");
assert.ok(hard);
assert.equal(hard!.discipline, "hard");
assert.equal(hard!.id, "app_assessment_thin");
assert.ok(hard!.stages.length >= 3);
assert.equal(hard!.stages[0]!.id, "init");
assert.equal(isHardGraphDefinition(hard), true);
assert.equal(isSoftScenarioGraphDefinition(hard), false);

// List includes mature + thin
const ids = await listHardGraphIds(repoExperts);
assert.ok(ids.includes("app_assessment_thin"));
assert.ok(ids.includes("app_assessment"));

// Resolve via thin lab id
const r1 = await resolveHardGraph({
  task: { graphId: "app_assessment_thin" },
  packRoot: repoExperts,
  packId: "pentest",
});
assert.equal(r1.mode, "hard");
if (r1.mode === "hard") {
  assert.equal(r1.graph.id, "app_assessment_thin");
}

// Resolve via graphDiscipline hard + default mature Expert primary
const r2 = await resolveHardGraph({
  task: { graphDiscipline: "hard" },
  packRoot: repoExperts,
  packId: "pentest",
});
assert.equal(r2.mode, "hard");
if (r2.mode === "hard") {
  assert.equal(r2.graph.id, "app_assessment", "hard default is mature app_assessment");
}

// Product template app_assessment → Expert Graph (Soft retired)
const r3 = await resolveHardGraph({
  task: { graphId: "app_assessment" },
  packRoot: repoExperts,
  packId: "pentest",
  env: {},
});
assert.equal(r3.mode, "hard");
if (r3.mode === "hard") {
  assert.equal(r3.graph.id, "app_assessment");
}
const r3b = await resolveHardGraph({
  task: { engagementTemplate: "app_assessment" },
  packRoot: repoExperts,
  packId: "pentest",
  env: {},
});
assert.equal(r3b.mode, "hard");

// Phase 2: redteam_deep hard file → Expert Graph
const rDeep = await resolveHardGraph({
  task: { graphId: "redteam_deep" },
  packRoot: repoExperts,
  packId: "pentest",
  env: {},
});
assert.equal(rDeep.mode, "hard", "redteam_deep product Graph loads");
if (rDeep.mode === "hard") {
  assert.equal(rDeep.graph.id, "redteam_deep");
  assert.equal(rDeep.graph.roe?.allow_postex, true);
}

// Non-pentest pack never hard
const r4 = await resolveHardGraph({
  task: { graphId: "app_assessment_thin" },
  packRoot: repoExperts,
  packId: "ctf",
});
assert.equal(r4.mode, "not_hard");

// Env NODE4_HARD_GRAPH enables mature Expert Graph
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

// Spec #125: write is optional — not a result.json handoff prerequisite
assert.equal(
  isHardGraphDefinition({
    discipline: "hard",
    id: "no_write_ok",
    stages: [{ id: "init", tools: { allow: ["todo", "fact", "skill"] } }],
  }),
  true,
  "non-empty allow without write is valid",
);
assert.equal(
  isHardGraphDefinition({
    discipline: "hard",
    id: "good_with_write",
    stages: [{ id: "init", tools: { allow: ["todo", "write"] } }],
  }),
  true,
);
// No allowlist → valid
assert.equal(
  isHardGraphDefinition({
    discipline: "hard",
    id: "open_tools",
    stages: [{ id: "init" }],
  }),
  true,
);
// Malformed allow (not array) still rejected
assert.equal(
  isHardGraphDefinition({
    discipline: "hard",
    id: "bad_allow",
    stages: [{ id: "init", tools: { allow: "todo" as unknown as string[] } }],
  }),
  false,
);

// Expert work path: fail-closed when Graph intent but no hard Graph
assert.deepEqual(
  resolveExpertWorkPath({ hardMode: "hard", graphIntent: "app_assessment" }),
  { path: "hard" },
);
assert.deepEqual(
  resolveExpertWorkPath({ hardMode: "not_hard", graphIntent: null }),
  { path: "free" },
);
assert.deepEqual(
  resolveExpertWorkPath({ hardMode: "hard", graphIntent: "redteam_deep" }),
  { path: "hard" },
  "deep Graph intent + hard load → Expert path",
);
assert.deepEqual(
  resolveExpertWorkPath({ hardMode: "not_hard", graphIntent: "missing_phase2_graph" }),
  { path: "unavailable", graphId: "missing_phase2_graph" },
  "missing hard Graph still fails closed",
);
assert.deepEqual(
  resolveExpertWorkPath({
    hardMode: "hard",
    graphIntent: "app_assessment",
    chatOnly: true,
  }),
  { path: "free" },
  "chat-only never enters Expert Graph runner",
);
assert.deepEqual(
  resolveExpertWorkPath({
    hardMode: "not_hard",
    graphIntent: "redteam_deep",
    ledgerAssistSeat: true,
  }),
  { path: "free" },
);

// C1: sticky Graph template + hard load after complete → free-in-envelope (not full Hard)
assert.deepEqual(
  resolveExpertWorkPath({
    hardMode: "hard",
    graphIntent: "app_assessment",
    continueInEnvelope: true,
  }),
  { path: "free" },
  "C1 continue-in-envelope skips full Hard schedule",
);
assert.deepEqual(
  resolveExpertWorkPath({
    hardMode: "hard",
    graphIntent: "redteam_deep",
    continueInEnvelope: true,
  }),
  { path: "free" },
  "C1 deep continue skips full Hard schedule",
);
assert.deepEqual(
  resolveExpertWorkPath({
    hardMode: "hard",
    graphIntent: "app_assessment",
    continueInEnvelope: false,
  }),
  { path: "hard" },
  "full Graph run still enters Hard path",
);

assert.equal(parseGraphExecution({ graph_execution: "continue" }), "continue");
assert.equal(parseGraphExecution({ graphExecution: "continue_chat" }), "continue");
assert.equal(parseGraphExecution({ graph_execution: "envelope" }), "continue");
assert.equal(parseGraphExecution({ graph_execution: "full" }), "full");
assert.equal(parseGraphExecution({ graph_execution: "run" }), "full");
assert.equal(parseGraphExecution({ graph_execution: "restart" }), "full");
assert.equal(parseGraphExecution({}), undefined);
assert.equal(parseGraphExecution(null), undefined);

assert.equal(isContinueInEnvelopeExecution({ graphExecution: "continue" }), true);
assert.equal(isContinueInEnvelopeExecution({ graphExecution: "full" }), false);
assert.equal(
  isContinueInEnvelopeExecution({ graphExecution: undefined }),
  false,
  "omit is not continue (first Graph run)",
);
assert.equal(
  isContinueInEnvelopeExecution({ graphExecution: "continue_chat" }),
  false,
  "unparsed synonyms are not continue — parse once at envelope boundary",
);

console.log("hard-graph-definition.test.ts: ok");
