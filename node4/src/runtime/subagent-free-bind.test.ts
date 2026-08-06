/**
 * Spec #301 — SubagentHost Free path auto-bind without a separate link tool.
 * Run: npx tsx src/runtime/subagent-free-bind.test.ts
 */
import assert from "node:assert/strict";
import { SubagentHost } from "./subagent.js";
import { TodoStore, todoTaskNodeId } from "../stores/todo.js";
import { GoalStore } from "../stores/goal.js";
import { PanelAgentTracker } from "./panel-agents.js";
import { HardGraphPlanStore } from "./hard-graph-plan.js";
import type { HardGraphDefinition } from "./hard-graph-definition.js";
import type { PlatformMessage } from "../types.js";

const messages: PlatformMessage[] = [];
const platform = {
  send: async (m: PlatformMessage) => {
    messages.push(m);
  },
};

const task = {
  taskId: "t-free-bind",
  conversationId: "c-free",
  instruction: "assess",
  expertId: "e1",
  expertName: "Expert",
} as any;

const todo = new TodoStore();
todo.apply({
  op: "init",
  list: [
    {
      phase: "Tasks",
      items: ["Probe level1 SQLi", "Probe level2 RCE"],
    },
  ],
});
const sqliId = todoTaskNodeId("Tasks", "Probe level1 SQLi");

const panel = new PanelAgentTracker("Free bind test", "Expert");
const goals = new GoalStore();

const host = new SubagentHost({
  task,
  taskDir: "/tmp/subagent-free-bind",
  evidence: {
    create: async () => ({ id: "ev1", path: "" }),
    read: async () => undefined,
    list: async () => [],
  },
  platform,
  goals,
  panelAgents: panel,
  todo: () => todo,
});

messages.length = 0;
const result = await host.spawn({
  assignment: "Probe level1 SQLi on target",
  label: "Probe level1 SQLi",
  planNodeId: sqliId,
  worker: async () => ({ summary: "done", data: {}, ok: true }),
});

assert.ok(result.ok);
assert.equal(result.planBind?.path, "explicit");
assert.equal(result.planBind?.node_id, sqliId);

const planMsgs = messages.filter((m) => m.type === "plan_tree_updated");
assert.ok(planMsgs.length >= 1, "Free spawn emits plan_tree_updated");
// Start emit should show running; final emit after worker end should show done.
const firstTree = (planMsgs[0] as { plan_tree?: Array<Record<string, unknown>> }).plan_tree || [];
const firstBound = firstTree.find((n) => String(n.node_id || "") === sqliId);
assert.ok(firstBound, "bound work item present on start");
assert.equal(firstBound?.status, "running", "Free start chip status running");
const lastTree = (planMsgs[planMsgs.length - 1] as { plan_tree?: Array<Record<string, unknown>> })
  .plan_tree || [];
const bound = lastTree.find((n) => String(n.node_id || "") === sqliId);
assert.ok(bound, "bound work item present");
assert.equal(bound?.agent_id, result.subagentId);
assert.ok(
  String(bound?.owner_agent_name || "").match(/^Worker\s+\d+$/i),
  `owner_agent_name Worker N, got ${bound?.owner_agent_name}`,
);
assert.equal(bound?.linked_agent_id, result.subagentId);
assert.equal(bound?.status, "done", "Free end chip status done without Main link tool");

// Without plan_node_id: host binds via single_free/fuzzy on start; end reattaches same agent.
messages.length = 0;
const r2 = await host.spawn({
  assignment: "Probe level2 RCE carefully",
  label: "Probe level2 RCE",
  worker: async () => ({ summary: "ok", data: {}, ok: true }),
});
const rceId = todoTaskNodeId("Tasks", "Probe level2 RCE");
assert.ok(r2.planBind?.path && r2.planBind.path !== "none", r2.planBind?.path);
assert.equal(r2.planBind?.node_id, rceId);
const rceNode = todo.toPlanNodes().find((n) => n.node_id === rceId) as {
  agent_id?: string;
  owner_agent_name?: string;
  status?: string;
};
assert.equal(rceNode?.agent_id, r2.subagentId);
assert.ok(String(rceNode?.owner_agent_name || "").match(/^Worker\s+\d+$/i));
assert.equal(rceNode?.status, "done");

// Failed package end → failed status on Free Main todo
const failTodo = new TodoStore();
failTodo.apply({
  op: "init",
  list: [{ phase: "Tasks", items: ["Will fail package"] }],
});
const failId = todoTaskNodeId("Tasks", "Will fail package");
const failHost = new SubagentHost({
  task,
  taskDir: "/tmp/subagent-free-fail",
  evidence: {
    create: async () => ({ id: "evf", path: "" }),
    read: async () => undefined,
    list: async () => [],
  },
  platform,
  goals: new GoalStore(),
  panelAgents: new PanelAgentTracker("Fail bind", "Expert"),
  todo: () => failTodo,
});
messages.length = 0;
const rFail = await failHost.spawn({
  assignment: "Will fail package",
  label: "Will fail package",
  planNodeId: failId,
  worker: async () => ({ summary: "boom", data: {}, ok: false }),
});
assert.equal(rFail.ok, false);
const failNode = failTodo.toPlanNodes().find((n) => n.node_id === failId) as {
  status?: string;
  agent_id?: string;
};
assert.equal(failNode?.agent_id, rFail.subagentId);
assert.equal(failNode?.status, "failed");

// Graph path still preferred when hardGraphPlan + stageId present (no Free overwrite)
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
    node_id: "todo-graph-a",
    title: "Graph L2 A",
    status: "pending",
    level: "work_item",
    kind: "task",
    source: "plan",
  },
]);
const freeOnly = new TodoStore();
freeOnly.apply({
  op: "init",
  list: [{ phase: "Tasks", items: ["Should not bind when Graph active"] }],
});
const graphHost = new SubagentHost({
  task,
  taskDir: "/tmp/subagent-graph-bind",
  evidence: {
    create: async () => ({ id: "ev2", path: "" }),
    read: async () => undefined,
    list: async () => [],
  },
  platform,
  goals: new GoalStore(),
  panelAgents: new PanelAgentTracker("Graph bind test", "Expert"),
  hardGraphPlan: () => plan,
  stageId: () => "class_probe",
  todo: () => freeOnly,
});
messages.length = 0;
const g = await graphHost.spawn({
  assignment: "Graph L2 A work",
  label: "Graph L2 A",
  planNodeId: "todo-graph-a",
  worker: async () => ({ summary: "g", data: {}, ok: true }),
});
assert.equal(g.planBind?.path, "explicit");
assert.equal(g.planBind?.node_id, "todo-graph-a");
const freeNodes = freeOnly.toPlanNodes().filter((n) => n.level === "work_item");
assert.ok(
  freeNodes.every((n) => !n.agent_id),
  "Free todos not stamped when Graph host path wins",
);

console.log("subagent-free-bind.test.ts: ok");
