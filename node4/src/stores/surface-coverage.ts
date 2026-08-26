/**
 * Case Surface coverage work-state (Spec #518 v4).
 *
 * TESTED is Agent-maintained: untested | tested | skipped (reason deadend|roe).
 * Identities stay Traffic-born. This module is pure — no I/O.
 */

export const SURFACE_COVERAGES = ["untested", "tested", "skipped"] as const;
export type SurfaceCoverage = (typeof SURFACE_COVERAGES)[number];

export const SURFACE_SKIP_REASONS = ["deadend", "roe"] as const;
export type SurfaceSkipReason = (typeof SURFACE_SKIP_REASONS)[number];

const COVERAGE_SET: ReadonlySet<string> = new Set(SURFACE_COVERAGES);
const SKIP_REASON_SET: ReadonlySet<string> = new Set(SURFACE_SKIP_REASONS);

export function coerceSurfaceCoverage(value: unknown, defaultValue: SurfaceCoverage = "untested"): SurfaceCoverage {
  if (value == null || value === "") return defaultValue;
  const s = String(value).trim().toLowerCase();
  return COVERAGE_SET.has(s) ? (s as SurfaceCoverage) : defaultValue;
}

export function coerceSurfaceSkipReason(value: unknown): SurfaceSkipReason | undefined {
  if (value == null || value === "") return undefined;
  const s = String(value).trim().toLowerCase();
  if (s === "skipped_roe") return "roe";
  return SKIP_REASON_SET.has(s) ? (s as SurfaceSkipReason) : undefined;
}

/** One-time map: historical status terminals → coverage. Runtime must not re-read status as coverage. */
export function coverageFromLegacyStatus(status: string | null | undefined): {
  coverage: SurfaceCoverage;
  skip_reason?: SurfaceSkipReason;
} | null {
  const s = String(status || "").trim().toLowerCase();
  if (s === "deadend") return { coverage: "skipped", skip_reason: "deadend" };
  if (s === "skipped_roe") return { coverage: "skipped", skip_reason: "roe" };
  return null;
}

/** Graph / captain open queue: probe-machine seen|touched and coverage not closed. */
export function isSurfaceActionable(row: {
  status?: string | null;
  coverage?: string | null;
}): boolean {
  const st = String(row.status || "").trim().toLowerCase();
  if (st !== "seen" && st !== "touched" && st !== "open" && st !== "in_probe" && st !== "probed") {
    return false;
  }
  const cov = coerceSurfaceCoverage(row.coverage);
  return cov !== "tested" && cov !== "skipped";
}

export const UPSERT_TERMINAL_STATUS_ERROR =
  "surface(upsert) no longer accepts status=deadend|skipped_roe. Use surface(op=skip, reason=deadend|roe) to record coverage.";

export const SKIP_REASON_REQUIRED_ERROR =
  "surface(op=skip) requires reason=deadend|roe";

export const MISSING_IDENTITY_COVERAGE_ERROR =
  "surface identity is not on the tree — cannot invent coverage. Identities are born from Traffic settle + TARGET seed. Use surface(op=mark|unmark|skip) on an existing location / origin_key+path_key.";

export const TODO_DEADEND_NOTE_RETIRED_ERROR =
  "todo(done) note=deadend|skipped_roe is retired and does not write coverage. Use surface(op=skip, location=<identity>, reason=deadend|roe), then retry todo(done) when the ledger has no open (seen/touched and untested) identities.";
