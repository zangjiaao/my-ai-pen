/**
 * Expert Graph definition seam (Hard Graph runner / Graph × Pi).
 *
 * Soft scenario graphs are retired as product mode (#68 / #76). Expert structured
 * work loads discipline:hard definitions from pack graphs/hard/*.json only.
 * Hard graphs: ordered stages with fail-closed require gates and tool profiles.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TaskEnvelope } from "../types.js";
import { assertHypothesisModeGraphLoad } from "./hypothesis-store.js";

export type HardGraphToolProfile = {
  /** When set, only these tool names are allowed (plus empty = no allowlist). */
  allow?: string[];
  /** Always denied even if present in allow. */
  deny?: string[];
};

export type HardGraphStageRequire = {
  /** Non-empty summary required (default true when require object present). */
  summary?: boolean;
  surfaces_min?: number;
  candidates_min?: number;
};

export type HardGraphStageDef = {
  id: string;
  success?: string;
  require?: HardGraphStageRequire;
  tools?: HardGraphToolProfile;
  /** Extra retries after first attempt (0 = single try). Default 1. */
  max_retries?: number;
  /**
   * Spec #139 stage intent (data-driven; avoid stage-id hardcodes in executor).
   * init | surface | probe | book | (free string for pack-specific)
   */
  intent?: string;
  /** When true, leftover feedback_ok rows become unbookable at stage exit (validate_book). */
  unbookable_on_exit?: boolean;
  /**
   * Spec #274: optional hypothesis–evidence work mode for this stage.
   * Explicit true only; missing/false = off. Not implied by probe/explore intent.
   */
  hypothesis_work_mode?: boolean;
};

/**
 * Product Hard Graph definition — Task-layer sequential stages.
 * `discipline: "hard"` is the load-time discriminator vs soft scenario JSON.
 */
export type HardGraphDefinition = {
  discipline: "hard";
  id: string;
  label: string;
  /**
   * Spec #278 L1 catalog: short when-to-use for Free prompt (skill-like).
   * Prefer when_to_use; description is an authoring alias.
   */
  when_to_use?: string;
  description?: string;
  /** Spec #278 AgentRow / dual-rail short badge (e.g. 应用评估). */
  short_label?: string;
  stages: HardGraphStageDef[];
  roe?: { allow_postex?: boolean };
};

/** Spec #278: product Graph L1 row (skill-like; not full stage JSON). */
export type GraphL1CatalogEntry = {
  id: string;
  label: string;
  when_to_use: string;
  short_label?: string;
  allow_postex?: boolean;
};

/**
 * Pure L1 catalog row from a hard graph definition object (no I/O).
 * Thin / lab ids (`*_thin`) are excluded by the async pack loader.
 */
export function graphL1EntryFromDefinition(
  def: Pick<
    HardGraphDefinition,
    "id" | "label" | "short_label" | "when_to_use" | "description" | "roe"
  >,
): GraphL1CatalogEntry | null {
  const id = String(def?.id || "").trim();
  if (!id) return null;
  const label = String(def.label || id).trim() || id;
  const when =
    String(def.when_to_use || def.description || "")
      .trim()
      .slice(0, 400) || label;
  const short = String(def.short_label || "").trim();
  const entry: GraphL1CatalogEntry = { id, label, when_to_use: when };
  if (short) entry.short_label = short;
  if (def.roe && typeof def.roe.allow_postex === "boolean") {
    entry.allow_postex = def.roe.allow_postex;
  }
  return entry;
}

/** True when id is a lab thin graph (excluded from product L1 by default). */
export function isThinGraphId(graphId: string): boolean {
  return /_thin$/i.test(String(graphId || "").trim());
}

/**
 * Spec #278 S1: build product Graph L1 list from already-loaded definitions.
 * Excludes thin lab graphs; stable sort by id.
 */
