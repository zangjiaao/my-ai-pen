/**
 * Spec #302: Grok-like subagent limits
 * - no path-count kill
 * - concurrency = queue only
 * - per-task package budget
 * - batch safety ceiling
 * - nest ban unchanged
 *
 * Run: NODE4_SUBAGENT_DRY=1 npx tsx src/runtime/subagent-limits.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentHost } from "./subagent.js";
import { createSubagentTool } from "../tools/subagent.js";
import { TodoStore } from "../stores/todo.js";
import { GoalStore } from "../stores/goal.js";
import { EvidenceStore } from "../stores/evidence.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { SurfaceLedgerStore } from "../stores/surface-ledger.js";
import { MAX_SUBAGENT_BATCH } from "./concurrency.js";
import type { ToolRuntime } from "../types.js";

process.env.NODE4_SUBAGENT_DRY = "1";
// Isolate budget from other tests / host env
const prevBudget = process.env.NODE4_SUBAGENT_TASK_BUDGET;
const prevConc = process.env.NODE4_SUBAGENT_CONCURRENCY;
delete process.env.NODE4_SUBAGENT_TASK_BUDGET;

function parseToolJson(out: unknown): any {
  const text = (out as any).content?.find((c: any) => c.type === "text")?.text || "";
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text, _details: (out as any).details };
  }
}

function toolText(out: unknown): string {
  return (out as any).content?.find((c: any) => c.type === "text")?.text || String(out);
}

async function makeRuntime(label: string): Promise<{ runtime: ToolRuntime; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `node4-limits-${label}-`));
  const taskDir = join(dir, "task");
  await mkdir(taskDir, { recursive: true });
  await Promise.all([
    mkdir(join(taskDir, "evidence"), { recursive: true }),
    mkdir(join(taskDir, "findings"), { recursive: true }),
    mkdir(join(taskDir, "facts"), { recursive: true }),
    mkdir(join(taskDir, "surfaces"), { recursive: true }),
    mkdir(join(taskDir, "subagents"), { recursive: true }),
  ]);

  const messages: unknown[] = [];
  const platform = {
    send: async (m: unknown) => {
      messages.push(m);
    },
  };

  const goals = new GoalStore();
  const evidence = new EvidenceStore(join(taskDir, "evidence"));
  const surfaceLedger = new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(taskDir));
  await surfaceLedger.ensureDir();
  await surfaceLedger.load();

  const runtime: ToolRuntime = {
    task: {
      conversationId: `c-${label}`,
      taskId: `t-${label}`,
      target: { type: "url", value: "http://127.0.0.1:8080" },
      scope: { hosts: ["127.0.0.1"] },
      instruction: "limits test",
    } as any,
    workspaceDir: dir,
    piDir: taskDir,
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
    piDir: taskDir,
    evidence: runtime.evidence,
    platform: platform as any,
    goals,
  });

  return { runtime, dir };
}

function baseHandoff(extra: Record<string, unknown> = {}) {
  return {
    scope: "127.0.0.1,localhost",
    already_done: "recon listed modules",
    success_criteria: "candidates or deadend",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1) Same target URL, 8 packages one batch → 8 starts (not 2 from path counter)
// ---------------------------------------------------------------------------
{
  process.env.NODE4_SUBAGENT_CONCURRENCY = "8";
  const { runtime, dir } = await makeRuntime("same-path-8");
  try {
    const tool = createSubagentTool(runtime);
    const target = "http://127.0.0.1:8080/vulnerabilities/sqli/";
    const packages = Array.from({ length: 8 }, (_, i) => ({
      target,
      this_turn_goal: `Probe class package ${i + 1}`,
      success_criteria: "candidates or deadend",
    }));
    const out = await tool.execute("same-path-8", {
      ...baseHandoff(),
      packages,
    });
    const body = parseToolJson(out);
    assert.equal(body.batch, true, toolText(out).slice(0, 400));
    assert.equal(body.total, 8, `expected 8 results, got ${body.total}`);
    assert.equal(body.results?.length, 8);
    const neverFromPath = (body.results || []).filter(
      (r: any) =>
        !r.ok &&
        String(r.error || r.summary || "").includes("path already dispatched"),
    );
    assert.equal(neverFromPath.length, 0, "path-count kill must not soft-fail packages");
    const started = (body.results || []).filter(
      (r: any) => r.subagent_id || r.ok || r.worker_status,
    );
    // Dry host yields subagent_id for every admitted package that ran
    const withId = (body.results || []).filter((r: any) => r.subagent_id);
    assert.equal(
      withId.length,
      8,
      `expected 8 started workers with subagent_id, got ${withId.length}: ${JSON.stringify(body.results?.map((r: any) => ({ ok: r.ok, id: r.subagent_id, err: r.error })).slice(0, 8))}`,
    );
    assert.ok(started.length >= 8 || withId.length === 8);
    assert.equal(runtime.lifecycle.subagentPackagesAdmitted, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2) Concurrency=2, 5 packages → all five complete (queued)
// ---------------------------------------------------------------------------
{
  process.env.NODE4_SUBAGENT_CONCURRENCY = "2";
  const { runtime, dir } = await makeRuntime("conc-2-five");
  try {
    const tool = createSubagentTool(runtime);
    const packages = Array.from({ length: 5 }, (_, i) => ({
      target: `http://127.0.0.1:8080/vulnerabilities/mod${i}/`,
      this_turn_goal: `Probe module ${i}`,
      success_criteria: "candidates or deadend",
    }));
    const out = await tool.execute("conc-5", {
      ...baseHandoff(),
      packages,
    });
    const body = parseToolJson(out);
    assert.equal(body.batch, true, toolText(out).slice(0, 400));
    assert.equal(body.concurrency, 2);
    assert.equal(body.total, 5);
    const withId = (body.results || []).filter((r: any) => r.subagent_id);
    assert.equal(withId.length, 5, `all five must run under concurrency=2 queue; got ${withId.length}`);
    assert.equal(runtime.lifecycle.subagentPackagesAdmitted, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3) Task budget=3: fourth admitted spawn fails clearly
// ---------------------------------------------------------------------------
{
  process.env.NODE4_SUBAGENT_TASK_BUDGET = "3";
  process.env.NODE4_SUBAGENT_CONCURRENCY = "8";
  const { runtime, dir } = await makeRuntime("budget-3");
  try {
    const tool = createSubagentTool(runtime);
    // Three flat admits
    for (let i = 0; i < 3; i++) {
      const out = await tool.execute(`flat-${i}`, {
        ...baseHandoff({
          target: `http://127.0.0.1:8080/p${i}/`,
          this_turn_goal: `goal ${i}`,
        }),
      });
      const body = parseToolJson(out);
      assert.ok(body.subagent_id || body.ok !== false, toolText(out).slice(0, 300));
    }
    assert.equal(runtime.lifecycle.subagentPackagesAdmitted, 3);

    // Fourth flat → explicit error
    const fourth = await tool.execute("flat-3", {
      ...baseHandoff({
        target: "http://127.0.0.1:8080/p3/",
        this_turn_goal: "should fail budget",
      }),
    });
    const fourthText = toolText(fourth);
    assert.match(fourthText, /task budget exhausted/i);
    assert.ok((fourth as any).details?.isError === true || /error:/i.test(fourthText));
    assert.equal(runtime.lifecycle.subagentPackagesAdmitted, 3);

    // Batch of 4 with fresh runtime budget 3 → 3 admitted + 1 budget soft-fail
    process.env.NODE4_SUBAGENT_TASK_BUDGET = "3";
    const { runtime: rt2, dir: dir2 } = await makeRuntime("budget-batch");
    try {
      const tool2 = createSubagentTool(rt2);
      const out = await tool2.execute("batch-budget", {
        ...baseHandoff(),
        packages: Array.from({ length: 4 }, (_, i) => ({
          target: `http://127.0.0.1:8080/b${i}/`,
          this_turn_goal: `batch goal ${i}`,
          success_criteria: "candidates or deadend",
        })),
      });
      const body = parseToolJson(out);
      assert.equal(body.batch, true, toolText(out).slice(0, 400));
      assert.equal(body.total, 4);
      const budgetFails = (body.results || []).filter((r: any) =>
        String(r.error || r.summary || "").includes("task budget exhausted"),
      );
      const admitted = (body.results || []).filter((r: any) => r.subagent_id);
      assert.equal(admitted.length, 3, `expected 3 admitted, got ${admitted.length}`);
      assert.equal(budgetFails.length, 1, `expected 1 budget soft-fail, got ${budgetFails.length}`);
      assert.equal(rt2.lifecycle.subagentPackagesAdmitted, 3);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  } finally {
    delete process.env.NODE4_SUBAGENT_TASK_BUDGET;
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4) Nest ban still fails
// ---------------------------------------------------------------------------
{
  const { runtime, dir } = await makeRuntime("nest");
  try {
    runtime.lifecycle.subagentDepth = 1;
    const tool = createSubagentTool(runtime);
    const out = await tool.execute("nest", {
      ...baseHandoff({
        target: "http://127.0.0.1:8080/",
        this_turn_goal: "child must not spawn",
      }),
    });
    const text = toolText(out);
    assert.match(text, /nested subagent is disallowed/i);
    assert.ok((out as any).details?.isError === true || /error:/i.test(text));
    assert.equal(runtime.lifecycle.subagentPackagesAdmitted, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5) Batch length > ceiling hard errors
// ---------------------------------------------------------------------------
{
  const { runtime, dir } = await makeRuntime("batch-ceil");
  try {
    const tool = createSubagentTool(runtime);
    const over = MAX_SUBAGENT_BATCH + 1;
    const packages = Array.from({ length: over }, (_, i) => ({
      target: `http://127.0.0.1:8080/c${i}/`,
      this_turn_goal: `ceil ${i}`,
      success_criteria: "candidates or deadend",
    }));
    const out = await tool.execute("ceil", {
      ...baseHandoff(),
      packages,
    });
    const text = toolText(out);
    assert.match(text, /safety ceiling/i);
    assert.match(text, new RegExp(String(MAX_SUBAGENT_BATCH)));
    assert.ok((out as any).details?.isError === true || /error:/i.test(text));
    assert.equal(runtime.lifecycle.subagentPackagesAdmitted, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// restore env
if (prevBudget === undefined) delete process.env.NODE4_SUBAGENT_TASK_BUDGET;
else process.env.NODE4_SUBAGENT_TASK_BUDGET = prevBudget;
if (prevConc === undefined) delete process.env.NODE4_SUBAGENT_CONCURRENCY;
else process.env.NODE4_SUBAGENT_CONCURRENCY = prevConc;

console.log("subagent-limits.test.ts: ok");
