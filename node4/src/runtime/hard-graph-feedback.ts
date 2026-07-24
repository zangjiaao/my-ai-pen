/**
 * Hard Graph Feedback (process honesty) — Product state, no answer keys.
 * Categories: structure (stage gate), discovery yield, coverage attempts.
 */

import type { SubagentStructuredResult, SubagentSurface, SubagentCandidate } from "./subagent-result.js";
import { pathKey } from "./subagent-booking.js";

export type CoverageAttemptStatus = "attempted" | "blocked" | "deadend" | "untested";

export type CoverageAttempt = {
  location: string;
  status: CoverageAttemptStatus;
  note?: string;
};

export type BookOutcomes = {
  /** Findings successfully booked this run (cumulative). */
  booked_n: number;
  /** Ground/structure/yield reject signals (cumulative). */
  reject_hints_n: number;
};

export type HardProcessMetrics = {
  stages_done: string[];
  structure_fail_n: number;
  discovery_yield_soft_fail_n: number;
  discovery_yield_notes: string[];
  new_candidates_n: number;
  surfaces_n: number;
  /**
   * Cumulative Agent Graph packages joined (real promote/host count from stage executor).
   * Never inferred solely from candidates.length.
   */
  fanout_packages_n: number;
  coverage_attempts: CoverageAttempt[];
  /** (attempted+blocked+deadend) / required surfaces; 1 when no surfaces required. */
  coverage_attempt_rate: number;
  /** Always present — booking export for dual-arm scorecards. */
  book_outcomes: BookOutcomes;
};

export type DiscoveryYieldInput = {
  stageId: string;
  /** Live surfaces known before/after stage (rich recon). */
  surfacesN: number;
  /** Worker packages joined this stage (Agent Graph). */
  fanoutPackagesN: number;
  /** New candidates produced this stage. */
  newCandidatesN: number;
  /** Honest deadends produced this stage. */
  deadendsN: number;
  /** Minimum surfaces to treat recon as "rich" for yield check. */
  richSurfacesMin?: number;
};

/**
 * Soft-fail discovery yield when fan-out (or probe stage) ran against rich surfaces
 * but produced neither candidates nor deadends — empty monologue risk.
 * No expected vuln classes; process signal only.
 */
export function evaluateDiscoveryYield(input: DiscoveryYieldInput): {
  softFail: boolean;
  reason?: string;
} {
  const richMin = input.richSurfacesMin ?? 3;
  const probeLike = /probe|class_probe|authz|auth_session|component/i.test(input.stageId);
  if (!probeLike) return { softFail: false };
  if (input.surfacesN < richMin) return { softFail: false };
  // Fan-out ran OR stage is class_probe (serial still accountable when surfaces rich)
  const accountable = input.fanoutPackagesN > 0 || /class_probe/i.test(input.stageId);
  if (!accountable) return { softFail: false };
  if (input.newCandidatesN > 0 || input.deadendsN > 0) return { softFail: false };
  return {
    softFail: true,
    reason: `discovery_yield: stage=${input.stageId} surfaces=${input.surfacesN} fanout=${input.fanoutPackagesN} but new_candidates=0 and deadends=0`,
  };
}

/**
 * Coverage attempts derived from recon surfaces vs candidates/deadends (no target keys).
 * - candidate location path-matches surface → attempted
 * - deadend string mentions surface path/location → deadend
 * - else untested (must not read as success)
 */
export function deriveCoverageAttempts(input: {
  surfaces: Array<Pick<SubagentSurface, "location"> | string>;
  candidates: Array<Pick<SubagentCandidate, "location"> | string>;
  deadends: string[];
}): CoverageAttempt[] {
  const surfaces = input.surfaces
    .map((s) => (typeof s === "string" ? s : String(s.location || "")))
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const candLocs = input.candidates
    .map((c) => (typeof c === "string" ? c : String(c.location || "")))
    .map((s) => s.trim())
    .filter(Boolean);
  const deadText = (input.deadends || []).join("\n").toLowerCase();

  const seen = new Set<string>();
  const out: CoverageAttempt[] = [];
  for (const loc of surfaces) {
    const key = pathKey(loc) || loc.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hitCand = candLocs.some((c) => {
      const ck = pathKey(c) || c.toLowerCase();
      return ck === key || ck.includes(key) || key.includes(ck);
    });
    if (hitCand) {
      out.push({ location: loc, status: "attempted", note: "candidate location matched surface" });
      continue;
    }
    const locTok = (pathKey(loc) || loc).toLowerCase();
    if (locTok.length >= 4 && deadText.includes(locTok.slice(0, Math.min(locTok.length, 48)))) {
      out.push({ location: loc, status: "deadend", note: "mentioned in deadends" });
      continue;
    }
    out.push({ location: loc, status: "untested" });
  }
  return out;
}

export function coverageAttemptRate(attempts: CoverageAttempt[]): number {
  if (!attempts.length) return 1;
  const done = attempts.filter((a) => a.status !== "untested").length;
  return done / attempts.length;
}

