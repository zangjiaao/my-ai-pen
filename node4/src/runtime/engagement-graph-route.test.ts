/**
 * Spec #285 S1 pure route seam + edge load + budgets (E1–E3, E6).
 * Run: npx tsx src/runtime/engagement-graph-route.test.ts
 */
import assert from "node:assert/strict";
import {
  applyRouteCounters,
  buildEngagementRouteSlicesFromProductState,
  buildRouteProjection,
  DEFAULT_GLOBAL_HOP,
  emptyRouteCounters,
  gateChoiceKeysForNode,
  hypothesisCycleEdgeTable,
  HYPOTHESIS_CYCLE_STAGE_IDS,
  isKnownRoutePredicateId,
  parseEngagementEdges,
  parseExploitFailedFromStructured,
  parseRouteChoiceKeyFromStructured,
  routeEngagementGraph,
  validateEngagementEdgeTable,
  type EngagementGraphEdge,
  type RouteProjection,
} from "./engagement-graph-route.js";

function baseProj(over: Partial<RouteProjection> = {}): RouteProjection {
  return buildRouteProjection({
    stage_pass: true,
    hops_used: 0,
    hop_budget: DEFAULT_GLOBAL_HOP,
    active_hyp_n: 0,
    active_complete_n: 0,
    surfaces_n: 0,
    confirmed_unexploited_n: 0,
    store_candidates_n: 0,
    ...over,
  });
}

const edges = hypothesisCycleEdgeTable();
const stageIds = [...HYPOTHESIS_CYCLE_STAGE_IDS];

// --- S2 load validation ---
{
  const ok = validateEngagementEdgeTable({ stageIds, edges });
  assert.equal(ok.ok, true, "hypothesis_cycle edge table loads");

  const badPred = validateEngagementEdgeTable({
    stageIds,
    edges: [{ from: "init", when: "llm_feels_like_it", to: "recon" }],
  });
  assert.equal(badPred.ok, false, "unknown predicate fails load");
  if (!badPred.ok) {
    assert.match(badPred.error, /unknown predicate/);
  }

  const badNode = validateEngagementEdgeTable({
    stageIds,
    edges: [{ from: "init", when: "stage_pass", to: "nope" }],
  });
  assert.equal(badNode.ok, false);

  assert.equal(isKnownRoutePredicateId("stage_pass"), true);
  assert.equal(isKnownRoutePredicateId("invented"), false);

  const parsed = parseEngagementEdges([
    { from: "init", when: "stage_pass", to: "recon", priority: 10 },
  ]);
  assert.ok(parsed);
  assert.equal(parsed!.length, 1);
  assert.equal(parseEngagementEdges("not-array"), null);
}

// --- E1: fixture + projection → correct next ---
{
  const r1 = routeEngagementGraph({
    current: "init",
    edges,
    projection: baseProj({ stage_pass: true }),
  });
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.next, "recon");
    assert.equal(r1.key, "stage_pass");
  }

  const rFail = routeEngagementGraph({
    current: "init",
    edges,
    projection: baseProj({ stage_pass: false }),
  });
  assert.equal(rFail.ok, false);
  if (!rFail.ok) assert.equal(rFail.code, "unmatched");

  // recon → enumerate via surfaces
  const r2 = routeEngagementGraph({
    current: "recon",
    edges,
    projection: baseProj({ surfaces_n: 2, active_hyp_n: 0 }),
  });
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.next, "enumerate");

  // recon → enumerate via active hyp (higher priority than surfaces alone path still enumerate)
  const r3 = routeEngagementGraph({
    current: "recon",
    edges,
    projection: baseProj({ active_hyp_n: 1, surfaces_n: 0 }),
  });
  assert.equal(r3.ok, true);
  if (r3.ok) {
    assert.equal(r3.next, "enumerate");
    assert.equal(r3.key, "active_hyp_ge_1");
  }

  // priority: higher first
  const prioEdges: EngagementGraphEdge[] = [
    { from: "a", when: "always", to: "low", priority: 1 },
    { from: "a", when: "always", to: "high", priority: 10 },
  ];
  const rp = routeEngagementGraph({
    current: "a",
    edges: prioEdges,
    projection: baseProj(),
  });
  assert.equal(rp.ok, true);
  if (rp.ok) assert.equal(rp.next, "high");
}

