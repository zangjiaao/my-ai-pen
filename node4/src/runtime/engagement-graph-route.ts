/**
 * Spec #285 — Constrained Engagement Graph pure route seam (S1) + projection (S4).
 *
 * Host-owned edges only. Deterministic route(projection) → next.
 * Main never invents edges or free goto; optional whitelist choice_key only.
 *
 * Primary pure unit seam — no I/O, no LLM.
 */

/** Declared edge in a product Graph JSON (or fixture). */
export type EngagementGraphEdge = {
  from: string;
  to: string;
  /** Whitelist predicate id (pure check on projection). */
  when: string;
  /** Higher priority wins first (if/elif). Default 0. */
  priority?: number;
  /**
   * Gate path_map key: when set, edge matches only if projection.choice_key === choice_key.
   * Host validates membership against declared gate keys for the node.
   */
  choice_key?: string;
  /**
   * Hot back-edge: counts toward per-edge back-edge budget (G4).
   * Default: derived from known hot pairs when omitted.
   */
  hot_back_edge?: boolean;
};

/** Small typed projection of Product state for routing (G6). */
export type RouteProjection = {
  /** Last settled node passed structure/L1 gates. */
  stage_pass: boolean;
  /** Count of active hypotheses in the run queue. */
  active_hyp_n: number;
  /**
   * Active hypotheses with complete fields (signal + prove_if + disprove_if).
   * Used by active_hyp_ge_2_complete.
   */
  active_complete_n: number;
  /** Attack surfaces recorded on handoff / surface ledger. */
  surfaces_n: number;
  /** Confirmed hypotheses not yet exploited / not yet store-seeded. */
  confirmed_unexploited_n: number;
  /** Host signal: validate needs more enumerate (incomplete evidence). */
  need_more_signal: boolean;
  /** Finding Store candidates / feedback_ok rows available to book. */
  store_candidates_n: number;
  /** Exploit-lite stage failed validation retry path. */
  exploit_failed: boolean;
  /** Global hops already used (entries into nodes so far, before next entry). */
  hops_used: number;
  /** Global hop budget (default 25). */
  hop_budget: number;
  /**
   * Main Gate choice (whitelist key only). Empty/undefined = no gate selection.
   * Invalid non-empty keys that match no declared gate edge are fail-closed by route.
   */
  choice_key?: string | null;
  /** Bookable work exists (store candidates or confirmed unexploited) — soft landing prefer book. */
  bookable_work?: boolean;
};

export type RouteCounters = {
  /** Counts of taken hot back-edges keyed by "from->to". */
  back_edge_counts: Record<string, number>;
  /** Caps per hot back-edge key (default ≤3 for known hot pairs). */
  back_edge_caps: Record<string, number>;
};

export type RouteOk = {
  ok: true;
  next: string;
  key: string;
  reason: string;
  /** True when this transition is a hot back-edge that should increment counters. */
  is_hot_back_edge: boolean;
  edge_key: string;
};

export type RouteFail = {
  ok: false;
  reason: string;
  /** Machine code for host soft-landing / gate reject. */
  code:
    | "unmatched"
    | "invalid_choice_key"
    | "unknown_node"
    | "terminal"
    | "hop_soft_landing";
  /** Suggested soft-landing target when applicable. */
  soft_landing_to?: string;
};

export type RouteResult = RouteOk | RouteFail;

export type EngagementRouteBudgets = {
  global_hop: number;
  /** Caps for hot back-edges ("from->to" → max takes). */
  back_edge_caps: Record<string, number>;
};

/** Spec §6.2 defaults. */
export const DEFAULT_GLOBAL_HOP = 25;

/** Hot back-edges from Spec G4 / §6.2. */
export const DEFAULT_HOT_BACK_EDGE_CAPS: Readonly<Record<string, number>> = {
  "enumerate->recon": 3,
  "validate->enumerate": 3,
  "exploit_lite->validate": 3,
};

export function defaultRouteBudgets(
  overrides?: Partial<EngagementRouteBudgets>,
): EngagementRouteBudgets {
  return {
    global_hop:
      typeof overrides?.global_hop === "number" && overrides.global_hop > 0
        ? Math.floor(overrides.global_hop)
        : DEFAULT_GLOBAL_HOP,
    back_edge_caps: {
      ...DEFAULT_HOT_BACK_EDGE_CAPS,
      ...(overrides?.back_edge_caps || {}),
    },
  };
}

