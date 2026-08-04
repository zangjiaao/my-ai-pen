/**
 * Spec #285: engagement edges runner integration (fake stage executor) + load + catalog.
 * Covers E2–E6 path through production runHardGraph (not only pure helpers).
 * Run: npx tsx src/runtime/engagement-graph-runner.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// --- E3: hop exhaust soft-lands toward book ---
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
      // Always back-edge recon↔enumerate until hop_exhausted
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
    return { structured: { ok: true, summary: input.stage.id } };
  };
  const r = await runHardGraph({
    graph: norm!,
    executeStage: exec,
    availableTools: ["todo"],
  });
  assert.ok(
    r.terminal === "completed" || r.terminal === "blocked",
    `terminal=${r.terminal}`,
  );
  assert.ok(order.includes("book") || r.terminal === "blocked");
  // Must not infinite-loop: visits bounded
  assert.ok(order.length <= 12, `order len ${order.length}: ${order.join(",")}`);
  // Prefer book soft landing when hop edges fire
  if (order.includes("book")) {
    assert.equal(r.terminal, "completed");
  }
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

// silence unused
void (null as unknown as HardGraphHandoff);

console.log("engagement-graph-runner.test.ts: ok");
