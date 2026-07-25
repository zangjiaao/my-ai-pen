/**
 * Graph L1/L2 plan store — no wipe across stages.
 * Run: npx tsx src/runtime/hard-graph-plan.test.ts
 */
import assert from "node:assert/strict";
import { HardGraphPlanStore, emitHardGraphPlanTreeUpdate } from "./hard-graph-plan.js";
import type { HardGraphDefinition } from "./hard-graph-definition.js";
import type { PlatformMessage } from "../types.js";

const graph: HardGraphDefinition = {
  discipline: "hard",
  id: "test_graph",
  label: "Test Graph",
  stages: [
    { id: "init", success: "ok", require: { summary: true }, tools: { allow: ["todo"] }, max_retries: 0 },
    { id: "surface", success: "ok", require: { summary: true }, tools: { allow: ["todo"] }, max_retries: 0 },
    { id: "class_probe", success: "ok", require: { summary: true }, tools: { allow: ["todo", "subagent"] }, max_retries: 0 },
  ],
};

const plan = new HardGraphPlanStore(graph);
let tree = plan.toPlanTree();
const l1 = tree.filter((n) => n.level === "phase");
assert.equal(l1.length, 3, "L1 has all stages at start");
assert.ok(l1.every((n) => n.status === "pending"));
assert.ok(l1.every((n) => n.source === "plan"));

plan.setStageStatus("init", "running");
plan.setStageTodos("init", [
  { node_id: "todo-a", title: "Record RoE", status: "running", level: "work_item", kind: "task", source: "plan" },
  { node_id: "todo-b", title: "Handoff", status: "pending", level: "work_item", kind: "task", source: "plan" },
]);
tree = plan.toPlanTree();
assert.equal(tree.find((n) => n.node_id === "graph-stage-init")?.status, "running");
const initTodos = tree.filter((n) => n.parent_id === "graph-stage-init");
assert.equal(initTodos.length, 2);
assert.ok(initTodos.every((n) => n.parent_id === "graph-stage-init"));

plan.setStageStatus("init", "done");
plan.setStageTodos("init", [
  { node_id: "todo-a", title: "Record RoE", status: "done", level: "work_item", kind: "task", source: "plan" },
  { node_id: "todo-b", title: "Handoff", status: "done", level: "work_item", kind: "task", source: "plan" },
]);
plan.setStageStatus("surface", "running");
plan.setStageTodos("surface", [
  { node_id: "todo-s1", title: "Map URLs", status: "running", level: "work_item", kind: "task", source: "plan" },
]);
tree = plan.toPlanTree();
assert.equal(tree.find((n) => n.node_id === "graph-stage-init")?.status, "done");
assert.equal(tree.filter((n) => n.parent_id === "graph-stage-init").length, 2, "init L2 preserved");
assert.equal(tree.find((n) => n.node_id === "graph-stage-surface")?.status, "running");
assert.equal(tree.filter((n) => n.parent_id === "graph-stage-surface").length, 1);
// class_probe still pending with no wipe
assert.equal(tree.find((n) => n.node_id === "graph-stage-class_probe")?.status, "pending");

plan.upsertStageWorkItem("class_probe", {
  node_id: "pkg-sqli",
  title: "Package SQLi",
  status: "running",
  agent_id: "sub_sqli",
  owner_agent_name: "Subagent [sqli]",
  kind: "task",
  source: "plan",
});
tree = plan.toPlanTree();
const pkg = tree.find((n) => n.node_id === "pkg-sqli");
assert.ok(pkg);
assert.equal(pkg!.parent_id, "graph-stage-class_probe");
assert.equal((pkg as any).agent_id, "sub_sqli");

const messages: PlatformMessage[] = [];
await emitHardGraphPlanTreeUpdate(
  { send: async (m) => { messages.push(m); } },
  { taskId: "t1", conversationId: "c1", expertId: "e1", expertName: "渗透大师" } as any,
  plan,
  "stage.surface",
);
assert.equal(messages[0]?.type, "plan_tree_updated");
const emitted = (messages[0] as any).plan_tree as Array<{ level?: string; owner_expert_name?: string }>;
assert.ok(emitted.some((n) => n.level === "phase"));
assert.ok(emitted.every((n) => !n.owner_expert_name || n.owner_expert_name === "渗透大师"));

console.log("hard-graph-plan.test.ts: ok");