export function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

/** Known hot pairs (used when edge.hot_back_edge omitted). */
export function isDefaultHotBackEdge(from: string, to: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    DEFAULT_HOT_BACK_EDGE_CAPS,
    edgeKey(from, to),
  );
}

function edgeIsHot(edge: EngagementGraphEdge): boolean {
  if (edge.hot_back_edge === true) return true;
  if (edge.hot_back_edge === false) return false;
  return isDefaultHotBackEdge(edge.from, edge.to);
}

/**
 * Whitelist predicate ids → pure checks on projection.
 * Unknown ids fail at edge-table load (S2), not at runtime invent.
 */
export const ROUTE_PREDICATE_IDS = [
  "stage_pass",
  "active_hyp_ge_1",
  "surfaces_ge_1",
  "hop_exhausted",
  "active_hyp_ge_2_complete",
  /** Active hyps exist but fewer than 2 complete — re-enter enumerate (Wave1 intermediate). */
  "active_hyp_incomplete",
  "active_eq_0_and_open_surface",
  "has_confirmed_unexploited",
  "need_more_signal",
  "has_store_candidates",
  "exploit_failed_retry_validate",
  /**
   * Recon settled with zero surfaces and zero active hyps — soft-land to book (G4 spirit).
   * Declared edge only; not invented from free-text.
   */
  "empty_recon",
  /** Gate membership: edge.choice_key must equal projection.choice_key. */
  "main_choice",
  /**
   * Always true — fixture / priority tests only; product graphs should use real predicates.
   */
  "always",
  /**
   * Always false — fixture / disabled edge tests only.
   */
  "never",
] as const;

export type RoutePredicateId = (typeof ROUTE_PREDICATE_IDS)[number];

const PREDICATE_SET = new Set<string>(ROUTE_PREDICATE_IDS);

export function isKnownRoutePredicateId(id: string): boolean {
  return PREDICATE_SET.has(String(id || "").trim());
}

/** Evaluate a whitelist predicate against projection (+ optional edge choice_key). */
export function evalRoutePredicate(
  predicateId: string,
  projection: RouteProjection,
  edge?: Pick<EngagementGraphEdge, "choice_key">,
): boolean {
  const id = String(predicateId || "").trim();
  switch (id) {
    case "stage_pass":
      return projection.stage_pass === true;
    case "active_hyp_ge_1":
      return projection.active_hyp_n >= 1;
    case "surfaces_ge_1":
      return projection.surfaces_n >= 1;
    case "hop_exhausted":
      return projection.hops_used >= projection.hop_budget;
    case "active_hyp_ge_2_complete":
      return projection.active_complete_n >= 2;
    case "active_hyp_incomplete":
      return projection.active_hyp_n >= 1 && projection.active_complete_n < 2;
    case "active_eq_0_and_open_surface":
      return projection.active_hyp_n === 0 && projection.surfaces_n >= 1;
    case "has_confirmed_unexploited":
      return projection.confirmed_unexploited_n >= 1;
    case "need_more_signal":
      return projection.need_more_signal === true;
    case "has_store_candidates":
      return projection.store_candidates_n >= 1;
    case "exploit_failed_retry_validate":
      return projection.exploit_failed === true;
    case "empty_recon":
      return projection.surfaces_n === 0 && projection.active_hyp_n === 0;
    case "main_choice": {
      const want = String(edge?.choice_key || "").trim();
      const got = String(projection.choice_key || "").trim();
      return Boolean(want) && want === got;
    }
    case "always":
      return true;
    case "never":
      return false;
    default:
      // Unknown should not reach runtime if load validated; treat as non-match.
      return false;
  }
}

/**
 * S2: validate edge table against stage ids + predicate whitelist.
 * Unknown predicate id → load fail.
 */
