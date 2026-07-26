/**
 * #72 Mature Expert hard Task Graph profile.
 * Run: npx tsx src/runtime/hard-graph-mature.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HARD_GRAPH_ID,
  applyHardGraphToolProfile,
  isHardGraphDefinition,
  listHardGraphIds,
  loadHardGraphFile,
  resolveHardGraph,
} from "./hard-graph-definition.js";
import { evaluateStageGate, runHardGraph } from "./hard-graph-runner.js";
import { normalizeSubagentResult } from "./subagent-result.js";

const repoExperts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../experts/pentest",
);

assert.equal(DEFAULT_HARD_GRAPH_ID, "app_assessment");

const mature = await loadHardGraphFile(repoExperts, "app_assessment");
assert.ok(mature, "mature hard graph loads");
assert.equal(mature!.discipline, "hard");
assert.equal(mature!.id, "app_assessment");
assert.ok(isHardGraphDefinition(mature));

const stageIds = mature!.stages.map((s) => s.id);
const required = [
  "init",
  "surface",
  "auth_session",
  "class_probe",
  "authz_logic",
  "component",
  "validate_book",
];
for (const id of required) {
  assert.ok(stageIds.includes(id), `mature stage set includes ${id}`);
}
assert.ok(stageIds.length > 4, "mature has more stages than thin");

// Tool roles
const probeAct = ["shell", "http", "write", "subagent"];
const bookOnly = ["finding", "write"];
for (const id of ["surface", "auth_session", "class_probe", "authz_logic", "component"]) {
  const st = mature!.stages.find((s) => s.id === id)!;
  const tools = applyHardGraphToolProfile(
    ["todo", "write", "shell", "http", "subagent", "finding", "skill"],
    st.tools,
  );
  // write may remain on allowlists for notes; not a result.json handoff prerequisite (#125)
  if (st.tools?.allow?.includes("write")) {
    assert.ok(tools.includes("write"), `${id} keeps write when listed`);
  }
  if (id === "class_probe" || id === "auth_session" || id === "authz_logic" || id === "component") {
    assert.ok(tools.includes("subagent"), `${id} declares Agent Graph eligibility`);
  }
  for (const t of probeAct) {
    if (t === "subagent" && id === "surface") continue;
    if (st.tools?.allow?.includes(t)) {
      assert.ok(tools.includes(t), `${id} keeps act tool ${t}`);
    }
  }
  assert.ok(!tools.includes("finding"), `${id} does not book`);
}
const book = mature!.stages.find((s) => s.id === "validate_book")!;
const bookTools = applyHardGraphToolProfile(
  ["todo", "write", "shell", "http", "subagent", "finding", "skill"],
  book.tools,
);
assert.ok(bookTools.includes("finding"));
assert.ok(bookTools.includes("write"));
assert.ok(!bookTools.includes("shell"));
assert.ok(!bookTools.includes("subagent"));

// Thin remains lab alias
const thin = await loadHardGraphFile(repoExperts, "app_assessment_thin");
assert.ok(thin);
assert.equal(thin!.stages.length, 4);
assert.ok(thin!.label.toLowerCase().includes("lab") || thin!.label.includes("薄") || thin!.id.includes("thin"));

const ids = await listHardGraphIds(repoExperts);
assert.ok(ids.includes("app_assessment"));
assert.ok(ids.includes("app_assessment_thin"));

// Resolve: product app_assessment → mature Expert Graph (Soft retired #76)
const productAssess = await resolveHardGraph({
  task: { graphId: "app_assessment" },
  packRoot: repoExperts,
  packId: "pentest",
  env: {},
});
assert.equal(productAssess.mode, "hard", "product app_assessment is Expert Graph");
if (productAssess.mode === "hard") {
  assert.equal(productAssess.graph.id, "app_assessment");
}

// Resolve: discipline hard → mature primary
const rHard = await resolveHardGraph({
  task: { graphDiscipline: "hard" },
  packRoot: repoExperts,
  packId: "pentest",
  env: {},
});
assert.equal(rHard.mode, "hard");
if (rHard.mode === "hard") {
  assert.equal(rHard.graph.id, "app_assessment");
}

// Resolve: explicit thin lab
const rThin = await resolveHardGraph({
  task: { graphId: "app_assessment_thin" },
  packRoot: repoExperts,
  packId: "pentest",
  env: {},
});
assert.equal(rThin.mode, "hard");
if (rThin.mode === "hard") {
  assert.equal(rThin.graph.id, "app_assessment_thin");
}

// Runner multi-stage handoff fixture (no live LLM)
const available = ["todo", "read", "fact", "skill", "write", "shell", "http", "session", "subagent", "finding"];
const result = await runHardGraph({
  graph: mature!,
  availableTools: available,
  executeStage: async (input) => {
    const stage = input.stage.id;
    if (stage === "init") {
      return {
        structured: normalizeSubagentResult({
          ok: true,
          summary: "init ok target in scope",
          surfaces: [],
          candidates: [],
        }),
      };
    }
    if (stage === "surface") {
      return {
        structured: normalizeSubagentResult({
          ok: true,
          summary: "surface mapped",
          surfaces: [{ location: "http://127.0.0.1:3010/", kind: "webapp" }],
          candidates: [],
        }),
      };
    }
    if (stage === "validate_book") {
      return {
        structured: normalizeSubagentResult({
          ok: true,
          summary: "booked from handoff",
          surfaces: [],
          candidates: [
            {
              title: "demo",
              location: "http://127.0.0.1:3010/rest/user/login",
              judgment: "confirmed",
            },
          ],
        }),
      };
    }
    // auth_session, class_probe, authz_logic, component
    return {
      structured: normalizeSubagentResult({
        ok: true,
        summary: `${stage} complete with honest coverage`,
        surfaces: input.handoff.surfaces.slice(0, 5),
        candidates:
          stage === "class_probe"
            ? [
                {
                  title: "Login SQLi",
                  location: "http://127.0.0.1:3010/rest/user/login",
                  proof_excerpt:
                    "POST login with SQLi email returns 200 JWT admin token in JSON body response",
                },
              ]
            : [],
        deadends: stage === "component" ? ["no rce surface"] : [],
      }),
    };
  },
});

assert.equal(result.terminal, "completed");
assert.equal(result.stages.length, mature!.stages.length);
assert.ok(result.stages.every((s) => s.outcome === "passed"));
assert.ok(result.handoff.surfaces.length >= 1);
assert.ok(result.handoff.candidates.length >= 1);

// Gate smoke: missing surfaces fails surface stage require
const surfaceStage = mature!.stages.find((s) => s.id === "surface")!;
const gate = evaluateStageGate(
  surfaceStage,
  normalizeSubagentResult({ ok: true, summary: "no surfaces", surfaces: [] }),
);
assert.equal(gate.ok, false);

console.log("hard-graph-mature.test.ts: ok");
