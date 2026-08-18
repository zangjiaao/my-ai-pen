/**
 * Subagent local todos must not overwrite Expert Graph / Main Case Tasks plan_tree.
 * Regression: right-panel stage L1/L2 wiped when worker calls todo(init).
 * Run: npx tsx src/tools/todo-subagent-plan-tree.test.ts
 */
import assert from "node:assert/strict";
import { createTodoTool } from "./todo.js";
import { TodoStore } from "../stores/todo.js";
import type { ToolRuntime } from "../types.js";
import { HardGraphPlanStore } from "../runtime/hard-graph-plan.js";
import type { HardGraphDefinition } from "../runtime/hard-graph-definition.js";

const graph: HardGraphDefinition = {
  discipline: "hard",
  id: "app_assessment",
  stages: [
    {
      id: "class_probe",
      success: "ok",
      require: { summary: true },
      tools: { allow: ["todo", "subagent"] },
      max_retries: 0,
    },
  ],
};

const plan = new HardGraphPlanStore(graph);
plan.setStageStatus("class_probe", "running");
plan.setStageTodos("class_probe", [
  {
    node_id: "todo-sqli",
    title: "Probe SQLi on login",
    status: "running",
    level: "work_item",
    kind: "task",
    source: "plan",
  },
]);

const platformMessages: Array<Record<string, unknown>> = [];
const parentTask = {
  taskId: "t1",
  conversationId: "c1",
  instruction: "assess",
  expertId: "e1",
  expertName: "Expert",
};

// --- Main / stage captain (depth 0) with Graph: may emit Hard Graph plan_tree ---
const mainRuntime = {
  task: parentTask,
  workspaceDir: "/tmp",
  piDir: "/tmp",
  platform: {
    send: async (msg: Record<string, unknown>) => {
      platformMessages.push(msg);
    },
  },
  todo: new TodoStore(),
  evidence: { create: async () => ({ id: "e", path: "" }), read: async () => undefined, list: async () => [] },
  findingsDir: "/tmp/findings",
  goals: { get: () => undefined },
  lifecycle: {
    subagentDepth: 0,
    hardGraphRun: {
      plan,
      usage: {} as any,
      panel: {} as any,
      stageId: "class_probe",
    },
  },
} as unknown as ToolRuntime;

const mainTodo = createTodoTool(mainRuntime);
const mainExec = mainTodo.execute as (
  id: string,
  params: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text?: string }> }>;

await mainExec("x", {
  op: "init",
  list: [{ phase: "class_probe", items: ["Probe SQLi on login"] }],
});
const mainPlans = platformMessages.filter((m) => m.type === "plan_tree_updated");
assert.ok(mainPlans.length >= 1, "Main Graph todo emits plan_tree_updated");
const mainTree = (mainPlans[mainPlans.length - 1] as { plan_tree?: Array<{ level?: string }> }).plan_tree || [];
assert.ok(
  mainTree.some((n) => n.level === "phase" || String((n as { node_id?: string }).node_id || "").includes("stage")),
  "Main Graph plan_tree includes stage structure (or work items under graph)",
);

// --- Subagent (depth >= 1): local todo only — must NOT emit plan_tree_updated ---
platformMessages.length = 0;
const subRuntime = {
  task: { ...parentTask, taskId: "t1/sub/sub_1" },
  workspaceDir: "/tmp",
  piDir: "/tmp/sub",
  platform: {
    send: async (msg: Record<string, unknown>) => {
      platformMessages.push(msg);
    },
  },
  todo: new TodoStore(),
  evidence: { create: async () => ({ id: "e", path: "" }), read: async () => undefined, list: async () => [] },
  findingsDir: "/tmp/findings",
  goals: { get: () => undefined },
  lifecycle: {
    subagentDepth: 1,
    // No hardGraphRun — production subagent-session shape
  },
} as unknown as ToolRuntime;

const subTodo = createTodoTool(subRuntime);
const subExec = subTodo.execute as (
  id: string,
  params: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;

const subResult = await subExec("x", {
  op: "init",
  list: [{ phase: "worker", items: ["my local probe steps", "write result.json"] }],
});
// Tool still works locally
assert.ok(subResult);

const subPlans = platformMessages.filter((m) => m.type === "plan_tree_updated");
assert.equal(
  subPlans.length,
  0,
  "subagent todo must not emit plan_tree_updated (would wipe Case Graph Tasks)",
);

// Local todo still mutates (tool response has work_items) — optional: allow todo_updated for observability
const subTodos = platformMessages.filter((m) => m.type === "todo_updated");
// todo_updated is ok for logging; plan_tree is the right-panel SoT
void subTodos;

// --- Subagent that incorrectly inherited hardGraphRun must also not rewrite Graph L2 ---
platformMessages.length = 0;
const leakedGraphSub = {
  ...subRuntime,
  lifecycle: {
    subagentDepth: 1,
    hardGraphRun: {
      plan,
      usage: {} as any,
      panel: {} as any,
      stageId: "class_probe",
    },
  },
} as unknown as ToolRuntime;
const leakTodo = createTodoTool(leakedGraphSub);
const leakExec = leakTodo.execute as typeof subExec;
await leakExec("x", {
  op: "init",
  list: [{ phase: "worker", items: ["chore Write result.json"] }],
});
assert.equal(
  platformMessages.filter((m) => m.type === "plan_tree_updated").length,
  0,
  "depth>=1 never emits plan_tree even if hardGraphRun leaked",
);
// Graph L2 must still be the Main-authored SQLi row, not worker chore
const l2 = plan.toPlanTree().filter((n) => n.level === "work_item" && String(n.parent_id || "").includes("class_probe"));
assert.ok(
  l2.some((n) => String(n.title || "").includes("SQLi") || String(n.node_id || "").includes("sqli")),
  "Graph L2 not replaced by subagent local todos",
);

console.log("todo-subagent-plan-tree.test.ts: ok");