export function validateEngagementEdgeTable(input: {
  stageIds: readonly string[];
  edges: readonly EngagementGraphEdge[];
}): { ok: true } | { ok: false; error: string } {
  const stages = new Set(
    input.stageIds.map((s) => String(s || "").trim()).filter(Boolean),
  );
  if (!stages.size) {
    return { ok: false, error: "engagement_edges: no stages" };
  }
  for (let i = 0; i < input.edges.length; i++) {
    const e = input.edges[i]!;
    const from = String(e?.from || "").trim();
    const to = String(e?.to || "").trim();
    const when = String(e?.when || "").trim();
    if (!from || !to || !when) {
      return {
        ok: false,
        error: `engagement_edges[${i}]: from, to, when required`,
      };
    }
    if (!stages.has(from)) {
      return {
        ok: false,
        error: `engagement_edges[${i}]: unknown from node "${from}"`,
      };
    }
    // "END" is not a stage — allow only if to is a known stage (Wave1 book is terminal via no exit)
    if (to.toUpperCase() === "END") {
      return {
        ok: false,
        error: `engagement_edges[${i}]: to=END not supported — omit outgoing edges from terminal book`,
      };
    }
    if (!stages.has(to)) {
      return {
        ok: false,
        error: `engagement_edges[${i}]: unknown to node "${to}"`,
      };
    }
    if (!isKnownRoutePredicateId(when)) {
      return {
        ok: false,
        error: `engagement_edges[${i}]: unknown predicate id "${when}" (whitelist only)`,
      };
    }
    if (when === "main_choice") {
      const ck = String(e.choice_key || "").trim();
      if (!ck) {
        return {
          ok: false,
          error: `engagement_edges[${i}]: main_choice requires choice_key`,
        };
      }
    }
  }
  return { ok: true };
}

/** Parse edges array from graph JSON (structural only; call validate after). */
export function parseEngagementEdges(raw: unknown): EngagementGraphEdge[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out: EngagementGraphEdge[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const o = item as Record<string, unknown>;
    const from = String(o.from || "").trim();
    const to = String(o.to || "").trim();
    const when = String(o.when || "").trim();
    if (!from || !to || !when) return null;
    const edge: EngagementGraphEdge = { from, to, when };
    if (typeof o.priority === "number" && Number.isFinite(o.priority)) {
      edge.priority = o.priority;
    }
    if (o.choice_key != null) {
      const ck = String(o.choice_key || "").trim();
      if (ck) edge.choice_key = ck;
    }
    if (typeof o.hot_back_edge === "boolean") {
      edge.hot_back_edge = o.hot_back_edge;
    }
    out.push(edge);
  }
  return out;
}

/**
 * Gate whitelist for a node: choice_key values declared on main_choice edges from that node.
 */
export function gateChoiceKeysForNode(
  edges: readonly EngagementGraphEdge[],
  nodeId: string,
): string[] {
  const from = String(nodeId || "").trim();
  const keys = new Set<string>();
  for (const e of edges) {
    if (e.from !== from) continue;
    if (String(e.when).trim() !== "main_choice") continue;
    const ck = String(e.choice_key || "").trim();
    if (ck) keys.add(ck);
  }
  return [...keys].sort();
}

/**
 * S1 Route pure function (primary seam).
 *
 * Priority: first matching edge by priority desc (if/elif).
 * Unmatched → fail-closed (no silent stage index++).
 * Hot back-edge over cap → that edge does not match.
 * Non-empty choice_key that is not in gate whitelist for node → invalid_choice_key.
 */
