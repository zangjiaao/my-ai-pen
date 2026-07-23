/**
 * Hard Graph definition seam (Graph × Pi first cut).
 *
 * Soft scenario graphs (pentest-graph.ts): node menu + soft default_plan — NOT Hard Graph DoD.
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

const HARD_GRAPH_ALIASES: Record<string, string> = {
  app_assessment_thin: "app_assessment_thin",
  hard_app_assessment: "app_assessment_thin",
  thin: "app_assessment_thin",
};

/**
 * Resolve whether this task wants Hard Graph and which definition to load.
 * Structured fields only — no free-text NLP on instruction.
 *
 * - graphDiscipline === "hard" → load hard graph (graphId or default app_assessment_thin)
 * - graphId maps to a known hard id / alias
 * - env NODE4_HARD_GRAPH=1|true with graphId alias support
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

  // Explicit hard graph id, or discipline/env → default thin path.
  let hardId: string | null = aliased;
  if (!hardId && (taskHard || envHard)) {
    hardId = "app_assessment_thin";
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
