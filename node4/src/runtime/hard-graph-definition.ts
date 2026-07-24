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
};

/**
 * Product Hard Graph definition — Task-layer sequential stages.
 * `discipline: "hard"` is the load-time discriminator vs soft scenario JSON.
 */
export type HardGraphDefinition = {
  discipline: "hard";
  id: string;
  label: string;
  stages: HardGraphStageDef[];
  roe?: { allow_postex?: boolean };
};

/** Soft scenario graph shape (existing pack graphs) — not Hard Graph DoD. */
export type SoftScenarioGraphShape = {
  id: string;
  nodes: Record<string, unknown>;
  default_plan?: string[];
  discipline?: string;
};

/**
 * Structural Hard Graph check + handoff tool contract.
 * Stage end reads workdir `result.json` only. A non-empty tools.allow must
 * include `write` so the stage can emit that file (empty/missing allow =
 * unrestricted pack tools → write still reachable when the pack offers it).
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
    if (!stageHasResultJsonWritePath(stage.tools)) {
      return false;
    }
  }
  return true;
}

/** Non-empty allow without `write` cannot satisfy fail-closed result.json handoff. */
function stageHasResultJsonWritePath(tools: unknown): boolean {
  if (tools == null || typeof tools !== "object" || Array.isArray(tools)) {
    return true;
  }
  const allow = (tools as { allow?: unknown }).allow;
  if (allow == null) return true;
  if (!Array.isArray(allow)) return false;
  if (allow.length === 0) return true;
  return allow.some((t) => t === "write");
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
 * Explicit Expert Graph (Hard Graph runner) ids/aliases (structured only).
 *
 * Product path (#68 / #76): Soft scenario graphs are retired. Product template
 * `app_assessment` and aliases resolve to the mature Expert Graph under
 * graphs/hard/app_assessment.json. Thin lab ids remain explicit.
 *
 * `redteam_deep` is intentionally **not** aliased until a hard Graph file ships
 * (phase 2). Soft-only templates must not enter the Expert Graph runner.
 */
const HARD_GRAPH_ALIASES: Record<string, string> = {
  // Product assessment template → mature Expert Graph
  app_assessment: "app_assessment",
  assessment: "app_assessment",
  assess: "app_assessment",
  "pre-prod": "app_assessment",
  preprod: "app_assessment",
  // Explicit mature aliases
  hard_app_assessment: "app_assessment",
  app_assessment_hard: "app_assessment",
  hard: "app_assessment",
  // Thin lab / compatibility
  app_assessment_thin: "app_assessment_thin",
  hard_app_assessment_thin: "app_assessment_thin",
  thin: "app_assessment_thin",
};

/** Default Expert Graph id when graphDiscipline/env selects hard without a thin/lab id. */
export const DEFAULT_HARD_GRAPH_ID = "app_assessment";

/**
 * Resolve whether this task wants Expert Graph (Hard Graph runner) and which definition to load.
 * Structured fields only — no free-text NLP on instruction.
 *
 * - Product assessment aliases / explicit thin-hard ids → Expert Graph
 * - graphDiscipline === "hard" or NODE4_HARD_GRAPH → mature default (or alias if set)
 * - Unknown / soft-only ids without hard file → not_hard (no Soft fallback here)
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
  const aliased = HARD_GRAPH_ALIASES[rawId] ?? null;

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

/**
 * Product work-path decision after resolveHardGraph (#76 Soft retire).
 * - chatOnly / ledger assist → free (no Expert Graph execution)
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
}): { path: "hard" } | { path: "free" } | { path: "unavailable"; graphId: string } {
  if (input.chatOnly || input.ledgerAssistSeat) {
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
