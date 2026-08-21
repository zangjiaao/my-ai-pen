/**
 * Case d84fb991: Host must not invent Tasks rows when spawn has no Case todo to bind.
 * Run: npx tsx src/runtime/subagent-todo-chip.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentHost } from "./subagent.js";
import { GoalStore } from "../stores/goal.js";
import { PanelAgentTracker } from "./panel-agents.js";
import { TodoStore } from "../stores/todo.js";
import type { PlatformMessage, TaskEnvelope } from "../types.js";

const messages: PlatformMessage[] = [];
const platform = {
  send: async (m: PlatformMessage) => {
    messages.push(m);
  },
};

const piDir = await mkdtemp(join(tmpdir(), "n4-todo-chip-"));
const todo = new TodoStore();
const task = {
  taskId: "t-chip",
  conversationId: "c-chip",
  instruction: "ping",
  expertId: "e1",
  expertName: "渗透大师",
} as TaskEnvelope;

const host = new SubagentHost({
  task: () => task,
  piDir,
  evidence: {
    create: async () => ({ id: "ev1", path: "" }),
    read: async () => undefined,
    list: async () => [],
  },
  platform,
  goals: new GoalStore(),
  panelAgents: new PanelAgentTracker("Main", "渗透大师"),
  todo: () => todo,
});

const ping4 = await host.spawn({
  assignment: "reply ping4",
  label: "回复 ping4",
  subagentId: "sub_10",
  worker: async () => ({ summary: "pong4", data: {}, ok: true }),
});
assert.equal(ping4.ok, true);
assert.equal(ping4.planBind, undefined, "no Case todo → no plan_bind");

const workItems = todo.toPlanNodes().filter((n) => n.level === "work_item");
assert.equal(workItems.length, 0, "host must not invent pkg-* Tasks rows");

const plans = messages.filter((m) => m.type === "plan_tree_updated");
assert.equal(plans.length, 0, "no plan_tree_updated when nothing bound");

const started = messages.filter((m) => m.type === "subagent_started");
assert.equal(started.length, 1, "Worker still appears on collab tree");

console.log("subagent-todo-chip.test.ts: ok");
