/**
 * Hard vs soft graph definition seam.
 * Run: npx tsx src/runtime/hard-graph-definition.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyHardGraphToolProfile,
  buildProductGraphL1Catalog,
  formatGraphL1CatalogInjection,
  graphL1EntryFromDefinition,
  isContinueInEnvelopeExecution,
  isHardGraphDefinition,
  isSoftScenarioGraphDefinition,
  isThinGraphId,
  listHardGraphIds,
  loadHardGraphFile,
  loadProductGraphL1Catalog,
  loadSoftScenarioGraphFile,
  parseGraphExecution,
  resolveExpertWorkPath,
  resolveHardGraph,
  validateHypothesisWorkModeForGraph,
} from "./hard-graph-definition.js";
import { loadPackFromDirSync } from "../experts/load-pack.js";

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

// Spec #274: hypothesis_work_mode on stages + pack availability fail-closed
const mature = await loadHardGraphFile(repoExperts, "app_assessment");
assert.ok(mature);
const probeStage = mature!.stages.find((s) => s.id === "class_probe");
assert.equal(probeStage?.hypothesis_work_mode, true, "reference probe stage enables mode");
const initStage = mature!.stages.find((s) => s.id === "init");
assert.notEqual(initStage?.hypothesis_work_mode, true, "init does not enable mode");
const bookStage = mature!.stages.find((s) => s.id === "validate_book");
assert.notEqual(bookStage?.hypothesis_work_mode, true, "validate_book does not enable mode");

const pack = loadPackFromDirSync(repoExperts);
assert.equal(pack.capabilities?.hypothesis_work_mode, true);
const hypOk = validateHypothesisWorkModeForGraph(mature!, true);
assert.equal(hypOk.ok, true);
const hypFail = validateHypothesisWorkModeForGraph(mature!, false);
assert.equal(hypFail.ok, false);

// Spec #278 S1: product Graph L1 catalog (thin excluded; when_to_use present)
assert.equal(isThinGraphId("app_assessment_thin"), true);
assert.equal(isThinGraphId("app_assessment"), false);
const pureL1 = buildProductGraphL1Catalog([
  {
    id: "app_assessment",
    label: "应用评估",
    when_to_use: "full multi-class assessment",
    roe: { allow_postex: false },
  },
  {
    id: "app_assessment_thin",
    label: "thin lab",
    when_to_use: "lab only",
    roe: { allow_postex: false },
  },
  {
    id: "redteam_deep",
    label: "红队深度",
    description: "deep with postex",
    roe: { allow_postex: true },
  },
]);
assert.deepEqual(
  pureL1.map((e) => e.id),
  ["app_assessment", "redteam_deep"],
  "thin excluded from product L1",
);
assert.equal(pureL1[0]!.when_to_use, "full multi-class assessment");
assert.equal(pureL1[1]!.when_to_use, "deep with postex", "description aliases when_to_use");
assert.equal(pureL1[0]!.allow_postex, false);
assert.equal(pureL1[1]!.allow_postex, true);

const loadedL1 = await loadProductGraphL1Catalog(repoExperts);
assert.ok(loadedL1.some((e) => e.id === "app_assessment"));
assert.ok(loadedL1.some((e) => e.id === "redteam_deep"));
assert.ok(!loadedL1.some((e) => e.id === "app_assessment_thin"), "pack load excludes thin");
const assessL1 = loadedL1.find((e) => e.id === "app_assessment")!;
assert.ok(assessL1.label.length > 0);
assert.ok(assessL1.when_to_use.length > 0, "authored when_to_use on product graph");
assert.equal(assessL1.allow_postex, false);
const deepL1 = loadedL1.find((e) => e.id === "redteam_deep")!;
assert.equal(deepL1.allow_postex, true);

const inj = formatGraphL1CatalogInjection(loadedL1, { mode: "free" });
assert.match(inj, /app_assessment/);
assert.match(inj, /redteam_deep/);
assert.match(inj, /enter_graph/);
assert.match(inj, /mode: free|Current harness: Free/i);
assert.ok(!inj.includes("app_assessment_thin"));

const row = graphL1EntryFromDefinition({
  id: "x",
  label: "L",
  when_to_use: "use me",
});
assert.equal(row?.when_to_use, "use me");

console.log("hard-graph-definition.test.ts: ok");
