/**
 * Spec #281 S1 — todo tool + Graph plan merge seam (no full LLM).
 * Run: npx tsx src/tools/todo-graph-stage-scope.test.ts
 */
import assert from "node:assert/strict";
import { createTodoTool } from "./todo.js";
import { TodoStore } from "../stores/todo.js";
import type { ToolRuntime } from "../types.js";
import { HardGraphPlanStore } from "../runtime/hard-graph-plan.js";
import type { HardGraphDefinition } from "../runtime/hard-graph-definition.js";

const graphDef: HardGraphDefinition = {
  discipline: "hard",
  id: "app_assessment",
  stages: [
    {
      id: "init",
      success: "ok",
      require: { summary: true },
      tools: { allow: ["todo"] },
      max_retries: 0,
    },
    {
      id: "surface",
      success: "ok",
      require: { summary: true },
      tools: { allow: ["todo"] },
      max_retries: 0,
    },
  ],
};

const parentTask = {
  taskId: "t-s1",
  conversationId: "c-s1",
  instruction: "assess",
  expertId: "e1",
  expertName: "Expert",
};

type ExecResult = {
  content: Array<{ type: string; text?: string }>;
  details?: Record<string, unknown>;
};

function parseToolText(r: ExecResult): string {
  return r.content.map((c) => c.text || "").join("\n");
}

function makeGraphRuntime(opts: {
  plan: HardGraphPlanStore;
  stageId: string;
  todo?: TodoStore;
  platformMessages?: Array<Record<string, unknown>>;
}): ToolRuntime {
  const platformMessages = opts.platformMessages || [];
  return {
    task: parentTask,
    workspaceDir: "/tmp",
    taskDir: "/tmp",
    platform: {
      send: async (msg: Record<string, unknown>) => {
        platformMessages.push(msg);
      },
    },
    todo: opts.todo || new TodoStore(),
    evidence: {
      create: async () => ({ id: "e", path: "" }),
      read: async () => undefined,
      list: async () => [],
    },
    findingsDir: "/tmp/findings",
    goals: { get: () => undefined },
    lifecycle: {
      subagentDepth: 0,
      hardGraphRun: {
        plan: opts.plan,
        usage: {} as any,
        panel: {} as any,
        stageId: opts.stageId,
      },
    },
  } as unknown as ToolRuntime;
}

function makeFreeRuntime(opts?: {
  todo?: TodoStore;
  platformMessages?: Array<Record<string, unknown>>;
}): ToolRuntime {
  const platformMessages = opts?.platformMessages || [];
  return {
    task: parentTask,
    workspaceDir: "/tmp",
    taskDir: "/tmp",
    platform: {
      send: async (msg: Record<string, unknown>) => {
        platformMessages.push(msg);
      },
    },
    todo: opts?.todo || new TodoStore(),
    evidence: {
      create: async () => ({ id: "e", path: "" }),
      read: async () => undefined,
      list: async () => [],
    },
    findingsDir: "/tmp/findings",
    goals: { get: () => undefined },
    lifecycle: {
      subagentDepth: 0,
      // Free: no hardGraphRun
    },
  } as unknown as ToolRuntime;
}

// ---------------------------------------------------------------------------
// S1.1 Graph + stageId=init; todo(init) single-phase → ok; L2 parents = graph-stage-init
// ---------------------------------------------------------------------------
{
  const plan = new HardGraphPlanStore(graphDef);
  plan.setStageStatus("init", "running");
  const platformMessages: Array<Record<string, unknown>> = [];
  const runtime = makeGraphRuntime({ plan, stageId: "init", platformMessages });
  const todo = createTodoTool(runtime);
  const exec = todo.execute as (id: string, params: Record<string, unknown>) => Promise<ExecResult>;

  const r = await exec("x", {
    op: "init",
    list: [{ phase: "init", items: ["Confirm RoE", "Build stage plan"] }],
  });
  const text = parseToolText(r);
  assert.ok(!text.startsWith("error:"), `single-phase init should succeed, got: ${text.slice(0, 200)}`);
  assert.notEqual(r.details?.isError, true, "single-phase not error");

  const tree = plan.toPlanTree();
  const l2 = tree.filter((n) => n.level === "work_item");
  assert.ok(l2.length >= 2, `expected L2 items under init, got ${l2.length}`);
  for (const n of l2) {
    assert.equal(
      String(n.parent_id || ""),
      "graph-stage-init",
      `L2 parent must be graph-stage-init, got ${n.parent_id} for ${n.title}`,
    );
  }
  assert.ok(
    platformMessages.some((m) => m.type === "plan_tree_updated"),
    "Graph single-phase init emits plan_tree_updated",
  );
}