export function routeEngagementGraph(input: {
  current: string;
  edges: readonly EngagementGraphEdge[];
  projection: RouteProjection;
  counters?: Partial<RouteCounters>;
  /** When true (default), non-empty choice_key must be in gate whitelist if node has gate edges. */
  enforce_gate_whitelist?: boolean;
  /** Prefer this node for hop soft-landing when hop exhausted and no hop_exhausted edge. */
  soft_landing_book_id?: string;
}): RouteResult {
  const current = String(input.current || "").trim();
  if (!current) {
    return { ok: false, reason: "empty current node", code: "unknown_node" };
  }

  const edgesFrom = input.edges.filter((e) => e.from === current);
  const caps = {
    ...DEFAULT_HOT_BACK_EDGE_CAPS,
    ...(input.counters?.back_edge_caps || {}),
  };
  const counts = { ...(input.counters?.back_edge_counts || {}) };
  const proj = input.projection;
  const enforceGate = input.enforce_gate_whitelist !== false;

  // Sort by priority desc (stable among equal priority by original order)
  const ordered = edgesFrom
    .map((e, idx) => ({ e, idx }))
    .sort((a, b) => {
      const pa = typeof a.e.priority === "number" ? a.e.priority : 0;
      const pb = typeof b.e.priority === "number" ? b.e.priority : 0;
      if (pb !== pa) return pb - pa;
      return a.idx - b.idx;
    });

  const tryMatch = (
    candidates: typeof ordered,
  ): RouteOk | null => {
    for (const { e } of candidates) {
      const ek = edgeKey(e.from, e.to);
      const hot = edgeIsHot(e);
      if (hot) {
        const used = counts[ek] || 0;
        const cap =
          typeof caps[ek] === "number"
            ? caps[ek]!
            : DEFAULT_HOT_BACK_EDGE_CAPS[ek] ?? 3;
        if (used >= cap) {
          continue; // cap blocks this edge
        }
      }
      if (!evalRoutePredicate(e.when, proj, e)) continue;

      const key =
        e.when === "main_choice"
          ? String(e.choice_key || e.when)
          : String(e.when);

      return {
        ok: true,
        next: e.to,
        key,
        reason: `matched:${e.when}${e.choice_key ? `:${e.choice_key}` : ""}→${e.to}`,
        is_hot_back_edge: hot,
        edge_key: ek,
      };
    }
    return null;
  };

  // G4 / E3: hop budget is a hard pre-route check (industry recursion_limit).
  // Runs BEFORE invalid choice_key so exhausted hops still soft-land (G4 partial residual).
  // When exhausted, only hop_exhausted edges may fire — never work edges that continue the cycle.
  const hopExhausted = proj.hops_used >= proj.hop_budget;
  if (hopExhausted) {
    const hopOnly = ordered.filter((x) => String(x.e.when).trim() === "hop_exhausted");
    const hopMatch = tryMatch(hopOnly);
    if (hopMatch) return hopMatch;
    const bookId = String(input.soft_landing_book_id || "book").trim() || "book";
    return {
      ok: false,
      reason: "hop_exhausted_soft_landing",
      code: "hop_soft_landing",
      soft_landing_to: bookId,
    };
  }

  // Gate: non-empty choice_key must be declared on this node when gate edges exist.
  // Only after hop pre-check so invalid choice cannot block hop soft-landing.
  const choice = String(proj.choice_key || "").trim();
  const gateKeys = gateChoiceKeysForNode(input.edges, current);
  if (enforceGate && choice && gateKeys.length > 0 && !gateKeys.includes(choice)) {
    return {
      ok: false,
      reason: `invalid_choice_key:${choice}`,
      code: "invalid_choice_key",
    };
  }

  // Normal work edges (hop not exhausted). hop_exhausted predicates are false here.
  const workMatch = tryMatch(ordered);
  if (workMatch) return workMatch;

  // No outgoing edges → treat as terminal (book end)
  if (edgesFrom.length === 0) {
    return {
      ok: false,
      reason: `terminal_node:${current}`,
      code: "terminal",
    };
  }

  return {
    ok: false,
    reason: `unmatched_route:from=${current}`,
    code: "unmatched",
  };
}

/**
 * Apply a successful route to counters (immutable-style return).
 */
export function applyRouteCounters(
  counters: RouteCounters,
  route: RouteOk,
): RouteCounters {
  const back_edge_counts = { ...counters.back_edge_counts };
  if (route.is_hot_back_edge) {
    back_edge_counts[route.edge_key] =
      (back_edge_counts[route.edge_key] || 0) + 1;
  }
  return {
    back_edge_counts,
    back_edge_caps: { ...counters.back_edge_caps },
  };
}

export function emptyRouteCounters(
  budgets?: EngagementRouteBudgets,
): RouteCounters {
  const b = budgets ?? defaultRouteBudgets();
  return {
    back_edge_counts: {},
    back_edge_caps: { ...b.back_edge_caps },
  };
}

/**
 * S4: build route projection from Product-state slices (pure).
 * Callers pass already-derived counts — no store I/O here.
 */
