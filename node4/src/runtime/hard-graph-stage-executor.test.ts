/**
 * Hard Graph stage handoff: Spec #125 host settlement (agent result.json ignored).
 * Run: npx tsx src/runtime/hard-graph-stage-executor.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolRuntime } from "../types.js";
import { loadHardGraphFile } from "./hard-graph-definition.js";
import { evaluateStageGate } from "./hard-graph-runner.js";
import { loadStageResultJson } from "./hard-graph-stage-executor.js";
import { settleHostStage } from "./host-stage-settlement.js";
import { createProcessQualityState } from "./package-honesty-host.js";
import { SurfaceLedgerStore } from "../stores/surface-ledger.js";
import { normalizeSubagentResult } from "./subagent-result.js";

const repoExperts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../experts/pentest",
);

const graph = await loadHardGraphFile(repoExperts, "app_assessment_thin");
assert.ok(graph);
const initStage = graph!.stages.find((s) => s.id === "init")!;

const workDir = await mkdtemp(join(tmpdir(), "hard-stage-result-"));
await mkdir(workDir, { recursive: true });

// loadStageResultJson is deprecated and must not be gate SoT
const ignored = await loadStageResultJson(workDir, "init");
assert.equal(ignored.ok, false);
assert.ok(ignored.deadends.includes("agent_result_json_ignored"));

// Agent result.json with ok:true must not be gate input
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
const stillIgnored = await loadStageResultJson(workDir, "init");
assert.equal(stillIgnored.ok, false, "agent result.json never becomes gate SoT");

// Host settlement without result.json can pass init (summary only)
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
  taskDir: workDir,
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

const settlement = settleHostStage({
  stageId: "init",
  runtime,
  narrative: { summary: "Target and RoE understood; handoff ready" },
});
assert.equal(settlement.agent_result_json_ignored, true);
assert.equal(settlement.structured.ok, true);
assert.equal(evaluateStageGate(initStage, settlement.structured).ok, true);

// Surface stage: host ledger, not agent file
const surfaceStage = graph!.stages.find((s) => s.id === "surface")!;
await runtime.surfaceLedger!.upsertFromRecon([{ location: "http://t/login", kind: "form" }]);
const surf = settleHostStage({
  stageId: "surface",
  runtime,
  narrative: { summary: "surfaces mapped" },
});
assert.ok(surf.structured.surfaces.length >= 1);
assert.equal(evaluateStageGate(surfaceStage, surf.structured).ok, true);

// Normalize still works for host projections
assert.equal(normalizeSubagentResult(settlement.structured).summaryProvided, true);

// Production path: poisoned agent result.json must not satisfy surfaces_min
// when ledger is empty (no laundering via file deposit).
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
    taskDir: poisonDir,
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
  // Host settlement without ledger deposit — agent file is not read
  const noLaunder = settleHostStage({
    stageId: "surface",
    runtime: poisonRt,
    narrative: { summary: "I wrote result.json with surfaces" },
  });
  assert.equal(noLaunder.structured.surfaces.length, 0, "poison file must not populate ledger");
  assert.equal(evaluateStageGate(surfaceStage, noLaunder.structured).ok, false);
}

console.log("hard-graph-stage-executor.test.ts: ok");
