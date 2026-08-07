/**
 * Spec #311 — shared Free/parked settle candidate package for task_complete.
 * Keeps session-runner cold settle and parked-continue settle in lockstep.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskEnvelope } from "../types.js";
import { loadFindings } from "../tools/finding.js";
import { buildAttackSurfaceCandidates, type AttackSurfaceCandidate } from "./attack-surface.js";
import {
  filterEmitableWorksetCandidates,
  worksetCandidatesFromAttackSurface,
  type WorksetCandidate,
} from "./workset-emit.js";

export type WorksetSettleSource = "free_settle" | "hard_settle";

export type WorksetSettleEmitPackage = {
  attackSurfaceCandidates: AttackSurfaceCandidate[];
  nextScopeCandidates: AttackSurfaceCandidate[];
  worksetCandidates: WorksetCandidate[];
  worksetSource: WorksetSettleSource;
};

/**
 * Build attack-surface + workset candidates from Finding Store locations.
 * Best-effort: empty arrays on any load/build failure (honest empty, not throw).
 */
export async function buildWorksetSettleEmitPackage(options: {
  task: TaskEnvelope;
  findingsDir: string;
  source: WorksetSettleSource;
  /** When false, skip findings scan (chat-only / ledger seats). Default true. */
  scanFindings?: boolean;
}): Promise<WorksetSettleEmitPackage> {
  const source = options.source;
  let attackSurfaceCandidates: AttackSurfaceCandidate[] = [];
  if (options.scanFindings !== false) {
    try {
      const localFindings = await loadFindings(options.findingsDir);
      const locs = localFindings
        .flatMap((f) => [
          String((f as { location?: string }).location || ""),
          String((f as { url?: string }).url || ""),
          String((f as { poc?: string }).poc || ""),
        ])
        .filter(Boolean);
      attackSurfaceCandidates = buildAttackSurfaceCandidates({
        task: options.task,
        locationStrings: locs,
      });
    } catch {
      attackSurfaceCandidates = [];
    }
  }
  const nextScopeCandidates = attackSurfaceCandidates.filter((c) => !c.in_scope);
  const worksetCandidates = filterEmitableWorksetCandidates(
    worksetCandidatesFromAttackSurface(attackSurfaceCandidates, { source }),
  );
  return {
    attackSurfaceCandidates,
    nextScopeCandidates,
    worksetCandidates,
    worksetSource: source,
  };
}

/** Best-effort write for offline inspect (non-blocking on failure). */
export async function writeAttackSurfaceCandidatesArtifact(
  taskDir: string,
  attackSurfaceCandidates: AttackSurfaceCandidate[],
): Promise<void> {
  try {
    await writeFile(
      join(taskDir, "attack_surface_candidates.json"),
      JSON.stringify(attackSurfaceCandidates, null, 2),
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}