// ---------------------------------------------------------------------------
// S1.2 Graph + stageId=init; multi-phase whole map → error; no mass L2 under init
// ---------------------------------------------------------------------------
{
  const plan = new HardGraphPlanStore(graphDef);
  plan.setStageStatus("init", "running");
  const treeBefore = plan.toPlanTree().map((n) => ({ ...n }));
  const l2Before = treeBefore.filter((n) => n.level === "work_item" && n.parent_id === "graph-stage-init");
  const platformMessages: Array<Record<string, unknown>> = [];
  const runtime = makeGraphRuntime({ plan, stageId: "init", platformMessages });
  const todo = createTodoTool(runtime);
  const exec = todo.execute as (id: string, params: Record<string, unknown>) => Promise<ExecResult>;

  const r = await exec("x", {
    op: "init",
    list: [
      { phase: "init", items: ["RoE"] },
      { phase: "recon", items: ["Web recon"] },
      { phase: "auth", items: ["Login"] },
      { phase: "vuln", items: ["Scan"] },
    ],
  });
  const text = parseToolText(r);
  assert.ok(text.includes("current stage only") || text.includes("error:"), `expected reject: ${text.slice(0, 240)}`);
  assert.equal(r.details?.isError, true, "multi-phase whole map is error");

  const l2After = plan
    .toPlanTree()
    .filter((n) => n.level === "work_item" && String(n.parent_id || "") === "graph-stage-init");
  assert.equal(
    l2After.length,
    l2Before.length,
    "no mass L2 under init after rejected multi-phase init",
  );
  assert.ok(
    !l2After.some((n) => /recon|vuln|Login|Scan/i.test(String(n.title || ""))),
    "rejected map items must not land under init",
  );
  assert.equal(
    platformMessages.filter((m) => m.type === "plan_tree_updated").length,
    0,
    "rejected init must not emit plan_tree_updated",
  );
  assert.equal(runtime.todo.openCount(), 0, "TodoStore unchanged on Graph reject");
}

// ---------------------------------------------------------------------------
// S1.3 Free; multi-phase todo(init) → ok regression
// ---------------------------------------------------------------------------
{
  const platformMessages: Array<Record<string, unknown>> = [];
  const runtime = makeFreeRuntime({ platformMessages });
  const todo = createTodoTool(runtime);
  const exec = todo.execute as (id: string, params: Record<string, unknown>) => Promise<ExecResult>;

  const r = await exec("x", {
    op: "init",
    list: [
      { phase: "init", items: ["RoE"] },
      { phase: "recon", items: ["Web recon"] },
      { phase: "auth", items: ["Login"] },
      { phase: "vuln", items: ["Scan"] },
    ],
  });
  const text = parseToolText(r);
  assert.ok(!text.startsWith("error:"), `Free multi-phase must succeed: ${text.slice(0, 200)}`);
  assert.notEqual(r.details?.isError, true);
  assert.ok(runtime.todo.openCount() >= 4, "Free multi-phase populated TodoStore");
  assert.ok(
    platformMessages.some((m) => m.type === "plan_tree_updated"),
    "Free path still emits Todo plan_tree",
  );
}

// ---------------------------------------------------------------------------
// Spec #313 S2: Free silent todo.init replace denied; allow_replace + maintain ok
// ---------------------------------------------------------------------------
{
  const platformMessages: Array<Record<string, unknown>> = [];
  const runtime = makeFreeRuntime({ platformMessages });
  const todo = createTodoTool(runtime);
  const exec = todo.execute as (id: string, params: Record<string, unknown>) => Promise<ExecResult>;

  const first = await exec("x", {
    op: "init",
    list: [{ phase: "Tasks", items: ["Map surface", "Probe auth"] }],
  });
  assert.notEqual(first.details?.isError, true, "first Free init ok");
  assert.equal(runtime.todo.openCount(), 2);

  const wipe = await exec("x", {
    op: "init",
    list: [{ phase: "Tasks", items: ["Brand new A", "Brand new B", "Brand new C"] }],
  });
  assert.equal(wipe.details?.isError, true, "silent Free replace denied");
  assert.equal(runtime.todo.openCount(), 2, "map unchanged after denied wipe");
  const wipeText = parseToolText(wipe);
  assert.ok(
    /allow_replace|forbidden|replace/i.test(wipeText) || wipeText.includes("already exists"),
    `deny message: ${wipeText.slice(0, 200)}`,
  );

  const append = await exec("x", {
    op: "append",
    phase: "Tasks",
    items: ["Deepen XSS"],
  });
  assert.notEqual(append.details?.isError, true, "append still works after decline");
  assert.ok(runtime.todo.openCount() >= 3);

  const permitted = await exec("x", {
    op: "init",
    allow_replace: true,
    list: [{ phase: "Tasks", items: ["Replanned only"] }],
  });
  assert.notEqual(permitted.details?.isError, true, "allow_replace permits full replace");
  assert.equal(runtime.todo.openCount(), 1);
}

// ---------------------------------------------------------------------------
// S1.4 After neutralize + stage done → no running L2 under that stage
// ---------------------------------------------------------------------------
{
  const plan = new HardGraphPlanStore(graphDef);
  plan.setStageStatus("init", "running");
  plan.setStageTodos("init", [
    { node_id: "todo-roe", title: "Confirm RoE", status: "done", level: "work_item" },
    { node_id: "todo-recon", title: "Web recon", status: "running", level: "work_item" },
  ]);
  // stage_end path (HardGraphPlanStore.neutralizeOpenRunningL2) — unit on store is enough
  // when tool path for setStageTodos is covered above.
  plan.neutralizeOpenRunningL2("init");
  plan.setStageStatus("init", "done");
  plan.setStageStatus("surface", "running");

  const tree = plan.toPlanTree();
  const initL2 = tree.filter(
    (n) => n.level === "work_item" && String(n.parent_id || "") === "graph-stage-init",
  );
  assert.ok(initL2.length >= 1, "history L2 under init retained");
  for (const n of initL2) {
    assert.notEqual(String(n.status), "running", `no running L2 under done init: ${n.title}=${n.status}`);
  }
  const initL1 = tree.find((n) => n.node_id === "graph-stage-init");
  assert.equal(String(initL1?.status), "done");
  const surfaceL1 = tree.find((n) => n.node_id === "graph-stage-surface");
  assert.equal(String(surfaceL1?.status), "running");
}

console.log("todo-graph-stage-scope.test.ts: ok");