// --- E2: back-edge enumerate → recon; counter; cap blocks ---
{
  let counters = emptyRouteCounters();
  const proj = baseProj({ active_hyp_n: 0, surfaces_n: 3 });
  const r = routeEngagementGraph({
    current: "enumerate",
    edges,
    projection: proj,
    counters,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.next, "recon");
    assert.equal(r.is_hot_back_edge, true);
    assert.equal(r.edge_key, "enumerate->recon");
    counters = applyRouteCounters(counters, r);
  }
  assert.equal(counters.back_edge_counts["enumerate->recon"], 1);

  // take 3 times total — 4th blocked, fall through
  counters = emptyRouteCounters();
  for (let i = 0; i < 3; i++) {
    const ri = routeEngagementGraph({
      current: "enumerate",
      edges,
      projection: proj,
      counters,
    });
    assert.equal(ri.ok, true);
    if (ri.ok) {
      assert.equal(ri.next, "recon");
      counters = applyRouteCounters(counters, ri);
    }
  }
  assert.equal(counters.back_edge_counts["enumerate->recon"], 3);

  // Cap blocks further same edge; with no other match → unmatched
  const blocked = routeEngagementGraph({
    current: "enumerate",
    edges,
    projection: proj,
    counters,
  });
  assert.equal(blocked.ok, false, "cap blocks further enumerate→recon");
  if (!blocked.ok) {
    assert.ok(
      blocked.code === "unmatched" || blocked.code === "hop_soft_landing",
      blocked.reason,
    );
  }
}

// --- E3: global hop exhaust → soft landing toward book (hard pre-route) ---
{
  const r = routeEngagementGraph({
    current: "recon",
    edges,
    projection: baseProj({
      hops_used: DEFAULT_GLOBAL_HOP,
      hop_budget: DEFAULT_GLOBAL_HOP,
      surfaces_n: 0,
      active_hyp_n: 0,
    }),
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.next, "book");
    assert.equal(r.key, "hop_exhausted");
  }

  // Hard pre-check: open surfaces must NOT continue cycle when hop exhausted
  const withSurfaces = routeEngagementGraph({
    current: "recon",
    edges,
    projection: baseProj({
      hops_used: DEFAULT_GLOBAL_HOP,
      hop_budget: DEFAULT_GLOBAL_HOP,
      surfaces_n: 3,
      active_hyp_n: 1,
    }),
  });
  assert.equal(withSurfaces.ok, true, "hop exhaust overrides work edges");
  if (withSurfaces.ok) {
    assert.equal(withSurfaces.next, "book");
    assert.equal(withSurfaces.key, "hop_exhausted");
  }

  // No hop_exhausted edge → soft landing code even with open surfaces
  const linearish: EngagementGraphEdge[] = [
    { from: "recon", when: "surfaces_ge_1", to: "enumerate", priority: 10 },
  ];
  const soft = routeEngagementGraph({
    current: "recon",
    edges: linearish,
    projection: baseProj({
      hops_used: 25,
      hop_budget: 25,
      surfaces_n: 5,
    }),
    soft_landing_book_id: "book",
  });
  assert.equal(soft.ok, false);
  if (!soft.ok) {
    assert.equal(soft.code, "hop_soft_landing");
    assert.equal(soft.soft_landing_to, "book");
  }
}

