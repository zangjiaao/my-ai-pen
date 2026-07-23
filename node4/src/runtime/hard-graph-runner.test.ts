/**
 * Hard Graph runner + fail-closed Feedback (fake stage executor).
 * Run: npx tsx src/runtime/hard-graph-runner.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHardGraphFile } from "./hard-graph-definition.js";
import {
  evaluateStageGate,
  hardGraphToHarnessStatus,
  runHardGraph,
  type StageExecutor,
} from "./hard-graph-runner.js";
import { normalizeSubagentResult } from "./subagent-result.js";

const repoExperts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../experts/pentest",
);

const graph = await loadHardGraphFile(repoExperts, "app_assessment_thin");
assert.ok(graph);

// Gate: missing surfaces fails surface stage
const surfaceStage = graph!.stages.find((s) => s.id === "surface")!;
const badSurf = normalizeSubagentResult({
  ok: true,
  summary: "looked around",
  surfaces: [],
  candidates: [],
});
const gateBad = evaluateStageGate(surfaceStage, badSurf);
assert.equal(gateBad.ok, false);
if (!gateBad.ok) assert.ok(gateBad.errors.some((e) => e.startsWith("surfaces_min")));

const goodSurf = normalizeSubagentResult({
  ok: true,
  summary: "found login",
  surfaces: [{ location: "http://t/login", kind: "form" }],
  candidates: [],
});
assert.equal(evaluateStageGate(surfaceStage, goodSurf).ok, true);

// Empty summary fails init — summaryProvided false (no magic string match)
const initStage = graph!.stages.find((s) => s.id === "init")!;
const emptyNorm = normalizeSubagentResult({ ok: true });
assert.equal(emptyNorm.summaryProvided, false);
assert.equal(evaluateStageGate(initStage, emptyNorm).ok, false);
// Explicit summary works
assert.equal(
  evaluateStageGate(initStage, normalizeSubagentResult({ ok: true, summary: "init ok" })).ok,
  true,
);

// Happy path with fake executor — hard order, all pass
const seenOrder: string[] = [];
const seenTools: Record<string, string[]> = {};
const events: string[] = [];

const happy: StageExecutor = async (input) => {
  seenOrder.push(input.stage.id);
  seenTools[input.stage.id] = [...input.tools];
  if (input.stage.id === "init") {
    return { structured: { ok: true, summary: "init ok", surfaces: [], candidates: [] } };
  }
  if (input.stage.id === "surface") {
    return {
      structured: {
        ok: true,
        summary: "surfaces",
        surfaces: [{ location: "http://t/" }],
        candidates: [],
      },
    };
  }
  if (input.stage.id === "class_probe") {
    return {
      structured: {
        ok: true,
        summary: "probed",
        surfaces: [],
        candidates: [{ title: "xss", location: "http://t/", claim: "c", proof_excerpt: "p" }],
      },
    };
  }
  return { structured: { ok: true, summary: "validate done", surfaces: [], candidates: [] } };
};

const result = await runHardGraph({
  graph: graph!,
  executeStage: happy,
  availableTools: ["todo", "read", "fact", "skill", "write", "shell", "http", "session", "browser", "script", "finding"],
  onEvent: (e) => {
    if (e.type === "stage_start") events.push(`start:${e.stageId}`);
    if (e.type === "stage_end") events.push(`end:${e.stageId}:${e.outcome}`);
    if (e.type === "run_end") events.push(`run:${e.terminal}`);
  },
});

assert.equal(result.terminal, "completed");
assert.deepEqual(
  seenOrder,
  graph!.stages.map((s) => s.id),
);
assert.ok(result.handoff.surfaces.some((s) => s.location === "http://t/"));
assert.ok(result.handoff.completed_stages.includes("surface"));
assert.ok(events.includes("run:completed"));
assert.ok(seenTools.init);
assert.ok(!seenTools.init.includes("shell"));
assert.ok(seenTools.init.includes("todo"));
assert.ok(seenTools.init.includes("write"), "init must allow write for result.json");
assert.ok(seenTools.surface?.includes("shell"));
assert.ok(seenTools.surface?.includes("write"));
assert.ok(seenTools.validate_book?.includes("write"));

// Fail-closed: surface never returns surfaces → blocked; intermediate attempts are failed_attempt
const order2: string[] = [];
const attemptOutcomes: string[] = [];
const blockedExec: StageExecutor = async (input) => {
  order2.push(input.stage.id);
  if (input.stage.id === "init") {
    return { structured: { ok: true, summary: "init ok", surfaces: [], candidates: [] } };
  }
  return { structured: { ok: true, summary: "empty", surfaces: [], candidates: [] } };
};

const blocked = await runHardGraph({
  graph: graph!,
  executeStage: blockedExec,
  availableTools: ["todo", "read", "shell", "http", "fact", "skill", "finding"],
  onEvent: (e) => {
    if (e.type === "stage_end" && e.stageId === "surface") {
      attemptOutcomes.push(e.outcome);
    }
  },
});
assert.equal(blocked.terminal, "blocked");
assert.equal(hardGraphToHarnessStatus("blocked"), "blocked");
assert.equal(hardGraphToHarnessStatus("aborted"), "incomplete");
assert.equal(hardGraphToHarnessStatus("completed"), "completed");
assert.ok(!order2.includes("class_probe"), "must not skip to later stages");
assert.ok(attemptOutcomes.includes("failed_attempt"), "retryable failure is failed_attempt");
assert.ok(attemptOutcomes.includes("blocked"), "final failure is blocked");
assert.notEqual(attemptOutcomes[0], "blocked", "first surface fail is not terminal blocked");
const surfaceRec = blocked.stages.find((s) => s.stageId === "surface");
assert.equal(surfaceRec?.outcome, "blocked");
assert.ok((surfaceRec?.attempts ?? 0) >= 2, "retries for surface max_retries=1");

// Retry then pass
let surfaceAttempts = 0;
const retryExec: StageExecutor = async (input) => {
  if (input.stage.id === "init") {
    return { structured: { ok: true, summary: "init", surfaces: [], candidates: [] } };
  }
  if (input.stage.id === "surface") {
    surfaceAttempts += 1;
    if (surfaceAttempts === 1) {
      return { structured: { ok: true, summary: "miss", surfaces: [], candidates: [] } };
    }
    return {
      structured: {
        ok: true,
        summary: "hit",
        surfaces: [{ location: "http://t/a" }],
        candidates: [],
      },
    };
  }
  return { structured: { ok: true, summary: input.stage.id, surfaces: [], candidates: [] } };
};

const retried = await runHardGraph({
  graph: graph!,
  executeStage: retryExec,
  availableTools: ["todo", "read", "shell", "http", "fact", "skill", "finding", "session", "browser", "script"],
});
assert.equal(retried.terminal, "completed");
assert.equal(surfaceAttempts, 2);
assert.equal(
  retried.stages.map((s) => s.stageId).join(","),
  graph!.stages.map((s) => s.id).join(","),
);

console.log("hard-graph-runner.test.ts: ok");
