/**
 * Graph L1/L2 plan store — no wipe across stages.
 * Run: npx tsx src/runtime/hard-graph-plan.test.ts
 */
import assert from "node:assert/strict";
import {
  HardGraphPlanStore,
  emitHardGraphPlanTreeUpdate,
  scoreTodoGoalMatch,
  FUZZY_BIND_MIN_SCORE,
} from "./hard-graph-plan.js";
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
  owner_agent_name: "Worker 1",
  kind: "task",
  source: "plan",
});
tree = plan.toPlanTree();
const pkg = tree.find((n) => n.node_id === "pkg-sqli");
assert.ok(pkg);
assert.equal(pkg!.parent_id, "graph-stage-class_probe");
assert.equal((pkg as any).agent_id, "sub_sqli");

// Main-authored todos + explicit attach preferred over fuzzy.
plan.setStageTodos("class_probe", [
  { node_id: "todo-sqli", title: "SQL Injection (sqli)", status: "pending", level: "work_item", kind: "task", source: "plan" },
  { node_id: "todo-xss", title: "Reflected XSS (xss_r)", status: "pending", level: "work_item", kind: "task", source: "plan" },
]);
// pkg-* from before setStageTodos must be preserved
assert.ok(plan.toPlanTree().some((n) => n.node_id === "pkg-sqli"), "pkg preserved across setStageTodos");

const explicit = plan.attachWorker("class_probe", "todo-sqli", {
  agent_id: "sub_w2",
  owner_agent_name: "Worker 2",
  status: "running",
});
assert.equal(explicit, "todo-sqli");
const sqli = plan.toPlanTree().find((n) => n.node_id === "todo-sqli") as any;
assert.equal(sqli.owner_agent_name, "Worker 2");
assert.equal(sqli.agent_id, "sub_w2");
assert.equal(sqli.status, "running");

// Re-attach by agent_id updates status without fuzzy.
const re = plan.reattachWorkerByAgent("class_probe", {
  agent_id: "sub_w2",
  owner_agent_name: "Worker 2",
  status: "done",
});
assert.equal(re, "todo-sqli");
assert.equal((plan.toPlanTree().find((n) => n.node_id === "todo-sqli") as any).status, "done");

// Subsequent todo status update keeps Worker chip
plan.setStageTodos("class_probe", [
  { node_id: "todo-sqli", title: "SQL Injection (sqli)", status: "done", level: "work_item", kind: "task", source: "plan" },
  { node_id: "todo-xss", title: "Reflected XSS (xss_r)", status: "pending", level: "work_item", kind: "task", source: "plan" },
]);
const sqli2 = plan.toPlanTree().find((n) => n.node_id === "todo-sqli") as any;
assert.equal(sqli2.owner_agent_name, "Worker 2", "worker chip survives todo rewrite");
assert.equal(sqli2.status, "done");

// Fuzzy last-resort: free XSS row, strong title match.
const fuzzy = plan.bindWorkerToBestTodo("class_probe", {
  agent_id: "sub_w3",
  owner_agent_name: "Worker 3",
  goal: "Probe Reflected XSS (xss_r) at /vulnerabilities/xss_r/",
  status: "running",
});
assert.equal(fuzzy, "todo-xss");

// Never steal another worker's chip even with high score.
const steal = plan.bindWorkerToBestTodo("class_probe", {
  agent_id: "sub_thief",
  owner_agent_name: "Worker 9",
  goal: "SQL Injection (sqli) full probe",
  status: "running",
});
assert.equal(steal, null, "must not steal Worker 2's todo-sqli");
assert.equal((plan.toPlanTree().find((n) => n.node_id === "todo-sqli") as any).agent_id, "sub_w2");

// Weak shared-token goals must stay below fuzzy threshold.
const weakScore = scoreTodoGoalMatch("Authentication bypass", "Test authorization bypass flows");
assert.ok(weakScore < FUZZY_BIND_MIN_SCORE, `weak token score ${weakScore} should be < ${FUZZY_BIND_MIN_SCORE}`);

plan.setStageTodos("class_probe", [
  { node_id: "todo-sqli", title: "SQL Injection (sqli)", status: "done", level: "work_item", kind: "task", source: "plan", agent_id: "sub_w2", owner_agent_name: "Worker 2" },
  { node_id: "todo-xss", title: "Reflected XSS (xss_r)", status: "running", level: "work_item", kind: "task", source: "plan", agent_id: "sub_w3", owner_agent_name: "Worker 3" },
  { node_id: "todo-auth", title: "Session management", status: "pending", level: "work_item", kind: "task", source: "plan" },
]);
const weakBind = plan.bindWorkerToBestTodo("class_probe", {
  agent_id: "sub_weak",
  owner_agent_name: "Worker 4",
  goal: "Generic testing work",
  status: "running",
});
assert.equal(weakBind, null, "weak goal must not bind");

plan.removeStageWorkItem("class_probe", "pkg-sqli");
assert.ok(!plan.toPlanTree().some((n) => n.node_id === "pkg-sqli"));

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
