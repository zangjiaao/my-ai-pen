/**
 * Graph Feedback Agent: typed L1 + stage-advance (not captain self-report).
 * Run: npx tsx src/runtime/hard-graph-feedback-agent.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRuntime } from "../types.js";
import {
  buildFeedbackUserPrompt,
  feedbackToolNames,
  parseFeedbackAgentDecision,
  parseL1Decision,
  runHardGraphFeedbackAgent,
} from "./hard-graph-feedback-agent.js";
import { createHardGraphStageExecutor } from "./hard-graph-stage-executor.js";
import { loadHardGraphFile } from "./hard-graph-definition.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TodoStore } from "../stores/todo.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { SurfaceLedgerStore } from "../stores/surface-ledger.js";
import { createProcessQualityState } from "./package-honesty-host.js";
import { PanelAgentTracker } from "./panel-agents.js";
import { createUsageLedgerFromEnv } from "./platform-observability.js";

assert.equal(parseL1Decision({ l1_decision: "refine" }), "refine");
assert.equal(parseL1Decision({ facts: [{ fact_key: "l1_decision", summary: "pass" }] }), "pass");
assert.equal(
  parseL1Decision({ notes: "please refine this stage" }),
  undefined,
  "must not scrape notes",
);

const paused = parseFeedbackAgentDecision({
  facts: [
    { fact_key: "l1_decision", summary: "pass" },
    { fact_key: "stage_advance", summary: "pause" },
  ],
});
assert.equal(paused.decision, "pass");
assert.equal(paused.stageAdvance, "pause");

const missing = parseFeedbackAgentDecision({});
assert.equal(missing.decision, "pass");
assert.equal(missing.stageAdvance, undefined);

const refined = parseFeedbackAgentDecision({
  facts: [{ fact_key: "l1_decision", summary: "refine", body: "empty yield" }],
});
assert.equal(refined.decision, "refine");

assert.deepEqual(feedbackToolNames(["todo", "shell", "fact", "finding", "http"]), [
  "fact",
  "finding",
]);
assert.ok(!feedbackToolNames(["shell", "http"]).includes("shell"));

const repoExperts = join(dirname(fileURLToPath(import.meta.url)), "../../../experts/pentest");
const graph = await loadHardGraphFile(repoExperts, "app_assessment_thin");
assert.ok(graph);
const initStage = graph!.stages.find((s) => s.id === "init")!;

{
  const playbook = [
    "init：本阶段结束后 stage_advance=continue。",
    "surface：本阶段结束后 stage_advance=pause（下一阶段是 auth_session，先问我）。",
  ].join(" ");
  const user = buildFeedbackUserPrompt({
    stage: initStage,
    l1Input: { stageId: "init" },
    instruction: playbook,
    nextStageId: "surface",
  });
  assert.match(user, /### Operator request/);
  assert.match(user, /init → surface/);
  assert.match(user, /If they asked to wait before THIS hop's next stage, vote pause/);
  assert.match(user, /A pause\/stop that names a later stage does not apply to this hop/);
  assert.doesNotMatch(user, /Do not copy stage_advance tokens/);
  assert.match(user, /stage_advance=pause/, "operator request still present");
}

{
  const dir = await mkdtemp(join(tmpdir(), "fb-agent-"));
  const pq = createProcessQualityState();
  const panel = new PanelAgentTracker("Main", "Expert");
  const runtime = {
    task: {
      taskId: "t-fb",
      conversationId: "c-fb",
      instruction: "JuiceShop assessment",
      workspaceDir: dir,
      expertId: "e1",
      expertName: "Expert",
    },
    workspaceDir: dir,
    piDir: dir,
    platform: { send: async () => {} },
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(dir, "evidence")),
    findingsDir: join(dir, "findings"),
    goals: new GoalStore(),
    processFacts: new ProcessFactStore(join(dir, "facts")),
    surfaceLedger: new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(dir)),
    lifecycle: {
      processQuality: pq,
      hardGraphRun: {
        plan: {} as any,
        usage: createUsageLedgerFromEnv(),
        panel,
        stageId: "init",
      },
      toolsInLastSegment: 0,
      subagentDepth: 0,
      recentObservations: [],
    },
  } as unknown as ToolRuntime;

  const executor = createHardGraphStageExecutor({
    config: {
      workspaceDir: dir,
      piAgentDir: join(dir, "pi"),
      modelId: "test",
      modelProvider: "openai",
    } as any,
    parentRuntime: runtime,
    pack: {
      id: "pentest",
      label: "Pentest",
      missionLines: [],
      workLines: [],
      toolNames: ["todo", "fact", "finding"],
      bookingMode: "finding",
      settlementNote: "test",
    } as any,
    sessionFactory: async () => ({
      structured: { ok: true, summary: "init ok", surfaces: [], candidates: [] },
      summary: "init ok",
    }),
    feedbackAgent: async () => ({
      decision: "pass",
      gaps: [],
      stageAdvance: "pause",
    }),
  });

  const out = await executor({
    graphId: graph!.id,
    stage: initStage,
    stageIndex: 0,
    tools: ["todo", "fact"],
    toolProfile: { allow: ["todo", "fact"] },
    handoff: {
      summary: "",
      surfaces: [],
      candidates: [],
      facts: [],
      deadends: [],
      completed_stages: [],
    },
  });
  assert.equal(out.l1?.decision, "pass");
  assert.equal(out.stageAdvance, "pause");
}

{
  const dir = await mkdtemp(join(tmpdir(), "fb-live-"));
  const panel = new PanelAgentTracker("Main", "Expert");
  const sent: Array<{ type?: string; checkpoint?: { panel_agents?: Array<{ id?: string; status?: string; current_detail?: string }> } }> = [];
  const parsed = await runHardGraphFeedbackAgent({
    config: {
      workspaceDir: dir,
      piAgentDir: join(dir, "pi"),
      modelId: "test",
      modelProvider: "openai",
    } as any,
    parentRuntime: {
      task: { taskId: "t", conversationId: "c", instruction: "go", expertId: "e1" },
      workspaceDir: dir,
      piDir: dir,
      platform: { send: async (m: { type?: string }) => { sent.push(m); } },
      findingsDir: join(dir, "findings"),
      lifecycle: {
        toolsInLastSegment: 0,
        subagentDepth: 0,
        recentObservations: [],
        panelAgents: panel,
      },
    } as unknown as ToolRuntime,
    pack: {
      id: "pentest",
      label: "P",
      missionLines: [],
      workLines: [],
      toolNames: ["fact", "finding"],
      bookingMode: "finding",
      settlementNote: "",
    } as any,
    stage: initStage,
    l1Input: { stageId: "init" },
    nextStageId: "surface",
    boundSessionFactory: async ({ runtime }) => {
      await runtime.processFacts?.upsert?.({
        fact_key: "l1_decision",
        summary: "pass",
        body: "L0 met; open next stage",
      });
      await runtime.processFacts?.upsert?.({
        fact_key: "stage_advance",
        summary: "continue",
        body: "user asked for full assessment",
      });
      return {
        session: {
          async prompt() {},
          async abort() {},
          async dispose() {},
          subscribe() {
            return () => {};
          },
          steer() {},
          followUp() {},
          messages: [],
        } as any,
      };
    },
  });
  assert.equal(parsed.decision, "pass");
  assert.equal(parsed.stageAdvance, "continue");
  const ckpts = sent.filter((m) => m.type === "checkpoint_update");
  assert.ok(ckpts.length >= 2, "Feedback start and end must flush panel");
  const fbAt = (i: number) => ckpts[i]?.checkpoint?.panel_agents?.find((a) => a.id === "feedback");
  assert.equal(fbAt(0)?.status, "running", "Feedback light is running while the hop is in flight");
  assert.match(String(fbAt(0)?.current_detail || ""), /init → surface/);
  assert.equal(fbAt(ckpts.length - 1)?.status, "completed");
}

{
  const dir = await mkdtemp(join(tmpdir(), "fb-reuse-"));
  const panel = new PanelAgentTracker("Main", "Expert");
  const facts = new ProcessFactStore(join(dir, "facts"));
  await facts.ensureDir?.();
  const prompts: string[] = [];
  let disposed = false;
  const session = {
    sessionId: "fb-one",
    async prompt(text: string) {
      prompts.push(text);
      await facts.upsert({
        fact_key: "l1_decision",
        summary: "pass",
        body: "ok",
      });
      await facts.upsert({
        fact_key: "stage_advance",
        summary: prompts.length === 1 ? "continue" : "pause",
        body: prompts.length === 1 ? "init hop" : "surface hop wait",
      });
    },
    async abort() {},
    async dispose() {
      disposed = true;
    },
    subscribe() {
      return () => {};
    },
    steer() {},
    followUp() {},
    messages: [],
  };
  const parentRuntime = {
    task: {
      taskId: "t",
      conversationId: "c",
      instruction:
        "init continue. surface 结束后 stage_advance=pause，先问我再进 auth_session。",
      workspaceDir: dir,
      expertId: "e1",
    },
    workspaceDir: dir,
    piDir: dir,
    platform: { send: async () => {} },
    findingsDir: join(dir, "findings"),
    lifecycle: {
      toolsInLastSegment: 0,
      subagentDepth: 0,
      recentObservations: [],
      hardGraphRun: {
        plan: {} as any,
        usage: createUsageLedgerFromEnv(),
        panel,
        stageId: "init",
      },
    },
  } as unknown as ToolRuntime;
  const handleRuntime = parentRuntime;
  parentRuntime.lifecycle.hardGraphRun!.feedbackHandle = {
    session: session as any,
    processFacts: facts,
    workDir: dir,
    runtime: handleRuntime,
  };

  const cfg = {
    workspaceDir: dir,
    piAgentDir: join(dir, "pi"),
    modelId: "test",
    modelProvider: "openai",
  } as any;
  const pack = {
    id: "pentest",
    label: "P",
    missionLines: [],
    workLines: [],
    toolNames: ["fact", "finding"],
    bookingMode: "finding",
    settlementNote: "",
  } as any;

  const first = await runHardGraphFeedbackAgent({
    config: cfg,
    parentRuntime,
    pack,
    stage: initStage,
    l1Input: { stageId: "init" },
    nextStageId: "surface",
  });
  assert.equal(first.stageAdvance, "continue");
  const surfaceStage = graph!.stages.find((s) => s.id === "surface")!;
  const second = await runHardGraphFeedbackAgent({
    config: cfg,
    parentRuntime,
    pack,
    stage: surfaceStage,
    l1Input: { stageId: "surface" },
    nextStageId: "auth_session",
  });
  assert.equal(second.stageAdvance, "pause");
  assert.equal(prompts.length, 2, "same Feedback session, two hops");
  assert.equal(disposed, false, "must not dispose Feedback between stages");
  const ids = panel.list().filter((r) => r.parent_id).map((r) => r.id);
  assert.deepEqual([...new Set(ids)], ["feedback"]);
}

console.log("hard-graph-feedback-agent.test.ts: ok");