export function emptyHardProcessMetrics(): HardProcessMetrics {
  return {
    stages_done: [],
    structure_fail_n: 0,
    discovery_yield_soft_fail_n: 0,
    discovery_yield_notes: [],
    new_candidates_n: 0,
    surfaces_n: 0,
    fanout_packages_n: 0,
    coverage_attempts: [],
    coverage_attempt_rate: 1,
    book_outcomes: { booked_n: 0, reject_hints_n: 0 },
  };
}

/**
 * Fold a completed stage attempt into process metrics (runner-owned Feedback).
 * `fanoutPackagesN` must be the real Join count from the stage executor (0 if none).
 */
export function accumulateStageFeedback(
  metrics: HardProcessMetrics,
  input: {
    stageId: string;
    structured: SubagentStructuredResult;
    structureFailed: boolean;
    /** Real packages joined this stage (from promote/host). Default 0 — do not invent. */
    fanoutPackagesN?: number;
    bookOutcomes?: { booked_n?: number; reject_hints_n?: number };
    handoffSurfacesN?: number;
  },
): HardProcessMetrics {
  const fanoutN =
    typeof input.fanoutPackagesN === "number" && Number.isFinite(input.fanoutPackagesN)
      ? Math.max(0, Math.floor(input.fanoutPackagesN))
      : 0;
  const next: HardProcessMetrics = {
    ...metrics,
    stages_done: metrics.stages_done.includes(input.stageId)
      ? metrics.stages_done
      : [...metrics.stages_done, input.stageId],
    structure_fail_n: metrics.structure_fail_n + (input.structureFailed ? 1 : 0),
    new_candidates_n: metrics.new_candidates_n + (input.structured.candidates?.length || 0),
    surfaces_n: Math.max(
      metrics.surfaces_n,
      input.handoffSurfacesN ?? 0,
      input.structured.surfaces?.length || 0,
    ),
    fanout_packages_n: metrics.fanout_packages_n + fanoutN,
    discovery_yield_notes: [...metrics.discovery_yield_notes],
    book_outcomes: {
      booked_n: metrics.book_outcomes.booked_n + (input.bookOutcomes?.booked_n || 0),
      reject_hints_n:
        metrics.book_outcomes.reject_hints_n +
        (input.structureFailed ? 1 : 0) +
        (input.bookOutcomes?.reject_hints_n || 0),
    },
  };

  const yieldEval = evaluateDiscoveryYield({
    stageId: input.stageId,
    surfacesN: next.surfaces_n,
    fanoutPackagesN: fanoutN,
    newCandidatesN: input.structured.candidates?.length || 0,
    deadendsN: input.structured.deadends?.length || 0,
  });
  if (yieldEval.softFail) {
    next.discovery_yield_soft_fail_n += 1;
    if (yieldEval.reason) next.discovery_yield_notes.push(yieldEval.reason);
    next.book_outcomes = {
      ...next.book_outcomes,
      reject_hints_n: next.book_outcomes.reject_hints_n + 1,
    };
  }

  // Recompute coverage from cumulative surfaces in structured + prior attempts locations
  const surfaceLocs = [
    ...next.coverage_attempts.map((a) => a.location),
    ...(input.structured.surfaces || []).map((s) => s.location),
  ];
  // Prefer structured surfaces list if growing handoff surfaces passed
  const uniqueSurfaces = Array.from(
    new Map(
      [
        ...surfaceLocs.map((l) => ({ location: l })),
        ...(input.structured.surfaces || []),
      ]
        .filter((s) => s.location)
        .map((s) => [pathKey(s.location) || s.location, s]),
    ).values(),
  );

  next.coverage_attempts = deriveCoverageAttempts({
    surfaces: uniqueSurfaces,
    candidates: input.structured.candidates || [],
    // Keep prior attempted by merging: re-derive only from this stage loses prior — merge statuses
    deadends: input.structured.deadends || [],
  });

  // Merge: if prior attempt was better than untested, keep better
  const priorMap = new Map(metrics.coverage_attempts.map((a) => [pathKey(a.location) || a.location, a]));
  const rank = (s: CoverageAttemptStatus) =>
    s === "attempted" ? 3 : s === "deadend" ? 2 : s === "blocked" ? 2 : 0;
  next.coverage_attempts = next.coverage_attempts.map((a) => {
    const k = pathKey(a.location) || a.location;
    const prev = priorMap.get(k);
    if (prev && rank(prev.status) > rank(a.status)) return prev;
    return a;
  });
  // Add prior surfaces not in this stage
  for (const [k, prev] of priorMap) {
    if (!next.coverage_attempts.some((a) => (pathKey(a.location) || a.location) === k)) {
      next.coverage_attempts.push(prev);
    }
  }

  next.coverage_attempt_rate = coverageAttemptRate(next.coverage_attempts);
  return next;
}
