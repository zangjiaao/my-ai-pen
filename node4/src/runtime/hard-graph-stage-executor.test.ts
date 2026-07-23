/**
 * Hard Graph stage handoff: disk result.json contract (no live LLM).
 * Run: npx tsx src/runtime/hard-graph-stage-executor.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteTool } from "../tools/fs-tools.js";
import type { ToolRuntime } from "../types.js";
import { loadHardGraphFile } from "./hard-graph-definition.js";
import { evaluateStageGate } from "./hard-graph-runner.js";
import { loadStageResultJson } from "./hard-graph-stage-executor.js";
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

// Missing result.json → fail-closed
const missing = await loadStageResultJson(workDir, "init");
assert.equal(missing.ok, false);
assert.ok(missing.deadends.includes("missing_result_json"));
assert.equal(evaluateStageGate(initStage, missing).ok, false);

// Valid result.json via write tool (same tool stage agents use) → gate pass
const stageRuntime = {
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
  lifecycle: { toolsInLastSegment: 0, subagentDepth: 1, recentObservations: [] },
} as unknown as ToolRuntime;

const write = createWriteTool(stageRuntime);
const payload = {
  ok: true,
  summary: "Target and RoE understood; handoff ready",
  surfaces: [],
  candidates: [],
  facts: [],
  deadends: [],
};
await write.execute("w1", {
  path: "result.json",
  content: JSON.stringify(payload, null, 2),
});
// Tool wrote under stage workDir — production executor only reads this path
assert.equal(
  JSON.parse(await readFile(join(workDir, "result.json"), "utf8")).summary,
  payload.summary,
);

const loaded = await loadStageResultJson(workDir, "init");
assert.equal(loaded.ok, true);
assert.equal(loaded.summaryProvided, true);
assert.equal(evaluateStageGate(initStage, loaded).ok, true);

const normalizedPath = join(workDir, "normalized-result.json");
const normalized = JSON.parse(await readFile(normalizedPath, "utf8"));
assert.equal(normalizeSubagentResult(normalized).summaryProvided, true);

// Invalid JSON → fail-closed
const badDir = await mkdtemp(join(tmpdir(), "hard-stage-bad-"));
await writeFile(join(badDir, "result.json"), "{not-json", "utf8");
const invalid = await loadStageResultJson(badDir, "init");
assert.equal(invalid.ok, false);
assert.ok(invalid.deadends.includes("missing_result_json"));

console.log("hard-graph-stage-executor.test.ts: ok");
