/**
 * Spec #281 — Graph stage-local todo(init).
 * Run: npx tsx src/runtime/graph-stage-todo-scope.test.ts
 */
import assert from "node:assert/strict";
import {
  graphStageLocalTodoInitError,
  isWholeEngagementTodoInitOnGraph,
  phaseMatchesGraphStage,
} from "./graph-stage-todo-scope.js";
import { HardGraphPlanStore } from "./hard-graph-plan.js";
import type { HardGraphDefinition } from "./hard-graph-definition.js";

assert.equal(phaseMatchesGraphStage("init", "init"), true);
assert.equal(phaseMatchesGraphStage("Init Stage", "init"), true);
assert.equal(phaseMatchesGraphStage("recon", "init"), false);

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
    [
      { phase: "init", items: ["RoE"] },
      { phase: "recon", items: ["Web recon"] },
      { phase: "vuln", items: ["Scan"] },
    ],
    "init",
  ),
  true,
  "multi-phase whole map rejected",
);

assert.equal(
  isWholeEngagementTodoInitOnGraph(
    [
      { phase: "init", items: ["a"] },
      { phase: "init-checklist", items: ["b"] },
    ],
    "init",
  ),
  false,
  "multi-phase all matching stage id ok",
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
