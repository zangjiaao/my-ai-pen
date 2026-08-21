/**
 * Spec #496: SubagentHost must emit the live Task id (parked continue rebound).
 * Run: npx tsx src/runtime/subagent-host-task.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentHost } from "./subagent.js";
import { GoalStore } from "../stores/goal.js";
import { PanelAgentTracker } from "./panel-agents.js";
import type { PlatformMessage, TaskEnvelope } from "../types.js";

const messages: PlatformMessage[] = [];
const platform = {
  send: async (m: PlatformMessage) => {
    messages.push(m);
  },
};

const piDir = await mkdtemp(join(tmpdir(), "n4-host-task-"));
let live: TaskEnvelope = {
  taskId: "t-first-burst",
  conversationId: "c-496",
  instruction: "go",
  expertId: "e1",
  expertName: "Expert",
} as TaskEnvelope;

const host = new SubagentHost({
  task: () => live,
  piDir,
  evidence: {
    create: async () => ({ id: "ev1", path: "" }),
    read: async () => undefined,
    list: async () => [],
  },
  platform,
  goals: new GoalStore(),
  panelAgents: new PanelAgentTracker("Main", "Expert"),
});

live = {
  ...live,
  taskId: "t-continue-burst",
};

messages.length = 0;
const result = await host.spawn({
  assignment: "probe",
  label: "probe",
  worker: async () => ({ summary: "ok", data: {}, ok: true }),
});
assert.equal(result.ok, true);

const started = messages.filter((m) => m.type === "subagent_started");
assert.equal(started.length, 1);
assert.equal(
  String((started[0] as { task_id?: string }).task_id || ""),
  "t-continue-burst",
  "subagent_started must use live Task id, not the first-burst envelope",
);

const checkpoints = messages.filter((m) => m.type === "checkpoint_update");
assert.ok(checkpoints.length >= 1);
for (const cp of checkpoints) {
  const rec = cp as { task_id?: string; checkpoint?: { task_id?: string } };
  assert.equal(rec.task_id, "t-continue-burst");
  assert.equal(rec.checkpoint?.task_id, "t-continue-burst");
}

console.log("subagent-host-task.test.ts: ok");
