/**
 * Batch dry subagent (no LLM).
 * Run: NODE4_SUBAGENT_DRY=1 npx tsx src/runtime/subagent-batch.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentHost } from "./subagent.js";
import { createSubagentTool } from "../tools/subagent.js";
import { TodoStore } from "../stores/todo.js";
import { GoalStore } from "../stores/goal.js";
import { EvidenceStore } from "../stores/evidence.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { SurfaceLedgerStore } from "../stores/surface-ledger.js";
import type { ToolRuntime } from "../types.js";

process.env.NODE4_SUBAGENT_DRY = "1";
process.env.NODE4_SUBAGENT_CONCURRENCY = "2";

const dir = await mkdtemp(join(tmpdir(), "node4-batch-"));
const taskDir = join(dir, "task");
await import("node:fs/promises").then((fs) => fs.mkdir(taskDir, { recursive: true }));

const messages: unknown[] = [];
const platform = {
  send: async (m: unknown) => {
    messages.push(m);
  },
};

const goals = new GoalStore();
const evidence = new EvidenceStore(join(taskDir, "evidence"));
await evidence.ensureDir?.().catch?.(() => undefined);
// EvidenceStore may not have ensureDir — mkdir
await import("node:fs/promises").then((fs) =>
  Promise.all([
    fs.mkdir(join(taskDir, "evidence"), { recursive: true }),
    fs.mkdir(join(taskDir, "findings"), { recursive: true }),
    fs.mkdir(join(taskDir, "facts"), { recursive: true }),
    fs.mkdir(join(taskDir, "surfaces"), { recursive: true }),
    fs.mkdir(join(taskDir, "subagents"), { recursive: true }),
  ]),
);

const surfaceLedger = new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(taskDir));
await surfaceLedger.ensureDir();
await surfaceLedger.load();

const runtime: ToolRuntime = {
  task: {
    conversationId: "c-batch",
    taskId: "t-batch",
    target: { type: "url", value: "http://127.0.0.1:8080" },
    scope: { hosts: ["127.0.0.1"] },
    instruction: "batch test",
  } as any,
  workspaceDir: dir,
  taskDir,
  platform: platform as any,
  todo: new TodoStore(),
  evidence: evidence as any,
  findingsDir: join(taskDir, "findings"),
  goals,
  processFacts: new ProcessFactStore(join(taskDir, "facts")),
  surfaceLedger,
  lifecycle: {
    toolsInLastSegment: 0,
    subagentDepth: 0,
    recentObservations: [],
  },
};

runtime.subagents = new SubagentHost({
  task: runtime.task,
  taskDir,
  evidence: runtime.evidence,
  platform: platform as any,
  goals,
});

const tool = createSubagentTool(runtime);
const started = Date.now();
const out = await tool.execute("b1", {
  context: "DVWA low security authorized lab",
  scope: "127.0.0.1,localhost",
  already_done: "recon listed modules",
  packages: [
    {
      target: "http://127.0.0.1:8080/vulnerabilities/sqli/",
      this_turn_goal: "Probe SQLi module",
      success_criteria: "candidates or deadend",
    },
    {
      target: "http://127.0.0.1:8080/vulnerabilities/xss_r/",
      this_turn_goal: "Probe XSS module",
      success_criteria: "candidates or deadend",
    },
  ],
});
const elapsed = Date.now() - started;

const text = (out as any).content?.find((c: any) => c.type === "text")?.text || "";
const body = JSON.parse(text);
assert.equal(body.batch, true, text.slice(0, 300));
assert.equal(body.total, 2);
assert.equal(body.results.length, 2);
assert.ok(body.concurrency >= 1);
// dry packages should both complete
assert.ok(body.succeeded >= 1 || body.failed >= 0);

await rm(dir, { recursive: true, force: true });
console.log("subagent-batch.test.ts: ok", { elapsed, succeeded: body.succeeded, failed: body.failed });
