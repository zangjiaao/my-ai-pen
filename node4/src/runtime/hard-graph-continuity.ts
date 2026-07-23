/**
 * Hard Graph stage continuity (A1 booking/proof + A4 session).
 *
 * Reuses soft/OMP primitives:
 * - injectParentObservationsFromChild + rememberSubagentEvidence for bookable proof
 * - seedChildSessionFromParent / promoteChildSessionToParent for cookie jars
 *
 * Parent lifecycle is SOT between stages; each stage child is seeded at start
 * and absorbed at end. Session jars live under stage workDir and promote to
 * parent taskDir/session.
 */

import type { ToolRuntime } from "../types.js";
import { injectParentObservationsFromChild } from "../tools/subagent.js";
import {
  rememberSubagentEvidence,
  type LastSubagentEvidence,
} from "./subagent-booking.js";
import {
  evaluateCandidatesForAcceptance,
  type SubagentStructuredResult,
} from "./subagent-result.js";
import {
  promoteChildSessionToParent,
  seedChildSessionFromParent,
} from "./subagent-session-seed.js";

const RECENT_OBS_CAP = 80;

export type StageContinuitySeed = {
  /** Length of recentObservations after seed (only newer child acts merge back). */
  observationCount: number;
};

/**
 * Copy booking continuity from parent into a fresh stage child runtime.
 */
export function seedStageLifecycleFromParent(
  parent: ToolRuntime,
  child: ToolRuntime,
): StageContinuitySeed {
  const p = parent.lifecycle || (parent.lifecycle = {});
  const c = child.lifecycle || (child.lifecycle = {} as ToolRuntime["lifecycle"]);

  const obs = p.recentObservations || [];
  c.recentObservations = obs.map((o) => ({ ...o, capture: o.capture ? { ...o.capture } : undefined }));

  const cache = p.subagentEvidenceCache || [];
  c.subagentEvidenceCache = cache.map((pack) => ({
    ...pack,
    candidates: [...(pack.candidates || [])],
  }));

  if (p.lastSubagentEvidence) {
    c.lastSubagentEvidence = {
      ...p.lastSubagentEvidence,
      candidates: [...(p.lastSubagentEvidence.candidates || [])],
    };
  } else {
    c.lastSubagentEvidence = undefined;
  }

  c.subagentCandidateIndex = p.subagentCandidateIndex
    ? p.subagentCandidateIndex.map((x) => ({ ...x }))
    : undefined;

  return { observationCount: c.recentObservations.length };
}

/**
 * Merge stage outcomes into parent so the next stage (e.g. validate_book) can book.
 */
export function absorbStageResultIntoParent(
  parent: ToolRuntime,
  input: {
    stageId: string;
    stageIndex?: number;
    structured: SubagentStructuredResult;
    child?: ToolRuntime;
    seed?: StageContinuitySeed;
  },
): void {
  const parentLife = parent.lifecycle || (parent.lifecycle = {});

  // Promote only observations the child added after seed (avoid duplicating seed copies).
  if (input.child?.lifecycle?.recentObservations && input.seed) {
    const newObs = input.child.lifecycle.recentObservations.slice(input.seed.observationCount);
    if (newObs.length) {
      const list = (parentLife.recentObservations ||= []);
      for (const o of newObs) {
        list.push({ ...o, capture: o.capture ? { ...o.capture } : undefined });
      }
      while (list.length > RECENT_OBS_CAP) list.shift();
    }
  }

  const stageKey = `hard-stage:${input.stageId}`;
  const structured = input.structured;

  injectParentObservationsFromChild(parent, {
    subagentId: stageKey,
    nodeType: input.stageId,
    structured,
    summary: structured.summaryProvided && structured.summary ? structured.summary : input.stageId,
  });

  const acceptance = evaluateCandidatesForAcceptance(structured.candidates || [], {
    nodeType: input.stageId,
    surfaces: structured.surfaces,
  });

  const pack: LastSubagentEvidence = {
    subagentId: stageKey,
    nodeType: input.stageId,
    candidates: structured.candidates || [],
    acceptance,
    at: Date.now(),
  };
  rememberSubagentEvidence(parent, pack);
}

/** A4: seed parent task session/ into stage workDir (best-effort). */
export async function seedStageSession(
  parentTaskDir: string,
  stageWorkDir: string,
): Promise<{ seeded: boolean; detail: string }> {
  return seedChildSessionFromParent(parentTaskDir, stageWorkDir);
}

/** A4: promote stage workDir session/ back to parent (best-effort). */
export async function promoteStageSession(
  stageWorkDir: string,
  parentTaskDir: string,
): Promise<{ promoted: boolean; detail: string }> {
  return promoteChildSessionToParent(stageWorkDir, parentTaskDir);
}
