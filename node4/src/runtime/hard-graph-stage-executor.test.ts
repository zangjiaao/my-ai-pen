/**
 * Hard Graph stage handoff: Spec #125 host settlement (agent result.json ignored).
 * Includes production finalize seam via createHardGraphStageExecutor.
 * Run: npx tsx src/runtime/hard-graph-stage-executor.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolRuntime } from "../types.js";
import { loadHardGraphFile } from "./hard-graph-definition.js";
import { evaluateStageGate } from "./hard-graph-runner.js";
import { createHardGraphStageExecutor } from "./hard-graph-stage-executor.js";
import { stageSystemPrompt } from "./prompt.js";
import { settleHostStage } from "./host-stage-settlement.js";
import { createProcessQualityState } from "./package-honesty-host.js";
import { SurfaceLedgerStore } from "../stores/surface-ledger.js";
import { EvidenceStore } from "../stores/evidence.js";
import { TodoStore } from "../stores/todo.js";
import { GoalStore } from "../stores/goal.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { HardGraphPlanStore } from "./hard-graph-plan.js";
import { createUsageLedgerFromEnv } from "./platform-observability.js";
import { PanelAgentTracker } from "./panel-agents.js";
import { normalizeSubagentResult } from "./subagent-result.js";
import { PENTEST_ROLE_PACK } from "../roles/index.js";

const repoExperts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../experts/pentest",
);

const graph = await loadHardGraphFile(repoExperts, "app_assessment_thin");
assert.ok(graph);
const initStage = graph!.stages.find((s) => s.id === "init")!;
const surfaceStage = graph!.stages.find((s) => s.id === "surface")!;

const workDir = await mkdtemp(join(tmpdir(), "hard-stage-result-"));
await mkdir(workDir, { recursive: true });

// Agent result.json with ok:true must not be gate input (pure settle)
await writeFile(
  join(workDir, "result.json"),
  JSON.stringify({
    ok: true,
    summary: "full success fiction",
    surfaces: [{ location: "http://fake/" }],
    candidates: [],
  }),
  "utf8",
);

const pq = createProcessQualityState();
const runtime = {
  task: {
    taskId: "t1",
    conversationId: "c1",
    instruction: "assess",
    target: {},
    scope: {},
  },
  workspaceDir: workDir,
  piDir: workDir,
  platform: { send: async () => {} },
  findingsDir: join(workDir, "findings"),
  rolePackId: "pentest",
  lifecycle: {
    processQuality: pq,
    hardGraphRun: { plan: {} as any, usage: {} as any, panel: {} as any, stageId: "init" },
    toolsInLastSegment: 0,
    subagentDepth: 0,
    recentObservations: [],
  },
  surfaceLedger: new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(workDir)),
} as unknown as ToolRuntime;

const settlement = await settleHostStage({
  stageId: "init",
  runtime,
  narrative: { summary: "Target and RoE understood; handoff ready" },
});
assert.equal(settlement.agent_result_json_ignored, true);
assert.equal(settlement.structured.ok, true);
assert.equal(evaluateStageGate(initStage, settlement.structured).ok, true);
// Captain machine surface lives on settlement, not inside normalize strip
assert.ok(Array.isArray(settlement.feedback_ok_ids));
assert.ok(Array.isArray(settlement.host_declared_keys));
assert.equal(
  (settlement.structured as { feedback_ok_ids?: unknown }).feedback_ok_ids,
  undefined,
  "normalize must not silently carry host fields on structured",
);

// Surface stage: host ledger, not agent file
await runtime.surfaceLedger!.upsertFromRecon([{ location: "http://t/login", kind: "form" }]);
const surf = await settleHostStage({
  stageId: "surface",
  runtime,
  narrative: { summary: "surfaces mapped" },
});
assert.ok(surf.structured.surfaces.length >= 1);
assert.equal(evaluateStageGate(surfaceStage, surf.structured).ok, true);

assert.equal(normalizeSubagentResult(settlement.structured).summaryProvided, true);

// Poison file alone does not populate ledger / pass surfaces_min
{
  const poisonDir = await mkdtemp(join(tmpdir(), "hard-stage-poison-"));
  await mkdir(poisonDir, { recursive: true });
  await writeFile(
    join(poisonDir, "result.json"),
    JSON.stringify({
      ok: true,
      summary: "fake full success",
      surfaces: [{ location: "http://invented/surface" }],
      candidates: [],
    }),
    "utf8",
  );
  const emptyLedger = new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(poisonDir));
  const poisonRt = {
    ...runtime,
    piDir: poisonDir,
    workspaceDir: poisonDir,
    surfaceLedger: emptyLedger,
    lifecycle: {
      processQuality: createProcessQualityState(),
      hardGraphRun: { plan: {} as any, usage: {} as any, panel: {} as any, stageId: "surface" },
      toolsInLastSegment: 0,
      subagentDepth: 0,
      recentObservations: [],
    },
  } as unknown as ToolRuntime;
  const noLaunder = await settleHostStage({
    stageId: "surface",
    runtime: poisonRt,
    narrative: { summary: "I wrote result.json with surfaces" },
  });
  assert.equal(noLaunder.structured.surfaces.length, 0, "poison file must not populate ledger");
  assert.equal(evaluateStageGate(surfaceStage, noLaunder.structured).ok, false);
  await rm(poisonDir, { recursive: true, force: true });
}

// Track B: stage prompts ban result.json handoff
{
  const sys = stageSystemPrompt(
    {
      graphId: graph!.id,
      stage: initStage,
      stageIndex: 0,
      tools: ["todo", "fact", "finding"],
      handoff: {
        summary: "",
        surfaces: [],
        candidates: [],
        deadends: [],
        completed_stages: [],
      },
      toolProfile: "default",
    } as any,
    runtime.task as any,
    PENTEST_ROLE_PACK,
  );
  assert.match(sys, /host-owned|Finding Store/i);
  assert.match(sys, /do \*\*not\*\* write result\.json as the stage handoff/i);
  assert.doesNotMatch(sys, /Feedback reads result\.json only/i);
  assert.doesNotMatch(sys, /use the \*\*write\*\* tool to create \*\*result\.json\*\*/i);
}

