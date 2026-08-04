/**
 * Spec #285: engagement edges runner integration (fake stage executor) + load + catalog.
 * Covers E2–E6 path through production runHardGraph (not only pure helpers).
 * Also: production finalizeStage routeProjection from Product state (no manual inject).
 * Run: npx tsx src/runtime/engagement-graph-runner.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolRuntime } from "../types.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { SurfaceLedgerStore } from "../stores/surface-ledger.js";
import { TodoStore } from "../stores/todo.js";
import {
  buildProductGraphL1Catalog,
  graphHasEngagementEdges,
  isHardGraphDefinition,
  loadHardGraphFile,
  loadProductGraphL1Catalog,
  lookupProductGraphCatalog,
  normalizeHardGraphDefinition,
  resolveHardGraph,
} from "./hard-graph-definition.js";
import {
  runHardGraph,
  type HardGraphHandoff,
  type StageExecutor,
} from "./hard-graph-runner.js";
import type { HardGraphDefinition } from "./hard-graph-definition.js";
import { createHardGraphStageExecutor } from "./hard-graph-stage-executor.js";
import { createProcessQualityState } from "./package-honesty-host.js";
import { HardGraphPlanStore } from "./hard-graph-plan.js";
import { createUsageLedgerFromEnv } from "./platform-observability.js";
import { PanelAgentTracker } from "./panel-agents.js";

const repoExperts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../experts/pentest",
);

// --- E5: product load + L1 catalog ---
{
  const g = await loadHardGraphFile(repoExperts, "hypothesis_cycle");
  assert.ok(g, "hypothesis_cycle loads from pack");
  assert.equal(g!.id, "hypothesis_cycle");
  assert.equal(g!.roe?.allow_postex, false);
  assert.ok(graphHasEngagementEdges(g!));
  assert.ok(g!.edges!.length >= 10);
  assert.equal(g!.stages.map((s) => s.id).join(","), "init,recon,enumerate,validate,exploit_lite,book");

  const cat = lookupProductGraphCatalog("hypothesis_cycle");
  assert.ok(cat);
  assert.equal(cat!.hardId, "hypothesis_cycle");

  const resolved = await resolveHardGraph({
    task: { graphId: "hypothesis_cycle" },
    packRoot: repoExperts,
    packId: "pentest",
  });
  assert.equal(resolved.mode, "hard");
  if (resolved.mode === "hard") {
    assert.equal(resolved.graph.id, "hypothesis_cycle");
  }

  const l1 = await loadProductGraphL1Catalog(repoExperts);
  const row = l1.find((e) => e.id === "hypothesis_cycle");
  assert.ok(row, "hypothesis_cycle in product L1 catalog");
  assert.ok(row!.when_to_use.toLowerCase().includes("app_assessment") || row!.when_to_use.includes("评估"));
  assert.equal(row!.allow_postex, false);
  assert.ok(!l1.some((e) => e.id.endsWith("_thin")), "thin excluded from product L1");

  // app_assessment frozen: still linear (no edges)
  const assess = await loadHardGraphFile(repoExperts, "app_assessment");
  assert.ok(assess);
  assert.equal(graphHasEngagementEdges(assess!), false, "app_assessment remains ordered-only");
}

// --- S2: unknown predicate fails load ---
{
  const bad = normalizeHardGraphDefinition({
    discipline: "hard",
    id: "bad_pred",
    label: "bad",
    stages: [{ id: "init" }, { id: "recon" }],
    edges: [{ from: "init", when: "telepathy", to: "recon" }],
  });
  assert.equal(bad, null, "unknown predicate → load fail");

  assert.equal(
    isHardGraphDefinition({
      discipline: "hard",
      id: "x",
      stages: [{ id: "a" }],
      edges: "nope",
    }),
    false,
  );
}

// --- E4: linear graph without edges still ordered ---
{
  const linear: HardGraphDefinition = {
    discipline: "hard",
    id: "linear_fixture",
    label: "linear",
    stages: [
      { id: "a", require: { summary: true } },
      { id: "b", require: { summary: true } },
      { id: "c", require: { summary: true } },
    ],
  };
  const order: string[] = [];
  const exec: StageExecutor = async (input) => {
    order.push(input.stage.id);
    return { structured: { ok: true, summary: `${input.stage.id} ok` } };
  };
  const r = await runHardGraph({
    graph: linear,
    executeStage: exec,
    availableTools: ["todo", "read"],
  });
  assert.equal(r.terminal, "completed");
  assert.deepEqual(order, ["a", "b", "c"]);
}

// --- Happy cycle path with projection extras ---
{
  const g = await loadHardGraphFile(repoExperts, "hypothesis_cycle");
  assert.ok(g);
  const order: string[] = [];
  const exec: StageExecutor = async (input) => {
    order.push(input.stage.id);
    if (input.stage.id === "init") {
      return { structured: { ok: true, summary: "init ok" } };
    }
    if (input.stage.id === "recon") {
      return {
        structured: {
          ok: true,
          summary: "recon",
          surfaces: [{ location: "http://t/login", kind: "form" }],
        },
        routeProjection: { surfaces_n: 1, active_hyp_n: 0 },
      };
    }
    if (input.stage.id === "enumerate") {
      return {
        structured: { ok: true, summary: "enum" },
        routeProjection: {
          active_hyp_n: 2,
          active_complete_n: 2,
          surfaces_n: 1,
        },
      };
    }
    if (input.stage.id === "validate") {
      return {
        structured: { ok: true, summary: "validate" },
        routeProjection: {
          confirmed_unexploited_n: 1,
          active_hyp_n: 0,
        },
      };
    }
    if (input.stage.id === "exploit_lite") {
      return {
        structured: { ok: true, summary: "poc" },
        routeProjection: { store_candidates_n: 1 },
      };
    }
    return { structured: { ok: true, summary: "booked" } };
  };
  const r = await runHardGraph({
    graph: g!,
    executeStage: exec,
    availableTools: [
      "todo",
      "read",
      "fact",
      "skill",
      "write",
      "shell",
      "http",
      "finding",
      "hypothesis",
      "subagent",
    ],
  });
  assert.equal(r.terminal, "completed");
  assert.deepEqual(order, [
    "init",
    "recon",
    "enumerate",
    "validate",
    "exploit_lite",
    "book",
  ]);
  assert.ok(r.handoff.surfaces.some((s) => s.location === "http://t/login"));
}

// --- E2 via runner: enumerate → recon back-edge then forward ---
{
  const g = await loadHardGraphFile(repoExperts, "hypothesis_cycle");
  assert.ok(g);
  let enumVisits = 0;
  const order: string[] = [];
  const exec: StageExecutor = async (input) => {
    order.push(input.stage.id);
    if (input.stage.id === "init") {
      return { structured: { ok: true, summary: "init" } };
    }
    if (input.stage.id === "recon") {
      return {
        structured: {
          ok: true,
          summary: "recon",
          surfaces: [{ location: "http://t/" }],
        },
        routeProjection: { surfaces_n: 1, active_hyp_n: 0 },
      };
    }
    if (input.stage.id === "enumerate") {
      enumVisits += 1;
      if (enumVisits === 1) {
        // back-edge: zero active + open surface
        return {
          structured: { ok: true, summary: "empty enum" },
          routeProjection: {
            active_hyp_n: 0,
            active_complete_n: 0,
            surfaces_n: 1,
          },
        };
      }
      return {
        structured: { ok: true, summary: "enum filled" },
        routeProjection: {
          active_hyp_n: 2,
          active_complete_n: 2,
          surfaces_n: 1,
        },
      };
    }
    if (input.stage.id === "validate") {
      return {
        structured: { ok: true, summary: "v" },
        routeChoiceKey: "to_book",
      };
    }
    return { structured: { ok: true, summary: "done" } };
  };
  const r = await runHardGraph({
    graph: g!,
    executeStage: exec,
    availableTools: ["todo", "read", "fact", "skill", "write", "finding", "hypothesis"],
  });
  assert.equal(r.terminal, "completed");
  // recon appears twice (initial + back-edge)
  assert.ok(order.filter((x) => x === "recon").length >= 2, `order=${order.join(",")}`);
  assert.ok(order.includes("book"));
  // validate gate choice to_book skips exploit_lite
  assert.ok(!order.includes("exploit_lite") || order.indexOf("book") > order.indexOf("validate"));
  const vIdx = order.indexOf("validate");
  const bIdx = order.indexOf("book");
  assert.ok(vIdx >= 0 && bIdx > vIdx);
  assert.ok(!order.slice(vIdx + 1, bIdx).includes("exploit_lite"));
}

// --- E6 runner: invalid choice_key blocks ---
{
  const g = await loadHardGraphFile(repoExperts, "hypothesis_cycle");
  assert.ok(g);
  const exec: StageExecutor = async (input) => {
    if (input.stage.id === "init") {
      return { structured: { ok: true, summary: "i" } };
    }
    if (input.stage.id === "recon") {
      return {
        structured: {
          ok: true,
          summary: "r",
          surfaces: [{ location: "http://t/" }],
        },
        routeProjection: { surfaces_n: 1 },
      };
    }
    if (input.stage.id === "enumerate") {
      return {
        structured: { ok: true, summary: "e" },
        routeProjection: { active_complete_n: 2, active_hyp_n: 2 },
      };
    }
    if (input.stage.id === "validate") {
      return {
        structured: { ok: true, summary: "v" },
        routeChoiceKey: "to_the_moon",
      };
    }
    return { structured: { ok: true, summary: "x" } };
  };
  const r = await runHardGraph({
    graph: g!,
    executeStage: exec,
    availableTools: ["todo", "read", "finding", "hypothesis"],
  });
  assert.equal(r.terminal, "blocked");
  assert.ok(!r.stages.some((s) => s.stageId === "book" && s.outcome === "passed"));
}

// --- E3: hop exhaust soft-lands toward book (open surfaces must not continue cycle) ---
{
  const tiny: HardGraphDefinition = {
    discipline: "hard",
    id: "hop_budget_fixture",
    label: "hop",
    route_budgets: { global_hop: 4 },
    stages: [
      { id: "init", require: { summary: true } },
      { id: "recon", require: { summary: true } },
      { id: "enumerate", require: { summary: true } },
      { id: "book", intent: "book", require: { summary: true } },
    ],
    edges: [
      { from: "init", when: "stage_pass", to: "recon", priority: 10 },
      // Work edges higher priority than hop_exhausted — hard pre-check must still soft-land
      { from: "recon", when: "hop_exhausted", to: "book", priority: 5 },
      { from: "recon", when: "always", to: "enumerate", priority: 20 },
      { from: "enumerate", when: "hop_exhausted", to: "book", priority: 5 },
      {
        from: "enumerate",
        when: "always",
        to: "recon",
        priority: 20,
        hot_back_edge: true,
      },
    ],
  };
  const norm = normalizeHardGraphDefinition(tiny);
  assert.ok(norm);
  const order: string[] = [];
  const exec: StageExecutor = async (input) => {
    order.push(input.stage.id);
    // Keep surfaces open so work edges would match without hop hard-precheck
    return {
      structured: {
        ok: true,
        summary: input.stage.id,
        surfaces: [{ location: "http://open/" }],
      },
      routeProjection: { surfaces_n: 3, active_hyp_n: 1 },
    };
  };
  const r = await runHardGraph({
    graph: norm!,
    executeStage: exec,
    availableTools: ["todo"],
  });
  assert.equal(r.terminal, "completed", `terminal=${r.terminal} order=${order.join(",")}`);
  assert.ok(order.includes("book"), `must book via hop_exhausted: ${order.join(",")}`);
  // Visits: hop budget 4 entries + soft-land book entry ≤ 5 (+ small slack for init path)
  assert.ok(
    order.length <= 6,
    `visit count ${order.length} exceeds hop budget soft-land bound: ${order.join(",")}`,
  );
  // book is last successful path — not maxLoopIters-only salvage without book
  assert.equal(order[order.length - 1], "book");
}

// --- exploit_failed_retry_validate only on explicit signal (not empty store) ---
{
  const g = await loadHardGraphFile(repoExperts, "hypothesis_cycle");
  assert.ok(g);
  const order: string[] = [];
  let exploitVisits = 0;
  const exec: StageExecutor = async (input) => {
    order.push(input.stage.id);
    if (input.stage.id === "init") return { structured: { ok: true, summary: "i" } };
    if (input.stage.id === "recon") {
      return {
        structured: {
          ok: true,
          summary: "r",
          surfaces: [{ location: "http://t/" }],
        },
        routeProjection: { surfaces_n: 1 },
      };
    }
    if (input.stage.id === "enumerate") {
      return {
        structured: { ok: true, summary: "e" },
        routeProjection: { active_complete_n: 2, active_hyp_n: 2 },
      };
    }
    if (input.stage.id === "validate") {
      return {
        structured: { ok: true, summary: "v" },
        routeProjection: { confirmed_unexploited_n: 1 },
      };
    }
    if (input.stage.id === "exploit_lite") {
      exploitVisits += 1;
      if (exploitVisits === 1) {
        // Explicit host signal (priority 40), not empty-store invent
        return {
          structured: { ok: true, summary: "exploit miss" },
          routeProjection: {
            stage_pass: true,
            exploit_failed: true,
            store_candidates_n: 0,
          },
        };
      }
      return {
        structured: { ok: true, summary: "exploit ok" },
        routeProjection: {
          stage_pass: true,
          exploit_failed: false,
          store_candidates_n: 1,
        },
      };
    }
    return { structured: { ok: true, summary: "b" } };
  };
  const r = await runHardGraph({
    graph: g!,
    executeStage: exec,
    availableTools: ["todo", "read", "finding", "hypothesis"],
  });
  assert.equal(r.terminal, "completed");
  assert.ok(exploitVisits >= 1);
  const firstEx = order.indexOf("exploit_lite");
  assert.ok(firstEx >= 0);
  assert.ok(
    order.slice(firstEx + 1).includes("validate"),
    `explicit exploit_failed must return to validate: ${order.join(",")}`,
  );
}

// --- Honest empty exploit_lite → book (no validate thrash) ---
{
  const g = await loadHardGraphFile(repoExperts, "hypothesis_cycle");
  assert.ok(g);
  const order: string[] = [];
  const exec: StageExecutor = async (input) => {
    order.push(input.stage.id);
    if (input.stage.id === "init") return { structured: { ok: true, summary: "i" } };
    if (input.stage.id === "recon") {
      return {
        structured: {
          ok: true,
          summary: "r",
          surfaces: [{ location: "http://t/" }],
        },
        routeProjection: { surfaces_n: 1 },
      };
    }
    if (input.stage.id === "enumerate") {
      return {
        structured: { ok: true, summary: "e" },
        routeProjection: { active_complete_n: 2, active_hyp_n: 2 },
      };
    }
    if (input.stage.id === "validate") {
      return {
        structured: { ok: true, summary: "v" },
        routeProjection: { confirmed_unexploited_n: 1 },
      };
    }
    if (input.stage.id === "exploit_lite") {
      // Empty store + no exploit_failed signal → stage_pass → book
      return {
        structured: {
          ok: true,
          summary: "honest deadend",
          deadends: ["no app-layer poc"],
        },
        routeProjection: {
          stage_pass: true,
          exploit_failed: false,
          store_candidates_n: 0,
        },
      };
    }
    return { structured: { ok: true, summary: "b" } };
  };
  const r = await runHardGraph({
    graph: g!,
    executeStage: exec,
    availableTools: ["todo", "read", "finding", "hypothesis"],
  });
  assert.equal(r.terminal, "completed");
  assert.ok(order.includes("exploit_lite"));
  assert.ok(order.includes("book"));
  const ex = order.indexOf("exploit_lite");
  const book = order.indexOf("book");
  assert.ok(book > ex);
  assert.ok(
    !order.slice(ex + 1, book).includes("validate"),
    `honest empty must not thrash validate: ${order.join(",")}`,
  );
}

// --- Gate valid choice selects edge ---
{
  const g = await loadHardGraphFile(repoExperts, "hypothesis_cycle");
  assert.ok(g);
  const order: string[] = [];
  const exec: StageExecutor = async (input) => {
    order.push(input.stage.id);
    if (input.stage.id === "init") return { structured: { ok: true, summary: "i" } };
    if (input.stage.id === "recon") {
      return {
        structured: {
          ok: true,
          summary: "r",
          surfaces: [{ location: "http://t/" }],
        },
        routeProjection: { surfaces_n: 1 },
      };
    }
    if (input.stage.id === "enumerate") {
      return {
        structured: { ok: true, summary: "e" },
        routeProjection: { active_complete_n: 2, active_hyp_n: 2 },
      };
    }
    if (input.stage.id === "validate") {
      return {
        structured: { ok: true, summary: "v" },
        routeChoiceKey: "to_exploit_lite",
      };
    }
    if (input.stage.id === "exploit_lite") {
      return { structured: { ok: true, summary: "x" } };
    }
    return { structured: { ok: true, summary: "b" } };
  };
  const r = await runHardGraph({
    graph: g!,
    executeStage: exec,
    availableTools: ["todo", "read", "finding", "hypothesis"],
  });
  assert.equal(r.terminal, "completed");
  assert.ok(order.includes("exploit_lite"));
  assert.ok(order.indexOf("exploit_lite") > order.indexOf("validate"));
}

// L1 pure build includes hypothesis_cycle when definition provided
{
  const g = await loadHardGraphFile(repoExperts, "hypothesis_cycle");
  const rows = buildProductGraphL1Catalog([g!]);
  assert.ok(rows.some((r) => r.id === "hypothesis_cycle"));
}

// --- Production finalize: routeProjection from Product state (NO manual inject) ---
{
  const g = await loadHardGraphFile(repoExperts, "hypothesis_cycle");
  assert.ok(g);
  const taskDir = await mkdtemp(join(tmpdir(), "hg-route-prod-"));
  await mkdir(taskDir, { recursive: true });
  const pq = createProcessQualityState();
  // Seed two complete active hyps — finalize must count them without routeProjection inject
  pq.hypothesisStore.upsert({
    statement: "SQLi on login",
    signal: "error-based reflection",
    prove_if: "union select returns marker",
    disprove_if: "parameterized no error",
  });
  pq.hypothesisStore.upsert({
    statement: "XSS in search",
    signal: "reflected param",
    prove_if: "alert payload executes",
    disprove_if: "encoded output",
  });
  const plan = new HardGraphPlanStore(g!);
  const parentRuntime = {
    task: {
      taskId: "route-prod",
      conversationId: "c1",
      instruction: "assess",
      workspaceDir: taskDir,
      expertId: "e1",
      expertName: "Expert",
    },
    workspaceDir: taskDir,
    taskDir,
    platform: { send: async () => {} },
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals: new GoalStore(),
    processFacts: new ProcessFactStore(join(taskDir, "facts")),
    surfaceLedger: new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(taskDir)),
    lifecycle: {
      processQuality: pq,
      hardGraphRun: {
        plan,
        usage: createUsageLedgerFromEnv(),
        panel: new PanelAgentTracker("route-prod", "Expert"),
        stageId: "enumerate",
      },
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
      label: "P",
      system: "t",
      tools: ["todo", "fact", "hypothesis"],
    } as any,
    sessionFactory: async () => ({
      summary: "enumerate done",
      structured: {
        ok: true,
        summary: "enumerate done",
        // Gate choice via typed structured field (production path; raw preserves payload)
        route_choice_key: "to_book",
      },
      hostInject: {
        ok: true,
        summary: "enumerate done",
        surfaces: [{ location: "http://live/login", kind: "form" }],
      },
    }),
  });

  const enumStage = g!.stages.find((s) => s.id === "enumerate")!;
  const out = await executor({
    graphId: g!.id,
    stage: enumStage,
    stageIndex: 2,
    stageAttempt: 1,
    tools: ["todo", "fact", "hypothesis"],
    toolProfile: {},
    handoff: {
      summary: "recon",
      surfaces: [{ location: "http://live/login", kind: "form" }],
      candidates: [],
      facts: [],
      deadends: [],
      completed_stages: ["init", "recon"],
    },
  });

  assert.ok(out.routeProjection, "production finalize must emit routeProjection");
  assert.equal(
    out.routeProjection!.active_complete_n,
    2,
    "active complete hyps from Product store",
  );
  assert.equal(out.routeProjection!.active_hyp_n, 2);
  assert.ok(
    (out.routeProjection!.surfaces_n ?? 0) >= 1,
    "surfaces from ledger/handoff",
  );
  // Gate key from typed structured field on raw — not manual routeChoiceKey inject
  assert.equal(out.routeChoiceKey, "to_book");

  // Full runner path: production executor, no manual routeProjection on StageExecutorOutput
  const order: string[] = [];
  const prodExec = createHardGraphStageExecutor({
    config: {
      workspaceDir: taskDir,
      piAgentDir: join(taskDir, "pi2"),
      modelId: "test",
      modelProvider: "openai",
    } as any,
    parentRuntime,
    pack: {
      id: "pentest",
      label: "P",
      system: "t",
      tools: ["todo", "fact", "hypothesis", "finding"],
    } as any,
    sessionFactory: async ({ stageId }) => {
      order.push(stageId);
      if (stageId === "init") {
        return { summary: "init", structured: { ok: true, summary: "init ok" } };
      }
      if (stageId === "recon") {
        return {
          summary: "recon",
          structured: { ok: true, summary: "recon ok" },
          hostInject: {
            ok: true,
            summary: "recon",
            surfaces: [{ location: "http://live/" }],
          },
        };
      }
      if (stageId === "enumerate") {
        // hyps already seeded on pq
        return { summary: "enum", structured: { ok: true, summary: "enum ok" } };
      }
      if (stageId === "validate") {
        pq.hypothesisStore.commit({
          id: pq.hypothesisStore.list({ status: "active" })[0]!.id,
          status: "confirmed",
        });
        return {
          summary: "validate",
          structured: {
            ok: true,
            summary: "validate ok",
            choice_key: "to_book",
          },
        };
      }
      return { summary: stageId, structured: { ok: true, summary: `${stageId} ok` } };
    },
  });

  const run = await runHardGraph({
    graph: g!,
    executeStage: prodExec,
    availableTools: ["todo", "fact", "skill", "write", "hypothesis", "finding"],
  });
  assert.equal(run.terminal, "completed", `order=${order.join(",")}`);
  assert.ok(order.includes("enumerate"));
  assert.ok(order.includes("validate") || order.includes("book"));
  // Must reach book without thrashing forever on incomplete zeros
  assert.ok(order.includes("book"), `prod path must book: ${order.join(",")}`);
  assert.ok(
    !order.every((s) => s === "recon" || s === "enumerate" || s === "init"),
    "must progress past recon/enumerate thrash",
  );
}

// --- Production finalize: empty store + honest deadend ≠ exploit_failed ---
{
  const g = await loadHardGraphFile(repoExperts, "hypothesis_cycle");
  assert.ok(g);
  const taskDir = await mkdtemp(join(tmpdir(), "hg-exploit-honest-"));
  await mkdir(taskDir, { recursive: true });
  const pq = createProcessQualityState();
  const plan = new HardGraphPlanStore(g!);
  const parentRuntime = {
    task: {
      taskId: "ex-honest",
      conversationId: "c1",
      instruction: "assess",
      workspaceDir: taskDir,
      expertId: "e1",
      expertName: "Expert",
    },
    workspaceDir: taskDir,
    taskDir,
    platform: { send: async () => {} },
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals: new GoalStore(),
    processFacts: new ProcessFactStore(join(taskDir, "facts")),
    surfaceLedger: new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(taskDir)),
    lifecycle: {
      processQuality: pq,
      hardGraphRun: {
        plan,
        usage: createUsageLedgerFromEnv(),
        panel: new PanelAgentTracker("ex-honest", "Expert"),
        stageId: "exploit_lite",
      },
      toolsInLastSegment: 0,
      subagentDepth: 0,
      recentObservations: [],
      subagentEvidenceCache: [],
    },
  } as unknown as ToolRuntime;

  const exploitStage = g!.stages.find((s) => s.id === "exploit_lite")!;
  const honestExec = createHardGraphStageExecutor({
    config: {
      workspaceDir: taskDir,
      piAgentDir: join(taskDir, "pi"),
      modelId: "test",
      modelProvider: "openai",
    } as any,
    parentRuntime,
    pack: { id: "pentest", label: "P", system: "t", tools: ["todo"] } as any,
    sessionFactory: async () => ({
      summary: "honest deadend",
      structured: {
        ok: true,
        summary: "honest deadend",
        deadends: ["no app-layer poc available"],
      },
    }),
  });
  const honestOut = await honestExec({
    graphId: g!.id,
    stage: exploitStage,
    stageIndex: 4,
    stageAttempt: 1,
    tools: ["todo"],
    toolProfile: {},
    handoff: {
      summary: "prior",
      surfaces: [{ location: "http://t/" }],
      candidates: [],
      facts: [],
      deadends: [],
      completed_stages: ["init", "recon", "enumerate", "validate"],
    },
  });
  assert.ok(honestOut.routeProjection);
  assert.equal(
    honestOut.routeProjection!.exploit_failed,
    false,
    "empty store must not invent exploit_failed",
  );
  assert.equal(honestOut.routeProjection!.stage_pass, true);
  assert.equal(honestOut.routeProjection!.store_candidates_n, 0);

  // Free-text deadend must NOT invent exploit_failed on production finalize
  const proseExec = createHardGraphStageExecutor({
    config: {
      workspaceDir: taskDir,
      piAgentDir: join(taskDir, "pi-prose"),
      modelId: "test",
      modelProvider: "openai",
    } as any,
    parentRuntime,
    pack: { id: "pentest", label: "P", system: "t", tools: ["todo"] } as any,
    sessionFactory: async () => ({
      summary: "prose",
      structured: {
        ok: true,
        summary: "looks like retry",
        deadends: ["exploit_failed=true"],
      },
    }),
  });
  const proseOut = await proseExec({
    graphId: g!.id,
    stage: exploitStage,
    stageIndex: 4,
    stageAttempt: 1,
    tools: ["todo"],
    toolProfile: {},
    handoff: {
      summary: "prior",
      surfaces: [{ location: "http://t/" }],
      candidates: [],
      facts: [],
      deadends: [],
      completed_stages: ["init", "recon", "enumerate", "validate"],
    },
  });
  assert.equal(
    proseOut.routeProjection!.exploit_failed,
    false,
    "production finalize must not scrape deadends for exploit_failed",
  );

  // Explicit typed structured field → exploit_failed (raw preserves payload)
  const retryExec = createHardGraphStageExecutor({
    config: {
      workspaceDir: taskDir,
      piAgentDir: join(taskDir, "pi-r"),
      modelId: "test",
      modelProvider: "openai",
    } as any,
    parentRuntime,
    pack: { id: "pentest", label: "P", system: "t", tools: ["todo"] } as any,
    sessionFactory: async () => ({
      summary: "retry",
      structured: {
        ok: true,
        summary: "retry validate",
        exploit_failed: true,
      },
    }),
  });
  const retryOut = await retryExec({
    graphId: g!.id,
    stage: exploitStage,
    stageIndex: 4,
    stageAttempt: 1,
    tools: ["todo"],
    toolProfile: {},
    handoff: {
      summary: "prior",
      surfaces: [{ location: "http://t/" }],
      candidates: [],
      facts: [],
      deadends: [],
      completed_stages: ["init", "recon", "enumerate", "validate"],
    },
  });
  assert.equal(retryOut.routeProjection!.exploit_failed, true);
  assert.equal(retryOut.routeProjection!.stage_pass, true);
}

// --- Production: empty recon soft-lands to book via empty_recon edge ---
{
  const g = await loadHardGraphFile(repoExperts, "hypothesis_cycle");
  assert.ok(g);
  const order: string[] = [];
  const exec: StageExecutor = async (input) => {
    order.push(input.stage.id);
    return {
      structured: { ok: true, summary: `${input.stage.id} ok` },
      // zero surfaces / hyps — recon empty_recon → book (not unmatched blocked)
      routeProjection: {
        stage_pass: true,
        surfaces_n: 0,
        active_hyp_n: 0,
        active_complete_n: 0,
      },
    };
  };
  const run = await runHardGraph({
    graph: g!,
    executeStage: exec,
    availableTools: ["todo", "fact", "skill", "write", "hypothesis", "finding"],
  });
  assert.equal(run.terminal, "completed", `order=${order.join(",")}`);
  assert.deepEqual(
    order,
    ["init", "recon", "book"],
    `empty recon must soft-land to book: ${order.join(",")}`,
  );
}

// silence unused
void (null as unknown as HardGraphHandoff);

console.log("engagement-graph-runner.test.ts: ok");
