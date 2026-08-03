/**
 * Spec #281 — Graph stage-local todo(init) alias + neutralize.
 * Run: npx tsx src/runtime/graph-stage-todo-scope.test.ts
 */
import assert from "node:assert/strict";
import {
  graphStageLocalTodoInitError,
  isWholeEngagementTodoInitOnGraph,
  normalizePhaseLabel,
  phaseMatchesGraphStage,
} from "./graph-stage-todo-scope.js";
import { HardGraphPlanStore } from "./hard-graph-plan.js";
import type { HardGraphDefinition } from "./hard-graph-definition.js";

// --- normalize (unicode / CJK preserved) ---
assert.equal(normalizePhaseLabel(" Init-Stage "), "initstage");
assert.equal(normalizePhaseLabel("初始化"), "初始化");

// --- exact + real suffix aliases ---
assert.equal(phaseMatchesGraphStage("init", "init"), true);
assert.equal(phaseMatchesGraphStage("Init Stage", "init"), true, "stage + words suffix");
assert.equal(phaseMatchesGraphStage("init-checklist", "init"), true, "stage-separator-suffix");
assert.equal(phaseMatchesGraphStage("surface-enum", "surface"), true);

// --- reject non-aliases (bidirectional includes would wrongly pass some of these) ---
assert.equal(phaseMatchesGraphStage("recon", "init"), false);
assert.equal(phaseMatchesGraphStage("auth", "init"), false);
assert.equal(phaseMatchesGraphStage("vuln", "init"), false);
assert.equal(phaseMatchesGraphStage("minit", "init"), false, "mid/end substring is not an alias");
assert.equal(phaseMatchesGraphStage("surface", "face"), false, "stage fragment inside longer name");
assert.equal(phaseMatchesGraphStage("pathauth", "auth"), false, "suffix-only coincidence");
assert.equal(phaseMatchesGraphStage("", "init"), false);
assert.equal(phaseMatchesGraphStage("init", ""), false);

// --- single-phase always stage-local (any free label) ---
assert.equal(
  isWholeEngagementTodoInitOnGraph(
    [{ phase: "init", items: ["Confirm RoE", "Build plan"] }],
    "init",
  ),
  false,
  "single phase ok",
);
assert.equal(
  isWholeEngagementTodoInitOnGraph(
    [{ phase: "Web recon", items: ["Map hosts"] }],
    "init",
  ),
  false,
  "single free label always ok on Graph",
);
assert.equal(
  isWholeEngagementTodoInitOnGraph([{ phase: "初始化清单", items: ["确认范围"] }], "surface"),
  false,
  "single Chinese free label ok",
);

// --- multi-phase whole engagement map rejected ---
assert.equal(
  isWholeEngagementTodoInitOnGraph(
    [
      { phase: "init", items: ["RoE"] },
      { phase: "recon", items: ["Web recon"] },
      { phase: "auth", items: ["Login"] },
      { phase: "vuln", items: ["Scan"] },
    ],
    "init",
  ),
  true,
  "multi-phase whole map rejected",
);

// --- multi-phase real stage aliases still ok ---
assert.equal(
  isWholeEngagementTodoInitOnGraph(
    [
      { phase: "init", items: ["a"] },
      { phase: "init-checklist", items: ["b"] },
    ],
    "init",
  ),
  false,
  "multi-phase all real aliases of stage id ok",
);

// --- multi-phase weak contains must NOT pass (regression on bidirectional includes) ---
assert.equal(
  isWholeEngagementTodoInitOnGraph(
    [
      { phase: "init", items: ["a"] },
      { phase: "minit", items: ["b"] },
      { phase: "finish", items: ["c"] },
    ],
    "init",
  ),
  true,
  "weak substring multi-phase is whole-engagement (reject)",
);
assert.equal(
  isWholeEngagementTodoInitOnGraph(
    [
      { phase: "init", items: ["a"] },
      { phase: "recon", items: ["Web recon"] },
    ],
    "init",
  ),
  true,
  "init+recon multi-phase rejected while stage is init",
);

assert.match(graphStageLocalTodoInitError("surface"), /surface/);

// Neutralize running L2 on stage end
const def = {
  id: "app_assessment",
  stages: [{ id: "init" }, { id: "surface" }],
} as HardGraphDefinition;
const plan = new HardGraphPlanStore(def);
plan.setStageStatus("init", "running");
plan.setStageTodos("init", [
  { node_id: "todo-a", title: "RoE", status: "done", level: "work_item" },
  { node_id: "todo-b", title: "Web recon", status: "running", level: "work_item" },
]);
plan.neutralizeOpenRunningL2("init");
plan.setStageStatus("init", "done");
const tree = plan.toPlanTree();
const recon = tree.find((n) => n.node_id === "todo-b" || n.title === "Web recon");
assert.ok(recon, "recon row exists");
assert.equal(String(recon!.status), "pending", "running L2 neutralized to pending");
const l1 = tree.find((n) => n.node_id === "graph-stage-init");
assert.equal(String(l1?.status), "done");

console.log("graph-stage-todo-scope.test.ts: ok");