export function buildRouteProjection(input: {
  stage_pass: boolean;
  active_hyp_n?: number;
  active_complete_n?: number;
  surfaces_n?: number;
  confirmed_unexploited_n?: number;
  need_more_signal?: boolean;
  store_candidates_n?: number;
  exploit_failed?: boolean;
  hops_used: number;
  hop_budget?: number;
  choice_key?: string | null;
}): RouteProjection {
  const hop_budget =
    typeof input.hop_budget === "number" && input.hop_budget > 0
      ? Math.floor(input.hop_budget)
      : DEFAULT_GLOBAL_HOP;
  const active_hyp_n = Math.max(0, Math.floor(input.active_hyp_n ?? 0));
  const active_complete_n = Math.max(0, Math.floor(input.active_complete_n ?? 0));
  const surfaces_n = Math.max(0, Math.floor(input.surfaces_n ?? 0));
  const confirmed_unexploited_n = Math.max(
    0,
    Math.floor(input.confirmed_unexploited_n ?? 0),
  );
  const store_candidates_n = Math.max(0, Math.floor(input.store_candidates_n ?? 0));
  const bookable_work = store_candidates_n > 0 || confirmed_unexploited_n > 0;
  return {
    stage_pass: input.stage_pass === true,
    active_hyp_n,
    active_complete_n,
    surfaces_n,
    confirmed_unexploited_n,
    need_more_signal: input.need_more_signal === true,
    store_candidates_n,
    exploit_failed: input.exploit_failed === true,
    hops_used: Math.max(0, Math.floor(input.hops_used)),
    hop_budget,
    choice_key: input.choice_key ?? null,
    bookable_work,
  };
}

/** Plain hypothesis row for S4 product-state projection (no store I/O). */
export type HypothesisRouteRow = {
  status: string;
  signal?: string;
  prove_if?: string;
  disprove_if?: string;
  statement?: string;
};

/** Plain finding row for S4 product-state projection. */
export type FindingRouteRow = {
  status: string;
  title?: string;
};

function hypFieldsComplete(r: HypothesisRouteRow): boolean {
  return Boolean(
    String(r.signal || "").trim() &&
      String(r.prove_if || "").trim() &&
      String(r.disprove_if || "").trim(),
  );
}

/** Choice-key field names accepted on structured / raw objects (G3 whitelist aliases). */
const CHOICE_KEY_FIELDS = [
  "route_choice_key",
  "routeChoiceKey",
  "choice_key",
  "choiceKey",
] as const;

function truthyFlag(v: unknown): boolean {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v)
    .trim()
    .toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "retry";
}

/**
 * Read a string field from a plain object (first matching key wins).
 */
function readStringField(
  o: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = String(o[k] ?? "").trim();
    if (v) return v.slice(0, 64);
  }
  return undefined;
}

/**
 * Collect plain objects that may carry typed routing fields.
 * Includes input bag, raw payload, nested structured/gate/route — never free-text arrays.
 */
function structuredRouteObjects(input: {
  raw?: unknown;
  [key: string]: unknown;
}): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const push = (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    if (seen.has(v)) return;
    seen.add(v);
    out.push(v as Record<string, unknown>);
  };
  push(input);
  push(input.raw);
  // Walk one level of common nests on input + raw
  for (const base of [...out]) {
    for (const nest of ["structured", "gate", "route"] as const) {
      push(base[nest]);
    }
  }
  return out;
}

/**
 * Parse Main Gate choice_key from **typed structured fields only** (Spec G2/G3).
 * Accepts top-level / raw / nested gate|route objects:
 *   route_choice_key | choice_key | routeChoiceKey | choiceKey
 * Does **not** scrape facts/deadends/notes free-text (no NLP / regex routing).
 * Whitelist membership is enforced later by routeEngagementGraph.
 */
export function parseRouteChoiceKeyFromStructured(input: {
  facts?: readonly { key?: string; summary?: string }[];
  deadends?: readonly string[];
  notes?: string;
  raw?: unknown;
  route_choice_key?: unknown;
  routeChoiceKey?: unknown;
  choice_key?: unknown;
  choiceKey?: unknown;
  gate?: unknown;
  route?: unknown;
}): string | undefined {
  // facts / deadends / notes intentionally ignored for routing (G2)
  void input.facts;
  void input.deadends;
  void input.notes;
  for (const o of structuredRouteObjects(input)) {
    const v = readStringField(o, CHOICE_KEY_FIELDS);
    if (v) return v;
  }
  return undefined;
}

