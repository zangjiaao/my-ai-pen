/**
 * Stage-session observability: synthetic Pi events → checkpoint llm_usage (no live LLM).
 * Run: npx tsx src/runtime/hard-graph-stage-observability.test.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlatformMessage, ToolRuntime } from "../types.js";
import { TodoStore } from "../stores/todo.js";
import { GoalStore } from "../stores/goal.js";
import { EvidenceStore } from "../stores/evidence.js";
import { loadHardGraphFile } from "./hard-graph-definition.js";
import { createHardGraphStageExecutor } from "./hard-graph-stage-executor.js";
import { HardGraphPlanStore } from "./hard-graph-plan.js";
import { createUsageLedgerFromEnv } from "./platform-observability.js";
import { PanelAgentTracker } from "./panel-agents.js";
import type { Node4AgentSession } from "./run-node4-agent.js";

const repoExperts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../experts/pentest",
);

const graph = await loadHardGraphFile(repoExperts, "app_assessment_thin");
assert.ok(graph);
const initStage = graph!.stages.find((s) => s.id === "init");
assert.ok(initStage);

const messages: PlatformMessage[] = [];
const platform = {
  send: async (m: PlatformMessage) => {
    messages.push(m);
  },
};

const taskDir = await mkdtemp(join(tmpdir(), "hard-stage-obs-"));
const task = {
  taskId: "t-obs-stage",
  conversationId: "c-obs",
  instruction: "assess",
  target: { url: "http://t" },
  scope: {},
  graphDiscipline: "hard" as const,
  graphId: "app_assessment_thin",
  expertName: "渗透大师",
};

const pack = {
  id: "pentest",
  label: "Pentest",
  missionLines: [],
  toolNames: ["todo", "write", "read", "fact"],
};

const plan = new HardGraphPlanStore(graph!);
const runUsage = createUsageLedgerFromEnv();
const panel = new PanelAgentTracker(task.instruction, "渗透大师");

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
  lifecycle: {
    toolsInLastSegment: 0,
    subagentDepth: 0,
    hardGraphRun: { plan, usage: runUsage, panel },
    panelAgents: panel,
  },
} as ToolRuntime;

/** Fake session: subscribe stores listener; prompt fires synthetic usage events. */
function createFakeSession(workDir: string): Node4AgentSession {
  const listeners: Array<(event: unknown) => void | Promise<void>> = [];
  return {
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt(_text: string) {
      const emit = async (event: unknown) => {
        for (const l of listeners) await l(event);
      };
      // Avoid tool_execution_* first: those mark the checkpoint throttle and can
      // block the immediate message_end usage checkpoint within minIntervalMs.
      await emit({
        type: "message_end",
        message: {
          role: "assistant",
          model: "fake-obs-model",
          content: [{ type: "text", text: "stage done" }],
          usage: {
            input: 1200,
            output: 300,
            cacheRead: 0,
            totalTokens: 1500,
            cost: { total: 0.002 },
          },
        },
      });
      // Spec #125: stage Feedback is host settlement (no result.json required).
      // Session narrative alone is enough for init summary when no packages/require extras.
      await mkdir(workDir, { recursive: true });
    },
    abort() {},
    dispose() {},
    steer() {},
    followUp() {},
    messages: [],
  };
}

const executor = createHardGraphStageExecutor({
  config: {
    workspaceDir: taskDir,
    piAgentDir: join(taskDir, "pi"),
    modelId: "test",
    modelProvider: "openai",
  } as any,
  parentRuntime,
  pack: pack as any,
  boundSessionFactory: async ({ runtime }) => ({
    session: createFakeSession(runtime.piDir),
  }),
});

const out = await executor({
  graphId: graph!.id,
  stage: initStage!,
  stageIndex: 0,
  attempt: 1,
  tools: ["todo", "write", "read", "fact"],
  handoff: {
    summary: "",
    surfaces: [],
    candidates: [],
    deadends: [],
    completed_stages: [],
  },
});

// Init requires summary; fake session has no process facts → may fail summary gate.
// Observability contract is checkpoint/usage emission regardless of stage gate outcome.
assert.ok(out.structured, "host settlement projection present");

const checkpoints = messages.filter((m) => m.type === "checkpoint_update");
assert.ok(checkpoints.length >= 1, "checkpoint_update emitted during stage");

const withUsage = checkpoints.find((m) => {
  const u = (m as any).checkpoint?.llm_usage;
  return u && (Number(u.total_tokens) > 0 || Number(u.requests) > 0);
});
assert.ok(withUsage, "checkpoint has llm_usage total_tokens or requests > 0");
const usage = (withUsage as any).checkpoint.llm_usage;
assert.ok(
  Number(usage.total_tokens) >= 1500 || Number(usage.requests) >= 1,
  `expected usage from synthetic message_end, got ${JSON.stringify(usage)}`,
);

// Run-level ledger merged after stage.
const merged = runUsage.snapshot();
assert.ok(
  merged.total_tokens >= 1500 || merged.requests >= 1,
  "hardGraphRun.usage merged stage tokens",
);

// plan_tree on checkpoint uses hardGraphRun.plan (L1 stages present).
const planTree = (withUsage as any).checkpoint?.plan_tree as Array<{ level?: string }> | undefined;
assert.ok(Array.isArray(planTree) && planTree.some((n) => n.level === "phase"), "L1 phases in checkpoint plan_tree");

console.log("hard-graph-stage-observability.test.ts: ok");