// --- E6: gate choice_key ---
{
  const keys = gateChoiceKeysForNode(edges, "validate");
  assert.deepEqual(keys, ["to_book", "to_enumerate", "to_exploit_lite"]);

  const valid = routeEngagementGraph({
    current: "validate",
    edges,
    projection: baseProj({ choice_key: "to_enumerate" }),
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.next, "enumerate");
    assert.equal(valid.key, "to_enumerate");
  }

  const valid2 = routeEngagementGraph({
    current: "validate",
    edges,
    projection: baseProj({
      choice_key: "to_exploit_lite",
      confirmed_unexploited_n: 0,
    }),
  });
  assert.equal(valid2.ok, true);
  if (valid2.ok) assert.equal(valid2.next, "exploit_lite");

  const invalid = routeEngagementGraph({
    current: "validate",
    edges,
    projection: baseProj({ choice_key: "to_mars" }),
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, "invalid_choice_key");

  // Without choice, host predicates still work
  const host = routeEngagementGraph({
    current: "validate",
    edges,
    projection: baseProj({
      choice_key: null,
      confirmed_unexploited_n: 1,
    }),
  });
  assert.equal(host.ok, true);
  if (host.ok) assert.equal(host.next, "exploit_lite");

  const needMore = routeEngagementGraph({
    current: "validate",
    edges,
    projection: baseProj({
      need_more_signal: true,
      confirmed_unexploited_n: 0,
    }),
  });
  assert.equal(needMore.ok, true);
  if (needMore.ok) {
    assert.equal(needMore.next, "enumerate");
    assert.equal(needMore.is_hot_back_edge, true);
  }
}

// --- book terminal ---
{
  const term = routeEngagementGraph({
    current: "book",
    edges,
    projection: baseProj(),
  });
  assert.equal(term.ok, false);
  if (!term.ok) assert.equal(term.code, "terminal");
}

// --- exploit_lite paths (reachable with production-like stage_pass:true + exploit_failed) ---
{
  const okBook = routeEngagementGraph({
    current: "exploit_lite",
    edges,
    projection: baseProj({ stage_pass: true, exploit_failed: false }),
  });
  assert.equal(okBook.ok, true);
  if (okBook.ok) assert.equal(okBook.next, "book");

  // Production runner may still have structure-pass; exploit_failed must win
  const retry = routeEngagementGraph({
    current: "exploit_lite",
    edges,
    projection: baseProj({ stage_pass: true, exploit_failed: true }),
  });
  assert.equal(retry.ok, true);
  if (retry.ok) {
    assert.equal(retry.next, "validate");
    assert.equal(retry.key, "exploit_failed_retry_validate");
    assert.equal(retry.is_hot_back_edge, true);
  }
}

// --- enumerate intermediate incomplete → re-enter enumerate ---
{
  const r = routeEngagementGraph({
    current: "enumerate",
    edges,
    projection: baseProj({
      active_hyp_n: 1,
      active_complete_n: 0,
      surfaces_n: 1,
    }),
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.next, "enumerate");
    assert.equal(r.key, "active_hyp_incomplete");
  }
}

// --- S4 product-state slices (pure) ---
{
  const slices = buildEngagementRouteSlicesFromProductState({
    stageId: "enumerate",
    surfaces_n: 2,
    hypotheses: [
      {
        status: "active",
        signal: "s1",
        prove_if: "p1",
        disprove_if: "d1",
        statement: "A",
      },
      {
        status: "active",
        signal: "s2",
        prove_if: "p2",
        disprove_if: "d2",
        statement: "B",
      },
    ],
    findings: [],
  });
  assert.equal(slices.routeProjection.active_hyp_n, 2);
  assert.equal(slices.routeProjection.active_complete_n, 2);

  // Empty store alone is NOT exploit_failed — honest deadend keeps stage_pass
  const exploitEmpty = buildEngagementRouteSlicesFromProductState({
    stageId: "exploit_lite",
    surfaces_n: 1,
    hypotheses: [],
    findings: [],
    structured: { deadends: ["no poc this turn"] },
  });
  assert.equal(exploitEmpty.routeProjection.exploit_failed, false);
  assert.equal(exploitEmpty.routeProjection.stage_pass, true);
  assert.equal(exploitEmpty.routeProjection.store_candidates_n, 0);

  // Explicit signal → exploit_failed (independent of store)
  const exploitRetry = buildEngagementRouteSlicesFromProductState({
    stageId: "exploit_lite",
    surfaces_n: 1,
    hypotheses: [],
    findings: [],
    structured: { deadends: ["exploit_failed=true"] },
  });
  assert.equal(exploitRetry.routeProjection.exploit_failed, true);
  assert.equal(exploitRetry.routeProjection.stage_pass, true);

  // Honest empty → book via stage_pass (not validate thrash)
  const honestBook = routeEngagementGraph({
    current: "exploit_lite",
    edges,
    projection: baseProj({
      stage_pass: true,
      exploit_failed: false,
      store_candidates_n: 0,
    }),
  });
  assert.equal(honestBook.ok, true);
  if (honestBook.ok) {
    assert.equal(honestBook.next, "book");
    assert.equal(honestBook.key, "stage_pass");
  }

  assert.equal(parseExploitFailedFromStructured({ deadends: ["exploit_failed"] }), true);
  assert.equal(parseExploitFailedFromStructured({ deadends: ["no poc"] }), false);

  const choice = parseRouteChoiceKeyFromStructured({
    facts: [{ key: "route_choice_key", summary: "to_book" }],
  });
  assert.equal(choice, "to_book");
}

// --- enumerate complete hyps → validate ---
{
  const r = routeEngagementGraph({
    current: "enumerate",
    edges,
    projection: baseProj({ active_complete_n: 2, active_hyp_n: 2 }),
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.next, "validate");
}

console.log("engagement-graph-route.test.ts: ok");
