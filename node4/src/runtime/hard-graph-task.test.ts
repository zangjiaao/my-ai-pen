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
  toolNames: [
    "todo",
    "read",
    "fact",
    "skill",
    "shell",
    "http",
    "finding",
    "session",
    "browser",
    "script",
    "hypothesis",
  ],
  capabilities: { hypothesis_work_mode: true },
};

const parentRuntime = {
  task,
  workspaceDir: taskDir,
  piDir: taskDir,
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
  caseDir: taskDir,
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

// Graph L1 plan emitted at start (all stages) — #100
const plans = messages.filter((m) => m.type === "plan_tree_updated");
assert.ok(plans.length >= 1, "plan_tree_updated at graph start");
const firstPlan = (plans[0] as any).plan_tree as Array<{ level?: string; title?: string; status?: string }>;
const phases = firstPlan.filter((n) => n.level === "phase");
assert.ok(phases.length >= 2, "L1 has Graph stages");
assert.ok(phases.every((p) => p.status === "pending" || p.status === "running" || p.status === "done"));

// Terminal checkpoint for Status tokens/panel (#99)
const checkpoints = messages.filter((m) => m.type === "checkpoint_update");
assert.ok(checkpoints.length >= 1, "terminal checkpoint_update");

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

// skipped stage_end → plan status "skipped" (not blocked)
{
  const { HardGraphPlanStore } = await import("./hard-graph-plan.js");
  const plan = new HardGraphPlanStore(graph!);
  const planMsgs: PlatformMessage[] = [];
  const skipEv: HardGraphStageEvent = {
    type: "stage_end",
    graphId: graph!.id,
    stageId: "class_probe",
    stageIndex: 2,
    attempt: 0,
    outcome: "skipped",
    errors: ["skipped_after_upstream_blocked"],
  };
  await emitHardGraphStageStatus({
    platform: { send: async (m) => { planMsgs.push(m); } },
    task,
    event: skipEv,
    startedAt: new Date().toISOString(),
    plan,
  });
  const stageNode = plan.toPlanTree().find(
    (n) => String(n.title || "") === "class_probe" || String(n.node_id || "").includes("class_probe"),
  );
  assert.equal(
    stageNode?.status,
    "skipped",
    "skipped stage_end must map plan status to skipped not blocked",
  );
}

// Settlement contract: LlmTurnError mid-stage → no task_complete; plan not left running; rethrow
{
  const { LlmTurnError, isLlmTurnError } = await import("./llm-turn-error.js");
  const llmMsgs: PlatformMessage[] = [];
  const llmPlatform = {
    send: async (m: PlatformMessage) => {
      llmMsgs.push(m);
    },
  };
  const llmTaskDir = await mkdtemp(join(tmpdir(), "hard-graph-llm-"));
  const llmRuntime = {
    task,
    workspaceDir: llmTaskDir,
    piDir: llmTaskDir,
    platform: llmPlatform,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(llmTaskDir, "evidence")),
    findingsDir: join(llmTaskDir, "findings"),
    goals: new GoalStore(),
    rolePackId: "pentest",
    lifecycle: { toolsInLastSegment: 0, subagentDepth: 0 },
  } as ToolRuntime;

  const llmExecutor = async (input: { stage: { id: string } }) => {
    if (input.stage.id === "init") {
      return { structured: { ok: true, summary: "init", surfaces: [], candidates: [] } };
    }
    throw new LlmTurnError("403 model not available in region");
  };

  let caught: unknown;
  try {
    await runHardGraphExpertTask({
      config: {
        workspaceDir: llmTaskDir,
        piAgentDir: join(llmTaskDir, "pi"),
        modelId: "test",
        modelProvider: "openai",
      } as any,
      platform: llmPlatform,
      task: { ...task, taskId: "t-hard-llm" },
      caseDir: llmTaskDir,
      pack: pack as any,
      graph: graph!,
      parentRuntime: llmRuntime,
      stageExecutor: llmExecutor as any,
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(isLlmTurnError(caught), "LlmTurnError must reach outer (main task_error)");
  const completes = llmMsgs.filter((m) => m.type === "task_complete");
  assert.equal(completes.length, 0, "hard graph settle must not emit task_complete on LlmTurnError");
  // Plan: failing stage must not remain running
  const planTrees = llmMsgs
    .filter((m) => m.type === "plan_tree_updated")
    .map((m) => (m as any).plan_tree as Array<{ node_id?: string; title?: string; status?: string }>);
  assert.ok(planTrees.length >= 1, "plan updates emitted");
  const lastPlan = planTrees[planTrees.length - 1] || [];
  const surfaceNode = lastPlan.find(
    (n) =>
      String(n.title || "") === "surface" ||
      String(n.node_id || "").includes("surface"),
  );
  assert.ok(surfaceNode, "surface stage present in plan");
  assert.notEqual(
    surfaceNode?.status,
    "running",
    "LlmTurnError must not leave stage status running",
  );
  assert.ok(
    surfaceNode?.status === "blocked" || surfaceNode?.status === "failed",
    `expected blocked/failed, got ${surfaceNode?.status}`,
  );
  // Terminal checkpoint failed (Status panel)
  const cps = llmMsgs.filter((m) => m.type === "checkpoint_update");
  assert.ok(cps.length >= 1, "failed terminal checkpoint");
  const lastCp = cps[cps.length - 1] as any;
  assert.equal(lastCp.status || lastCp.checkpoint?.status, "failed");
}

// Free-path settlement harness: soft-error extract → LlmTurnError (single channel; no task_complete)
{
  const { extractLlmTurnError, LlmTurnError, isLlmTurnError } = await import("./llm-turn-error.js");
  const softMsgs = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      stopReason: "error",
      errorMessage: "403 China opt in",
      content: [],
    },
  ];
  const errText = extractLlmTurnError(softMsgs);
  assert.ok(errText);
  // Thin harness of session-runner assert path: throw LlmTurnError, never invent task_complete
  const emitted: Array<{ type: string }> = [];
  const assertPath = (messages: unknown[]) => {
    const t = extractLlmTurnError(messages);
    if (!t) return "ok";
    emitted.push({ type: "status_update" });
    throw new LlmTurnError(t);
  };
  let freeCaught: unknown;
  try {
    assertPath(softMsgs);
    emitted.push({ type: "task_complete" }); // must not reach
  } catch (err) {
    freeCaught = err;
  }
  assert.ok(isLlmTurnError(freeCaught));
  assert.equal(emitted.filter((e) => e.type === "task_complete").length, 0);
  assert.equal(emitted.filter((e) => e.type === "status_update").length, 1);
  // Normal end_turn must not trip assert path
  assert.equal(
    assertPath([{ role: "assistant", stopReason: "end_turn", content: [] }]),
    "ok",
  );
}

console.log("hard-graph-task.test.ts: ok");
