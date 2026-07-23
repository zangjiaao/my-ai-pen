/**
 * Hard Graph stage continuity (A1 booking/proof + A4 session lifecycle).
 *
 * Parent lifecycle is SOT between stages. Session jars use
 * seedChildSessionFromParent / promoteChildSessionToParent directly (no wrappers).
 *
 * Retry policy: when a stage re-absorbs with candidates, upsert by stageKey
 * (drop prior pack + inject observations for that key). Empty-candidate absorbs
 * do not wipe a prior pack for the same stage.
 */

import type { ToolRuntime } from "../types.js";
import {
  RECENT_OBS_CAP,
  type RecentObservation,
} from "../tools/common.js";
import { injectParentObservationsFromChild } from "./subagent-parent-obs.js";
import {
  rememberSubagentEvidence,
  type LastSubagentEvidence,
} from "./subagent-booking.js";
import {
  evaluateCandidatesForAcceptance,
  type SubagentStructuredResult,
} from "./subagent-result.js";

export type StageContinuitySeed = {
  /**
   * Fingerprints of observations present on the child after seed.
   * Merge any child observation not in this set (append or full array replace).
   */
  fingerprints: Set<string>;
};

export function observationFingerprint(o: RecentObservation): string {
  return [
    o.at,
    o.sourceTool,
    o.excerpt,
    o.path_or_url || "",
    o.capture?.command || "",
    o.capture?.via || "",
  ].join("\0");
}

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
  c.recentObservations = obs.map((o) => ({
    ...o,
    capture: o.capture ? { ...o.capture } : undefined,
  }));

  const cache = p.subagentEvidenceCache || [];
  c.subagentEvidenceCache = cache.map((pack) => ({
    ...pack,
    candidates: (pack.candidates || []).map((cand) => ({ ...cand })),
  }));

  if (p.lastSubagentEvidence) {
    c.lastSubagentEvidence = {
      ...p.lastSubagentEvidence,
      candidates: (p.lastSubagentEvidence.candidates || []).map((cand) => ({ ...cand })),
    };
  } else {
    c.lastSubagentEvidence = undefined;
  }

  c.subagentCandidateIndex = p.subagentCandidateIndex
    ? p.subagentCandidateIndex.map((x) => ({ ...x }))
    : undefined;

  const fingerprints = new Set(c.recentObservations.map(observationFingerprint));
  return { fingerprints };
}

/**
 * True when an inject observation summary belongs to exactly this stageKey.
 * Inject format: `subagent ${subagentId} …` or `subagent ${subagentId} candidate: …`
 * Token boundary after the key so `hard-stage:class` does not match `hard-stage:class_probe`.
 */
export function observationSummaryBelongsToStageKey(
  summary: string,
  stageKey: string,
): boolean {
  const prefix = `subagent ${stageKey}`;
  if (!String(summary || "").startsWith(prefix)) return false;
  const next = summary.charAt(prefix.length);
  // End, whitespace, or inject delimiters — not another id character (_-alphanumeric).
  return next === "" || /[\s\[:]/.test(next);
}

/** Drop prior inject observations and cache packs for a hard-stage key. */
export function dropStageKeyContinuity(parent: ToolRuntime, stageKey: string): void {
  const life = parent.lifecycle || (parent.lifecycle = {});
  if (life.recentObservations?.length) {
    life.recentObservations = life.recentObservations.filter(
      (o) => !observationSummaryBelongsToStageKey(String(o.summary || ""), stageKey),
    );
  }
  if (life.subagentEvidenceCache?.length) {
    life.subagentEvidenceCache = life.subagentEvidenceCache.filter(
      (p) => p.subagentId !== stageKey,
    );
  }
  if (life.lastSubagentEvidence?.subagentId === stageKey) {
    life.lastSubagentEvidence = undefined;
  }
}

function mergeNewChildObservations(
  parent: ToolRuntime,
  child: ToolRuntime,
  seed: StageContinuitySeed,
): void {
  const childObs = child.lifecycle?.recentObservations || [];
  if (!childObs.length) return;
  const parentLife = parent.lifecycle || (parent.lifecycle = {});
  const list = (parentLife.recentObservations ||= []);
  const parentFps = new Set(list.map(observationFingerprint));
  for (const o of childObs) {
    const fp = observationFingerprint(o);
    if (seed.fingerprints.has(fp)) continue;
    if (parentFps.has(fp)) continue;
    list.push({ ...o, capture: o.capture ? { ...o.capture } : undefined });
    parentFps.add(fp);
  }
  while (list.length > RECENT_OBS_CAP) list.shift();
}

/**
 * Merge stage outcomes into parent so the next stage (e.g. validate_book) can book.
 * Upserts bookable material by stageKey when candidates are present.
 * Propagates absorb errors (do not swallow) — session promote is caller's best-effort.
 *
 * Policy: child shell/http acts merge append-only across retries (sticky grounding).
 * Only inject-tagged rows for this stageKey are dropped on candidate upsert; booking
 * cache still resolves the latest pack's verbatim proof.
 */
export function absorbStageResultIntoParent(
  parent: ToolRuntime,
  input: {
    stageId: string;
    structured: SubagentStructuredResult;
    child?: ToolRuntime;
    seed?: StageContinuitySeed;
  },
): void {
  if (input.child && input.seed) {
    mergeNewChildObservations(parent, input.child, input.seed);
  }

  const stageKey = `hard-stage:${input.stageId}`;
  const structured = input.structured;
  const hasCandidates = (structured.candidates || []).length > 0;

  // Empty-candidate attempt (failed retry, surface-only): keep prior stageKey pack if any.
  if (!hasCandidates) {
    return;
  }

  // Last absorb with candidates for this stage wins (retry-safe upsert).
  dropStageKeyContinuity(parent, stageKey);

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