export function buildProductGraphL1Catalog(
  definitions: Iterable<
    Pick<
      HardGraphDefinition,
      "id" | "label" | "short_label" | "when_to_use" | "description" | "roe"
    >
  >,
  options?: { includeThin?: boolean },
): GraphL1CatalogEntry[] {
  const includeThin = options?.includeThin === true;
  const byId = new Map<string, GraphL1CatalogEntry>();
  for (const def of definitions) {
    const id = String(def?.id || "").trim();
    if (!id) continue;
    if (!includeThin && isThinGraphId(id)) continue;
    const row = graphL1EntryFromDefinition(def);
    if (row) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Load product Graph L1 catalog from packRoot/graphs/hard/*.json.
 * Product default excludes `*_thin`.
 */
export async function loadProductGraphL1Catalog(
  packRoot: string,
  options?: { includeThin?: boolean },
): Promise<GraphL1CatalogEntry[]> {
  const ids = await listHardGraphIds(packRoot);
  const defs: HardGraphDefinition[] = [];
  for (const id of ids) {
    if (!options?.includeThin && isThinGraphId(id)) continue;
    const g = await loadHardGraphFile(packRoot, id);
    if (g) defs.push(g);
  }
  return buildProductGraphL1Catalog(defs, options);
}

/**
 * Format L1 catalog for system prompt (Free and Graph) — skill-list analogue.
 * Does not dump full stage JSON.
 */
export function formatGraphL1CatalogInjection(
  entries: readonly GraphL1CatalogEntry[],
  options?: { activeGraphId?: string | null; mode?: "free" | "graph" },
): string {
  const mode = options?.mode === "graph" ? "graph" : "free";
  const lines: string[] = [
    "<available-graphs>",
    "Product Expert Graphs (L1 catalog — like skills: overview only, not full stages):",
  ];
  if (!entries.length) {
    lines.push("- (none declared on this pack)");
  } else {
    for (const e of entries) {
      const postex =
        typeof e.allow_postex === "boolean" ? ` allow_postex=${e.allow_postex}` : "";
      lines.push(`- ${e.id} — ${e.label}${postex}`);
      if (e.when_to_use) lines.push(`  when_to_use: ${e.when_to_use}`);
    }
  }
  lines.push(
    "Default work mode is Free unless the user selected a Workflow Graph this turn or accepted an enter-Graph proposal.",
    "For multi-stage full assessments, propose Graph via request_user_decision(kind=enter_graph, graph_id=…) — never silent harness switch.",
    "User composer Graph selection on send is explicit permission (no extra card).",
    "Exit/switch Graph also requires user permission: kind=exit_graph or kind=switch_graph with graph_id.",
  );
  if (mode === "graph" && options?.activeGraphId) {
    lines.push(`Active harness: graph_id=${options.activeGraphId} (stage detail is injected separately).`);
  } else if (mode === "free") {
    lines.push("Current harness: Free (no Expert Graph stages). Stay Free for small talk / ledger Q&A.");
  }
  lines.push("</available-graphs>");
  return lines.join("\n");
}

/** Soft scenario graph shape (existing pack graphs) — not Hard Graph DoD. */
export type SoftScenarioGraphShape = {
  id: string;
  nodes: Record<string, unknown>;
  default_plan?: string[];
  discipline?: string;
};

/**
 * Structural Hard Graph check (Spec #125).
 * Stage Feedback is host settlement (Finding Store + package terminals + surface ledger).
 * `write` is optional (notes/scripts) — not a handoff prerequisite for result.json.
 */
export function isHardGraphDefinition(value: unknown): value is HardGraphDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (o.discipline !== "hard") return false;
  if (typeof o.id !== "string" || !o.id.trim()) return false;
  if (!Array.isArray(o.stages) || o.stages.length === 0) return false;
  for (const s of o.stages) {
    if (!s || typeof s !== "object") return false;
    const stage = s as { id?: unknown; tools?: unknown };
    if (typeof stage.id !== "string" || !stage.id.trim()) {
      return false;
    }
    // tools.allow may omit write — host settlement does not require result.json handoff.
    if (stage.tools != null) {
      if (typeof stage.tools !== "object" || Array.isArray(stage.tools)) return false;
      const allow = (stage.tools as { allow?: unknown }).allow;
      if (allow != null && !Array.isArray(allow)) return false;
    }
  }
  return true;
}

/**
 * Soft scenario menu graphs: have nodes map, are not discipline hard.
 * Used to prove hard vs soft distinction at the loader seam.
 */
export function isSoftScenarioGraphDefinition(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (o.discipline === "hard") return false;
  if (typeof o.id !== "string" || !o.id.trim()) return false;
  if (!o.nodes || typeof o.nodes !== "object" || Array.isArray(o.nodes)) return false;
  return true;
}

export function hardGraphDir(packRoot: string): string {
  return join(packRoot, "graphs", "hard");
}

/**
 * Load a Hard Graph JSON from packRoot/graphs/hard/{graphId}.json
 */
export async function loadHardGraphFile(
  packRoot: string,
  graphId: string,
): Promise<HardGraphDefinition | null> {
  const id = String(graphId || "").trim();
  if (!id) return null;
  const path = join(hardGraphDir(packRoot), `${id}.json`);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isHardGraphDefinition(parsed)) return null;
    // Normalize id to filename intent
    return { ...parsed, id: parsed.id || id };
  } catch {
    return null;
  }
}

