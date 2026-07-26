/**
 * Hard Graph Feedback (process honesty) — Product state, no answer keys.
 * Categories: structure (stage gate), discovery yield, coverage attempts.
 */

import type { SubagentStructuredResult, SubagentSurface, SubagentCandidate } from "./subagent-result.js";
import { pathKey } from "./subagent-booking.js";

/**
 * Surface-family status (Spec #111).
 * Legacy wire alias: "attempted" is DEPRECATED and must not mean candidate path-match.
 * Prefer probed | deadend | booked | skipped_roe | in_probe | untested.
 */
export type CoverageAttemptStatus =
  | "probed"
  | "deadend"
  | "booked"
  | "skipped_roe"
  | "in_probe"
  | "untested"
  /** @deprecated Spec #111 — do not emit for candidate-match; maps to probed if needed for old readers */
  | "attempted"
  | "blocked";

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
  /**
   * Surface-family ledger rows (Spec #111 five families: surface).
   * Statuses are ledger-like; candidate-match alone must not invent probed.
   */
  coverage_attempts: CoverageAttempt[];
  /**
   * Spec #111 R1 / I1.2: terminal surface statuses only / total (in_probe excluded).
   * Preferred honest name for the surface family rate.
   */
  surface_acted_rate: number;
  /**
   * @deprecated Spec #111 — alias of surface_acted_rate (same R1 semantics).
   * Do not interpret as "candidate path-match = attempted".
   */
  coverage_attempt_rate: number;
  /** Always present — booking export for dual-arm scorecards (JSON findings / stage delta). */
  book_outcomes: BookOutcomes;
  /**
   * Spec #111 findings family (I1.4): Finding Store booked count (absolute).
   * Distinct from book_outcomes.booked_n (stage JSON/platform delta accumulate).
   * Compare to platform-visible via findingsBookedAlignment.
   */
  findings_booked_n: number;
  /**
   * Spec #111 L2 family: done-only numerator rate (I1.5 S1). Optional when L2 not projected.
   */
  l2_done_rate?: number;
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
 * Surface coverage from ledger-like statuses (Spec #111).
 * **I1.2:** candidate path-match alone does **not** mark probed/attempted.
 * - optional per-surface status from SurfaceLedger
 * - deadend string mentions surface path → deadend
 * - else untested (must not read as success)
 */
export function deriveCoverageAttempts(input: {
  surfaces: Array<Pick<SubagentSurface, "location"> | string | { location: string; status?: string }>;
  /**
   * Probe evidence locations only. Upgrade surface when **pathKey equals** a candidate location
   * (exact pathname). Loose substring match is forbidden (Spec #111 I1.2).
   */
  candidates?: Array<Pick<SubagentCandidate, "location"> | string>;
  deadends: string[];
}): CoverageAttempt[] {
  const deadText = (input.deadends || []).join("\n").toLowerCase();
  const candKeys = new Set(
    (input.candidates || [])
      .map((c) => (typeof c === "string" ? c : String(c.location || "")))
      .map((s) => pathKey(s.trim()))
      .filter((k) => k.length >= 2),
  );

  const seen = new Set<string>();
  const out: CoverageAttempt[] = [];
  for (const raw of input.surfaces) {
    const loc =
      typeof raw === "string"
        ? raw.trim()
        : String((raw as { location?: string }).location || "").trim();
    if (loc.length < 2) continue;
    const key = pathKey(loc) || loc.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const explicit =
      typeof raw === "object" && raw && "status" in raw
        ? String((raw as { status?: string }).status || "")
            .trim()
            .toLowerCase()
        : "";
    if (
      explicit === "probed" ||
      explicit === "booked" ||
      explicit === "deadend" ||
      explicit === "skipped_roe" ||
      explicit === "in_probe" ||
      explicit === "skipped"
    ) {
      const st =
        explicit === "skipped" ? "skipped_roe" : (explicit as CoverageAttemptStatus);
      out.push({ location: loc, status: st, note: `ledger status=${explicit}` });
      continue;
    }

    const locTok = (pathKey(loc) || loc).toLowerCase();
    if (locTok.length >= 4 && deadText.includes(locTok.slice(0, Math.min(locTok.length, 48)))) {
      out.push({ location: loc, status: "deadend", note: "mentioned in deadends" });
      continue;
    }
    // Exact pathKey match only — not loose includes (Spec #111).
    if (key && candKeys.has(key)) {
      out.push({
        location: loc,
        status: "probed",
        note: "candidate at same pathKey (probe evidence)",
      });
      continue;
    }
    out.push({ location: loc, status: "untested" });
  }
  return out;
}

/** Terminal surface statuses for R1 surface_acted_rate (I1.2). */
export function isSurfaceTerminalStatus(status: CoverageAttemptStatus | string): boolean {
  const s = String(status || "");
  return s === "probed" || s === "deadend" || s === "booked" || s === "skipped_roe" || s === "attempted";
}

/**
 * surface_acted_rate R1: terminal only; in_probe excluded from numerator.
 * Empty ledger → 1 (no surfaces required).
 */
export function surfaceActedRate(attempts: CoverageAttempt[]): number {
  if (!attempts.length) return 1;
  const done = attempts.filter((a) => isSurfaceTerminalStatus(a.status)).length;
  return done / attempts.length;
}

/** @deprecated Use surfaceActedRate — name kept for callers; semantics are R1 terminal. */
export function coverageAttemptRate(attempts: CoverageAttempt[]): number {
  return surfaceActedRate(attempts);
}

/** Fanout P1: count all executed package attempts (success+fail+abort). */
export function countFanoutPackagesP1(input: {
  success_n?: number;
  fail_n?: number;
  abort_n?: number;
  executed_n?: number;
}): number {
  if (typeof input.executed_n === "number" && Number.isFinite(input.executed_n)) {
    return Math.max(0, Math.floor(input.executed_n));
  }
  return (
    Math.max(0, Math.floor(input.success_n || 0)) +
    Math.max(0, Math.floor(input.fail_n || 0)) +
    Math.max(0, Math.floor(input.abort_n || 0))
  );
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
    surface_acted_rate: 1,
    coverage_attempt_rate: 1,
    book_outcomes: { booked_n: 0, reject_hints_n: 0 },
    findings_booked_n: 0,
  };
}

