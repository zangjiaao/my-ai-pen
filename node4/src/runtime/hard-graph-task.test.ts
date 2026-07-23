/**
 * Ownership inversion + observability + settlement (fake stage executor).
 * Run: npx tsx src/runtime/hard-graph-task.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadHardGraphFile } from "./hard-graph-definition.js";
import { runHardGraphExpertTask, emitHardGraphStageStatus } from "./hard-graph-task.js";
import type { HardGraphStageEvent } from "./hard-graph-runner.js";
import type { PlatformMessage, ToolRuntime } from "../types.js";
import { TodoStore } from "../stores/todo.js";
import { GoalStore } from "../stores/goal.js";
import { EvidenceStore } from "../stores/evidence.js";

const repoExperts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../experts/pentest",
);

const graph = await loadHardGraphFile(repoExperts, "app_assessment_thin");
assert.ok(graph);

const messages: PlatformMessage[] = [];
const platform = {
  send: async (m: PlatformMessage) => {
    messages.push(m);
  },
};

const taskDir = await mkdtemp(join(tmpdir(), "hard-graph-task-"));
const task = {
  taskId: "t-hard-1",
  conversationId: "c1",
  instruction: "assess",
  target: { url: "http://t" },
  scope: {},
  graphDiscipline: "hard" as const,
  graphId: "app_assessment_thin",
};

const pack = {
  id: "pentest",
  label: "Pentest",
  missionLines: [],
  toolNames: ["todo", "read", "fact", "skill", "shell", "http", "finding", "session", "browser", "script"],
};

const parentRuntime = {
  task,
  workspaceDir: taskDir,
  taskDir,
  platform,
  todo: new TodoStore(),
  evidence: new EvidenceStore(join(taskDir, "evidence")),
  findingsDir: join(taskDir, "findings"),
  goals: new GoalStore(),
  rolePackId: "pentest",
  lifecycle: { toolsInLastSegment: 0, subagentDepth: 0 },
} as ToolRuntime;

const fakeExecutor = async (input: {
  stage: { id: string };
  tools: string[];
}) => {
  if (input.stage.id === "init") {
    return { structured: { ok: true, summary: "init", surfaces: [], candidates: [] } };
  }
  if (input.stage.id === "surface") {
    assert.ok(input.tools.includes("shell") || input.tools.includes("http"));
    return {
      structured: {
        ok: true,
        summary: "surf",
        surfaces: [{ location: "http://t/" }],
        candidates: [],
      },
    };
  }
  return { structured: { ok: true, summary: input.stage.id, surfaces: [], candidates: [] } };
};

const result = await runHardGraphExpertTask({
  config: {
    workspaceDir: taskDir,
    piAgentDir: join(taskDir, "pi"),
    modelId: "test",
    modelProvider: "openai",
  } as any,
  platform,
  task,
  taskDir,
  pack: pack as any,
  graph: graph!,
  parentRuntime,
  stageExecutor: fakeExecutor as any,
});

assert.equal(result.terminal, "completed");
assert.equal(result.harnessStatus, "completed");
assert.equal(result.graphId, "app_assessment_thin");

// Single settlement dialect: exactly one task_complete
const completes = messages.filter((m) => m.type === "task_complete");
assert.equal(completes.length, 1);
assert.equal((completes[0] as any).status, "completed");
assert.equal((completes[0] as any).stop_reason, "hard_graph_completed");
assert.ok(String((completes[0] as any).work_mode).includes("hard_graph:app_assessment_thin"));

const workModes = messages
  .filter((m) => m.type === "work_status" || m.type === "status_update")
  .map((m) => String((m as any).work_mode || ""));
assert.ok(workModes.some((w) => w.startsWith("hard_graph:app_assessment_thin")));
assert.ok(workModes.some((w) => w.includes("surface")));

const raw = await readFile(join(taskDir, "hard-graph", "run-result.json"), "utf8");
const saved = JSON.parse(raw);
assert.equal(saved.terminal, "completed");

// emitHardGraphStageStatus unit — no as-any required for PlatformMessage
const ev: HardGraphStageEvent = {
  type: "stage_start",
  graphId: "g",
  stageId: "s1",
  stageIndex: 0,
  attempt: 1,
};
const more: PlatformMessage[] = [];
await emitHardGraphStageStatus({
  platform: { send: async (m) => { more.push(m); } },
  task,
  event: ev,
  startedAt: new Date().toISOString(),
});
assert.ok(more.some((m) => m.type === "work_status"));
assert.equal((more.find((m) => m.type === "status_update") as any)?.hard_graph?.stage_id, "s1");

console.log("hard-graph-task.test.ts: ok");