/**
 * Parse explicit exploit_failed retry intent from **typed structured fields only**.
 * Empty Finding Store / free-text deadends alone are NOT enough
 * (honest deadends may still stage_pass → book).
 * Sources: top-level / raw.exploit_failed | exploitFailed (boolean or true/false string).
 */
export function parseExploitFailedFromStructured(input: {
  facts?: readonly { key?: string; summary?: string }[];
  deadends?: readonly string[];
  notes?: string;
  raw?: unknown;
  exploit_failed?: unknown;
  exploitFailed?: unknown;
  gate?: unknown;
  route?: unknown;
}): boolean {
  void input.facts;
  void input.deadends;
  void input.notes;
  for (const o of structuredRouteObjects(input)) {
    if (truthyFlag(o.exploit_failed) || truthyFlag(o.exploitFailed)) return true;
  }
  return false;
}

/**
 * Parse explicit need_more_signal from **typed structured fields only**.
 * Host must not invent from stage-id + hyp counts (Standards harness / Spec G2).
 */
export function parseNeedMoreSignalFromStructured(input: {
  facts?: readonly { key?: string; summary?: string }[];
  deadends?: readonly string[];
  notes?: string;
  raw?: unknown;
  need_more_signal?: unknown;
  needMoreSignal?: unknown;
  gate?: unknown;
  route?: unknown;
}): boolean {
  void input.facts;
  void input.deadends;
  void input.notes;
  for (const o of structuredRouteObjects(input)) {
    if (truthyFlag(o.need_more_signal) || truthyFlag(o.needMoreSignal)) return true;
  }
  return false;
}

/**
 * S4 product-state → route slices for stage executor finalize (pure).
 * Rebuild full snapshot each settle — not sticky partial merges.
 *
 * Routing flags (choice_key / exploit_failed / need_more_signal) are
 * **explicit typed structured fields only** — never invented from free-text
 * facts/deadends/notes or from stage-id + hyp counts (G2/G3).
 * stage_pass defaults true after structure settle so honest deadends can book
 * via stage_pass / has_store_candidates independently (Spec §6.1).
 */
export function buildEngagementRouteSlicesFromProductState(input: {
  stageId: string;
  hypotheses?: readonly HypothesisRouteRow[];
  findings?: readonly FindingRouteRow[];
  surfaces_n: number;
  structured?: {
    facts?: readonly { key?: string; summary?: string }[];
    deadends?: readonly string[];
    notes?: string;
    raw?: unknown;
    route_choice_key?: unknown;
    routeChoiceKey?: unknown;
    choice_key?: unknown;
    choiceKey?: unknown;
    exploit_failed?: unknown;
    exploitFailed?: unknown;
    need_more_signal?: unknown;
    needMoreSignal?: unknown;
    gate?: unknown;
    route?: unknown;
  } | null;
}): {
  routeProjection: {
    active_hyp_n: number;
    active_complete_n: number;
    surfaces_n: number;
    confirmed_unexploited_n: number;
    need_more_signal: boolean;
    store_candidates_n: number;
    exploit_failed: boolean;
    /** Structure settle success for route (honest empty may still be true). */
    stage_pass: boolean;
    choice_key?: string | null;
  };
  routeChoiceKey?: string;
} {
  const stageId = String(input.stageId || "").trim();
  const hyps = input.hypotheses || [];
  const findings = input.findings || [];

  let active_hyp_n = 0;
  let active_complete_n = 0;
  const confirmed: HypothesisRouteRow[] = [];
  for (const r of hyps) {
    const st = String(r.status || "").trim().toLowerCase();
    if (st === "active") {
      active_hyp_n++;
      if (hypFieldsComplete(r)) active_complete_n++;
    } else if (st === "confirmed") {
      confirmed.push(r);
    }
  }

  // Product-state projection (G6): confirmed hyps not yet represented in Finding Store.
  // Exact title stem match against store rows only — not free-text chat routing.
  const storeTitles = new Set(
    findings
      .map((f) => String(f.title || "").toLowerCase().slice(0, 80))
      .filter(Boolean),
  );
  const confirmed_unexploited_n = confirmed.filter((r) => {
    const stem = String(r.statement || "").toLowerCase().slice(0, 80);
    return !stem || !storeTitles.has(stem);
  }).length;

  let store_candidates_n = 0;
  for (const f of findings) {
    const st = String(f.status || "").trim().toLowerCase();
    if (st === "open" || st === "feedback_pending" || st === "feedback_ok") {
      store_candidates_n++;
    }
  }

  const surfaces_n = Math.max(0, Math.floor(input.surfaces_n || 0));
  const structured = input.structured || {};
  const routeChoiceKey = parseRouteChoiceKeyFromStructured(structured);

  // Explicit retry intent only — never invent from empty store (honest deadend → book)
  const exploit_failed =
    stageId === "exploit_lite" && parseExploitFailedFromStructured(structured);

  // Structure settle is already required before route; keep stage_pass true so
  // stage_pass / has_store_candidates remain independent book paths (§6.1).
  const stage_pass = true;

  // Explicit host/agent signal only — do not invent from stage-id + hyp counts.
  const need_more_signal = parseNeedMoreSignalFromStructured(structured);

  return {
    routeProjection: {
      active_hyp_n,
      active_complete_n,
      surfaces_n,
      confirmed_unexploited_n,
      need_more_signal,
      store_candidates_n,
      exploit_failed,
      stage_pass,
      choice_key: routeChoiceKey ?? null,
    },
    ...(routeChoiceKey ? { routeChoiceKey } : {}),
  };
}