/**
 * Five metric families must not impersonate each other (I1.1).
 * Returns family keys present on process metrics for contract tests.
 */
export function metricFamilyKeys(): readonly string[] {
  return ["surface", "fanout", "findings", "l2", "soft"] as const;
}

/** I1.4: Store booked vs platform-visible mismatch is a red alignment signal. */
export function findingsBookedAlignment(input: {
  findings_booked_n: number;
  platform_visible_n: number;
}): { aligned: boolean; red_signal: boolean } {
  const a = Math.max(0, Math.floor(input.findings_booked_n));
  const b = Math.max(0, Math.floor(input.platform_visible_n));
  const aligned = a === b;
  return { aligned, red_signal: !aligned };
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
    /**
     * Absolute Finding Store booked count after this stage (I1.4 findings family).
     * When omitted, prior findings_booked_n is kept (do not invent from candidates).
     */
    findingsBookedN?: number;
    handoffSurfacesN?: number;
  },
): HardProcessMetrics {
  const fanoutN =
    typeof input.fanoutPackagesN === "number" && Number.isFinite(input.fanoutPackagesN)
      ? Math.max(0, Math.floor(input.fanoutPackagesN))
      : 0;
  const bookedDelta = input.bookOutcomes?.booked_n || 0;
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
      booked_n: metrics.book_outcomes.booked_n + bookedDelta,
      reject_hints_n:
        metrics.book_outcomes.reject_hints_n +
        (input.structureFailed ? 1 : 0) +
        (input.bookOutcomes?.reject_hints_n || 0),
    },
    // Absolute Store count when stage reports it; else keep prior (never invent).
    findings_booked_n:
      typeof input.findingsBookedN === "number" && Number.isFinite(input.findingsBookedN)
        ? Math.max(0, Math.floor(input.findingsBookedN))
        : metrics.findings_booked_n ?? 0,
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
    s === "booked" || s === "probed" || s === "attempted"
      ? 3
      : s === "deadend" || s === "skipped_roe" || s === "blocked"
        ? 2
        : s === "in_probe"
          ? 1
          : 0;
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

  const rate = surfaceActedRate(next.coverage_attempts);
  next.surface_acted_rate = rate;
  next.coverage_attempt_rate = rate; // deprecated alias — same R1 value
  return next;
}
