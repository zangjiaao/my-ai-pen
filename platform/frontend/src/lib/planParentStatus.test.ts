/**
 * Parent Tasks status is Host-derived from children (not a second Agent todo.done).
 * Run: npx tsx src/lib/planParentStatus.test.ts
 */
import assert from "node:assert/strict";
import { deriveParentPlanStatus, isGraphStagePlanNode } from "./planParentStatus.ts";

assert.equal(
  deriveParentPlanStatus({
    children: [{ status: "done" }, { status: "done" }],
    ownStatus: "running",
  }),
  "done",
  "all children done → parent done even if own row still running",
);

assert.equal(
  deriveParentPlanStatus({
    children: [{ status: "done" }, { status: "pending" }],
    ownStatus: "pending",
  }),
  "partial",
  "mixed children → half-circle",
);

assert.equal(
  deriveParentPlanStatus({
    children: [{ status: "done" }, { status: "running" }],
    ownStatus: "running",
  }),
  "partial",
);

assert.equal(
  deriveParentPlanStatus({
    children: [{ status: "pending" }, { status: "pending" }],
    ownStatus: "running",
  }),
  "pending",
);

assert.equal(
  deriveParentPlanStatus({
    children: [{ status: "done" }, { status: "done" }],
    ownStatus: "running",
    graphStage: true,
  }),
  "running",
  "Graph L1 keeps runner status",
);

assert.equal(isGraphStagePlanNode({ node_id: "graph-stage-surface" }), true);
assert.equal(isGraphStagePlanNode({ node_id: "todo-phase-recon" }), false);

console.log("ok: deriveParentPlanStatus");