/**
 * Minimal Wave1 hypothesis_cycle edge table (Spec §6.1) for fixtures / docs parity.
 * Priority high→low within each from.
 */
export function hypothesisCycleEdgeTable(): EngagementGraphEdge[] {
  return [
    { from: "init", when: "stage_pass", to: "recon", priority: 10 },

    { from: "recon", when: "active_hyp_ge_1", to: "enumerate", priority: 30 },
    { from: "recon", when: "surfaces_ge_1", to: "enumerate", priority: 20 },
    /** Empty recon soft-land: no surfaces and no active hyps → book (G4 spirit). */
    { from: "recon", when: "empty_recon", to: "book", priority: 10 },
    { from: "recon", when: "hop_exhausted", to: "book", priority: 5 },

    {
      from: "enumerate",
      when: "active_hyp_ge_2_complete",
      to: "validate",
      priority: 30,
    },
    {
      from: "enumerate",
      when: "active_eq_0_and_open_surface",
      to: "recon",
      priority: 20,
      hot_back_edge: true,
    },
    {
      from: "enumerate",
      when: "active_hyp_incomplete",
      to: "enumerate",
      priority: 15,
    },
    { from: "enumerate", when: "hop_exhausted", to: "book", priority: 5 },

    {
      from: "validate",
      when: "main_choice",
      to: "enumerate",
      choice_key: "to_enumerate",
      priority: 50,
    },
    {
      from: "validate",
      when: "main_choice",
      to: "exploit_lite",
      choice_key: "to_exploit_lite",
      priority: 50,
    },
    {
      from: "validate",
      when: "main_choice",
      to: "book",
      choice_key: "to_book",
      priority: 50,
    },
    {
      from: "validate",
      when: "has_confirmed_unexploited",
      to: "exploit_lite",
      priority: 30,
    },
    {
      from: "validate",
      when: "need_more_signal",
      to: "enumerate",
      priority: 20,
      hot_back_edge: true,
    },
    { from: "validate", when: "hop_exhausted", to: "book", priority: 5 },

    {
      // Prefer retry when exploit_failed (priority above structure stage_pass)
      from: "exploit_lite",
      when: "exploit_failed_retry_validate",
      to: "validate",
      priority: 40,
      hot_back_edge: true,
    },
    {
      from: "exploit_lite",
      when: "stage_pass",
      to: "book",
      priority: 30,
    },
    {
      from: "exploit_lite",
      when: "has_store_candidates",
      to: "book",
      priority: 20,
    },
    // book: no outgoing edges → terminal
  ];
}

export const HYPOTHESIS_CYCLE_STAGE_IDS = [
  "init",
  "recon",
  "enumerate",
  "validate",
  "exploit_lite",
  "book",
] as const;