/** Soft scenario file under packRoot/graphs/{id}.json (existing layout). */
export async function loadSoftScenarioGraphFile(
  packRoot: string,
  graphId: string,
): Promise<SoftScenarioGraphShape | null> {
  const id = String(graphId || "").trim();
  if (!id) return null;
  const path = join(packRoot, "graphs", `${id}.json`);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isSoftScenarioGraphDefinition(parsed)) return null;
    return parsed as SoftScenarioGraphShape;
  } catch {
    return null;
  }
}

export async function listHardGraphIds(packRoot: string): Promise<string[]> {
  try {
    const names = await readdir(hardGraphDir(packRoot));
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.replace(/\.json$/i, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Single product Graph catalog (phase 2 / #76 residual #2).
 * Shared by hard load (`resolveHardGraph`) and fail-closed intent
 * (`resolveGraphIdFromTask` via `resolveGraphIntentCanonical`).
 *
 * - hardId set → Expert Graph file under graphs/hard/{hardId}.json
 * - hardId omitted → intent-only (fail-closed until a hard file exists)
 */
export type ProductGraphCatalogEntry = {
  /** Canonical product / intent id */
  intentId: string;
  /** Hard Graph file id when this alias loads Expert Graph */
  hardId?: string;
};

const PRODUCT_GRAPH_CATALOG: Record<string, ProductGraphCatalogEntry> = {
  // Product assessment → mature Expert Graph
  app_assessment: { intentId: "app_assessment", hardId: "app_assessment" },
  assessment: { intentId: "app_assessment", hardId: "app_assessment" },
  assess: { intentId: "app_assessment", hardId: "app_assessment" },
  "pre-prod": { intentId: "app_assessment", hardId: "app_assessment" },
  preprod: { intentId: "app_assessment", hardId: "app_assessment" },
  hard_app_assessment: { intentId: "app_assessment", hardId: "app_assessment" },
  app_assessment_hard: { intentId: "app_assessment", hardId: "app_assessment" },
  hard: { intentId: "app_assessment", hardId: "app_assessment" },
  // Thin lab / compatibility
  app_assessment_thin: { intentId: "app_assessment_thin", hardId: "app_assessment_thin" },
  hard_app_assessment_thin: {
    intentId: "app_assessment_thin",
    hardId: "app_assessment_thin",
  },
  thin: { intentId: "app_assessment_thin", hardId: "app_assessment_thin" },
  // Product deep (phase 2) — hard file graphs/hard/redteam_deep.json
  redteam_deep: { intentId: "redteam_deep", hardId: "redteam_deep" },
  redteam: { intentId: "redteam_deep", hardId: "redteam_deep" },
  "red-team": { intentId: "redteam_deep", hardId: "redteam_deep" },
  deep: { intentId: "redteam_deep", hardId: "redteam_deep" },
};

/** Default Expert Graph id when graphDiscipline/env selects hard without a thin/lab id. */
export const DEFAULT_HARD_GRAPH_ID = "app_assessment";

/** Look up catalog entry for a raw structured template/graph id (lowercase). */
export function lookupProductGraphCatalog(
  raw: string,
): ProductGraphCatalogEntry | null {
  const key = String(raw || "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  return PRODUCT_GRAPH_CATALOG[key] ?? null;
}

/** Canonical Graph intent id, or null if not a known Graph template alias. */
export function resolveGraphIntentCanonical(raw: string): string | null {
  return lookupProductGraphCatalog(raw)?.intentId ?? null;
}

/** Hard Graph file id for a product alias, or null if intent-only / unknown. */
export function resolveHardGraphIdFromAlias(raw: string): string | null {
  return lookupProductGraphCatalog(raw)?.hardId ?? null;
}

/**
 * Resolve whether this task wants Expert Graph (Hard Graph runner) and which definition to load.
 * Structured fields only — no free-text NLP on instruction.
 *
 * - Product catalog aliases with hardId → Expert Graph
 * - graphDiscipline === "hard" or NODE4_HARD_GRAPH → mature default (or alias if set)
 * - Unknown ids without hard file → not_hard (no Soft fallback here)
 */
export async function resolveHardGraph(options: {
  task: Pick<TaskEnvelope, "graphId" | "engagementTemplate" | "graphDiscipline">;
  packRoot?: string;
  packId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ mode: "hard"; graph: HardGraphDefinition } | { mode: "not_hard" }> {
  const packId = String(options.packId || "").toLowerCase();
  if (packId && packId !== "pentest") {
    return { mode: "not_hard" };
  }

  const env = options.env ?? process.env;
  const envHard = /^(1|true|yes|hard)$/i.test(String(env.NODE4_HARD_GRAPH || "").trim());
  const taskHard = options.task.graphDiscipline === "hard";

  const rawId = String(
    options.task.graphId || options.task.engagementTemplate || "",
  )
    .trim()
    .toLowerCase();
  const aliased = resolveHardGraphIdFromAlias(rawId);

  let hardId: string | null = null;
  if (aliased) {
    hardId = aliased;
  } else if (taskHard || envHard) {
    // Discipline/env hard without an explicit thin/product alias → mature Expert primary.
    hardId = DEFAULT_HARD_GRAPH_ID;
  } else if (rawId && options.packRoot) {
    // Any id that already has a hard Graph file is Expert Graph (multi-Graph catalog).
    const direct = await loadHardGraphFile(options.packRoot, rawId);
    if (direct) {
      return { mode: "hard", graph: direct };
    }
  }

  if (!hardId || !options.packRoot) {
    return { mode: "not_hard" };
  }

  const graph = await loadHardGraphFile(options.packRoot, hardId);
  if (!graph) return { mode: "not_hard" };
  return { mode: "hard", graph };
}

/**
 * Spec #274: fail-closed when any stage sets hypothesis_work_mode true without pack availability.
 * Call after resolveHardGraph with pack.capabilities.hypothesis_work_mode.
 * Thin graph-typed entry over assertHypothesisModeGraphLoad (same semantics).
 */
export function validateHypothesisWorkModeForGraph(
  graph: HardGraphDefinition,
  packHypothesisAvailable: boolean,
): { ok: true } | { ok: false; error: string } {
  return assertHypothesisModeGraphLoad({
    stages: graph.stages,
    packHypothesisAvailable,
  });
}

/** Re-export canonical load assert for callers that prefer the store module name. */
export { assertHypothesisModeGraphLoad };

/** Apply allow/deny tool profile to a tool name list (fail-closed deny). */
export function applyHardGraphToolProfile(
  toolNames: readonly string[],
  profile: HardGraphToolProfile | undefined,
): string[] {
  let out = [...toolNames];
  if (profile?.allow && profile.allow.length > 0) {
    const allow = new Set(profile.allow);
    out = out.filter((n) => allow.has(n));
  }
  if (profile?.deny && profile.deny.length > 0) {
    const deny = new Set(profile.deny);
    out = out.filter((n) => !deny.has(n));
  }
  return out;
}

/** Binary Expert Graph execution after parse (omit = first run uses full when hard resolves). */
export type GraphExecutionMode = "full" | "continue";

/**
 * Parse structured graph_execution from task_assign (snake/camel).
 * Synonyms collapse once: continue_chat|envelope → continue; run|restart → full.
 * Never NLP on instruction text.
 */
export function parseGraphExecution(
  message: Record<string, unknown> | null | undefined,
): GraphExecutionMode | undefined {
  if (!message) return undefined;
  const raw = message.graph_execution ?? message.graphExecution ?? "";
  const ge = String(raw).trim().toLowerCase();
  if (ge === "continue" || ge === "continue_chat" || ge === "envelope") return "continue";
  if (ge === "full" || ge === "run" || ge === "restart") return "full";
  return undefined;
}

/**
 * C1 (#78 / #80): post-Graph continue-chat stays in envelope without full Hard re-run.
 * Structured only — after parse, true iff `graphExecution === "continue"`.
 * `graphExecution=full` (or omit on first Graph) → full Expert Graph path.
 */
export function isContinueInEnvelopeExecution(input: {
  graphExecution?: string | null;
}): boolean {
  return input.graphExecution === "continue";
}

/**
 * Product work-path decision after resolveHardGraph (#76 Soft retire / #78 C1).
 * - chatOnly / ledger assist → free (no Expert Graph execution)
 * - continue-in-envelope (C1) → free OMP under sticky Graph RoE/template (not Hard stages)
 * - hard resolved → Expert Graph runner
 * - structured Graph intent but no hard Graph → fail-closed (never silent free)
 * - no Graph intent → free OMP
 */
export function resolveExpertWorkPath(input: {
  hardMode: "hard" | "not_hard";
  /** From resolveGraphIdFromTask — non-null means structured Graph intent. */
  graphIntent: string | null;
  chatOnly?: boolean;
  ledgerAssistSeat?: boolean;
  /** C1: post-complete follow-up — free-in-envelope, not full Hard schedule. */
  continueInEnvelope?: boolean;
}): { path: "hard" } | { path: "free" } | { path: "unavailable"; graphId: string } {
  if (input.chatOnly || input.ledgerAssistSeat) {
    return { path: "free" };
  }
  // C1 before hard path: sticky Graph template must not re-fire stages on chat turns.
  if (input.continueInEnvelope) {
    return { path: "free" };
  }
  if (input.hardMode === "hard") {
    return { path: "hard" };
  }
  if (input.graphIntent) {
    return { path: "unavailable", graphId: input.graphIntent };
  }
  return { path: "free" };
}