// --- Production finalize seam: createHardGraphStageExecutor ignores workdir result.json ---
{
  const taskDir = await mkdtemp(join(tmpdir(), "hg-finalize-seam-"));
  const plan = new HardGraphPlanStore(graph!);
  const runUsage = createUsageLedgerFromEnv();
  const panel = new PanelAgentTracker("seam", "Expert");
  const pqSeam = createProcessQualityState();
  const parentRuntime = {
    task: {
      taskId: "seam-task",
      conversationId: "seam-conv",
      instruction: "assess",
      workspaceDir: taskDir,
      expertId: "e1",
      expertName: "Expert",
    },
    workspaceDir: taskDir,
    piDir: taskDir,
    platform: { send: async () => {} },
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals: new GoalStore(),
    processFacts: new ProcessFactStore(join(taskDir, "facts")),
    surfaceLedger: new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(taskDir)),
    lifecycle: {
      processQuality: pqSeam,
      hardGraphRun: { plan, usage: runUsage, panel, stageId: "surface" },
      toolsInLastSegment: 0,
      subagentDepth: 0,
      recentObservations: [],
      subagentEvidenceCache: [],
    },
  } as unknown as ToolRuntime;

  const executor = createHardGraphStageExecutor({
    config: {
      workspaceDir: taskDir,
      piAgentDir: join(taskDir, "pi"),
      modelId: "test",
      modelProvider: "openai",
    } as any,
    parentRuntime,
    pack: {
      id: "pentest",
      label: "Pentest",
      missionLines: [],
      workLines: [],
      toolNames: ["todo", "fact", "write"],
      bookingMode: "finding",
      settlementNote: "test",
    } as any,
    // Production-like path: bound session writes poison result.json; no hostInject.
    boundSessionFactory: async ({ runtime: childRt }) => {
      const stageWork = childRt.piDir;
      await mkdir(stageWork, { recursive: true });
      await writeFile(
        join(stageWork, "result.json"),
        JSON.stringify({
          ok: true,
          summary: "poison full success with invented surfaces",
          surfaces: [
            { location: "http://poisoned/from-result-json", kind: "form" },
            { location: "http://poisoned/another", kind: "api" },
          ],
          candidates: [
            {
              title: "fiction",
              location: "http://poisoned/x",
              severity: "high",
              proof_excerpt: "x".repeat(40),
            },
          ],
        }),
        "utf8",
      );
      return {
        session: {
          async prompt() {
            /* no process facts → no narrative summary */
          },
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

  const emptyHandoff = {
    summary: "",
    surfaces: [] as [],
    candidates: [] as [],
    facts: [] as [],
    deadends: [] as string[],
    completed_stages: [] as string[],
  };
  const out = await executor({
    graphId: graph!.id,
    stage: surfaceStage!,
    stageIndex: 1,
    attempt: 1,
    tools: ["todo", "fact", "write"],
    toolProfile: {},
    handoff: emptyHandoff,
  });

  const structured = normalizeSubagentResult(out.structured);
  assert.equal(
    structured.surfaces.length,
    0,
    "production finalize must not launder agent result.json surfaces",
  );
  assert.equal(
    structured.candidates.length,
    0,
    "production finalize must not launder agent result.json candidates",
  );
  // Without host ledger deposit, surfaces_min fails
  assert.equal(evaluateStageGate(surfaceStage!, structured).ok, false);

  // Explicit hostInject deposits; narrative-only structured does not.
  const executorInject = createHardGraphStageExecutor({
    config: {
      workspaceDir: taskDir,
      piAgentDir: join(taskDir, "pi"),
      modelId: "test",
      modelProvider: "openai",
    } as any,
    parentRuntime: {
      ...parentRuntime,
      surfaceLedger: new SurfaceLedgerStore(
        SurfaceLedgerStore.pathFromTaskDir(join(taskDir, "inject-ledger")),
      ),
      lifecycle: {
        ...parentRuntime.lifecycle,
        processQuality: createProcessQualityState(),
      },
    } as any,
    pack: {
      id: "pentest",
      label: "P",
      missionLines: [],
      workLines: [],
      toolNames: ["todo"],
      bookingMode: "finding",
      settlementNote: "test",
    } as any,
    sessionFactory: async () => ({
      summary: "session narrative only",
      // surfaces in structured must NOT deposit
      structured: {
        ok: true,
        summary: "session narrative only",
        surfaces: [{ location: "http://narrative-only/should-not-deposit" }],
        candidates: [],
      },
      hostInject: {
        ok: true,
        surfaces: [{ location: "http://host-inject/real", kind: "form" }],
        candidates: [],
      },
    }),
  });
  const injected = await executorInject({
    graphId: graph!.id,
    stage: surfaceStage!,
    stageIndex: 1,
    attempt: 1,
    tools: ["todo"],
    toolProfile: {},
    handoff: emptyHandoff,
  });
  const injStruct = normalizeSubagentResult(injected.structured);
  assert.ok(
    injStruct.surfaces.some((s) => s.location.includes("host-inject")),
    "hostInject surfaces deposited",
  );
  assert.ok(
    !injStruct.surfaces.some((s) => s.location.includes("narrative-only")),
    "narrative structured surfaces must not deposit",
  );

  await rm(taskDir, { recursive: true, force: true });
}

// --- #531: Graph stage session gets the same Case live index as Free (harness) ---
{
  const taskDir = await mkdtemp(join(tmpdir(), "hg-pdca-overlay-"));
  const plan = new HardGraphPlanStore(graph!);
  const runUsage = createUsageLedgerFromEnv();
  const panel = new PanelAgentTracker("pdca-overlay", "Expert");
  const pq = createProcessQualityState();
  const parentRuntime = {
    task: {
      taskId: "pdca-overlay-task",
      conversationId: "pdca-overlay-conv",
      instruction: "assess",
      workspaceDir: taskDir,
      expertId: "e1",
      expertName: "Expert",
    },
    workspaceDir: taskDir,
    piDir: taskDir,
    platform: { send: async () => {} },
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals: new GoalStore(),
    processFacts: new ProcessFactStore(join(taskDir, "facts")),
    surfaceLedger: new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(taskDir)),
    lifecycle: {
      processQuality: pq,
      hardGraphRun: { plan, usage: runUsage, panel, stageId: "init" },
      toolsInLastSegment: 0,
      subagentDepth: 0,
      recentObservations: [],
      subagentEvidenceCache: [],
    },
  } as unknown as ToolRuntime;

  const prevFlag = process.env.NODE4_PDCA_SETTLE;
  process.env.NODE4_PDCA_SETTLE = "1";
  let capturedPrefix: string | undefined;
  try {
    const executor = createHardGraphStageExecutor({
      config: {
        workspaceDir: taskDir,
        piAgentDir: join(taskDir, "pi"),
        modelId: "test",
        modelProvider: "openai",
      } as any,
      parentRuntime,
      pack: {
        id: "pentest",
        label: "Pentest",
        missionLines: [],
        workLines: [],
        toolNames: ["todo", "fact", "write"],
        bookingMode: "finding",
        settlementNote: "test",
      } as any,
      boundSessionFactory: async () => ({
        session: {
          async prompt(_text: string, opts?: { prefixHarness?: string }) {
            capturedPrefix = opts?.prefixHarness;
          },
          async abort() {},
          async dispose() {},
          subscribe() {
            return () => {};
          },
          steer() {},
          followUp() {},
          messages: [],
        } as any,
      }),
    });
    await executor({
      graphId: graph!.id,
      stage: initStage!,
      stageIndex: 0,
      attempt: 1,
      tools: ["todo", "fact", "write"],
      toolProfile: {},
      handoff: {
        summary: "",
        surfaces: [],
        candidates: [],
        facts: [],
        deadends: [],
        completed_stages: [],
      },
    });
    assert.match(
      String(capturedPrefix || ""),
      /### Case live index/,
      "#531: stage prompt harness carries the same overlay heading as Free",
    );
  } finally {
    if (prevFlag === undefined) delete process.env.NODE4_PDCA_SETTLE;
    else process.env.NODE4_PDCA_SETTLE = prevFlag;
    await rm(taskDir, { recursive: true, force: true });
  }
}

await rm(workDir, { recursive: true, force: true });
console.log("hard-graph-stage-executor.test.ts: ok");
