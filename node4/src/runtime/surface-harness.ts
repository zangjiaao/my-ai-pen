/**
 * Soft Surface coverage harness — NEW → TESTED discipline (#411 / #518).
 *
 * Coverage work-state is Agent-maintained (untested | tested | skipped).
 * Identities stay Traffic-born. This module only reminds the Agent — never
 * hard-blocks settlement/booking. Profession copy lives in experts/pentest work.md.
 */

/** Minimal row shape for queue selection (SQLite SurfaceRow or lean fixtures). */
export type SurfaceCoverageRow = {
  status?: string | null;
  /** Inventory novelty (Spec #410). Optional until Node dual-writes is_new. */
  is_new?: boolean | null;
  isNew?: boolean | null;
  /** Spec #518 — Agent-maintained coverage. */
  coverage?: string | null;
  path_key?: string | null;
  location?: string | null;
  id?: string | null;
};

function rowIsNew(row: SurfaceCoverageRow): boolean | undefined {
  if (row.is_new === true || row.isNew === true) return true;
  if (row.is_new === false || row.isNew === false) return false;
  return undefined;
}

function rowCoverageUntested(row: SurfaceCoverageRow): boolean {
  const cov = String(row.coverage || "untested").trim().toLowerCase();
  return cov !== "tested" && cov !== "skipped";
}

/**
 * Select the soft-coverage queue: prefer inventory **NEW untested**
 * (is_new && coverage untested); fallback when no is_new flags to all untested.
 */
export function selectNewUntestedSurfaces(
  rows: SurfaceCoverageRow[],
  sampleMax = 12,
): { count: number; samples: string[]; mode: "new_untested" | "seen_fallback" } {
  const list = Array.isArray(rows) ? rows : [];
  const hasIsNewFlag = list.some((r) => rowIsNew(r) !== undefined);
  const untested = hasIsNewFlag
    ? list.filter((r) => rowIsNew(r) === true && rowCoverageUntested(r))
    : list.filter((r) => rowCoverageUntested(r));
  const samples = untested
    .slice(0, sampleMax)
    .map((s) => s.path_key || s.location || s.id || "")
    .filter(Boolean);
  return {
    count: untested.length,
    samples,
    mode: hasIsNewFlag ? "new_untested" : "seen_fallback",
  };
}

/** Stop-time soft reminder when the agent stops with NEW untested remaining. */
export function incompleteNewUntestedSurfaceStopReminder(
  newUntestedCount: number,
  samples: string[] = [],
  attempt = 1,
  maxAttempts = 3,
): string {
  if (newUntestedCount < 1) return "";
  const list =
    samples.length > 0
      ? samples
          .slice(0, 12)
          .map((t) => `  - ${t}`)
          .join("\n")
      : "";
  return [
    "### Surface",
    `You stopped with ${newUntestedCount} Surface item(s) still **NEW untested** (coverage work-state untested)${list ? `:\n${list}` : "."}`,
    "Duty: NEW → TESTED via surface(op=mark) after you actually tested the identity, or surface(op=skip, reason=deadend|roe). Traffic purpose=test does not mark TESTED. Platform vuln priors alone ≠ this-Case TESTED / ≠ coverage complete.",
    "Use surface(summary|list) as the coverage queue. Open NEW untested never blocks booking or settlement — still disclose remaining NEW untested on pause/next_steps.",
    `(Reminder ${attempt}/${maxAttempts})`,
  ].join("\n");
}

/** Gentle mid-run nudge when NEW untested remain. */
export function midRunNewUntestedSurfaceNudge(newUntestedCount: number): string {
  if (newUntestedCount < 1) return "";
  const plural = newUntestedCount === 1 ? "is" : "are";
  return [
    "### Surface",
    `Gentle reminder: ${newUntestedCount} Surface item${newUntestedCount === 1 ? "" : "s"} ${plural} still **NEW untested** (coverage work-state untested).`,
    "Call surface(summary|list) and drive NEW → TESTED with surface(op=mark) after real tests (or skip) — platform priors are re-verify context, not a skip list.",
    "Do not claim recon/coverage complete while NEW untested remain without an honest pause that discloses the queue.",
  ].join("\n");
}

/** @deprecated Prefer incompleteNewUntestedSurfaceStopReminder (#411). Alias for call-site migration. */
export function incompleteSeenSurfaceStopReminder(
  seenCount: number,
  seenSamples: string[] = [],
  attempt = 1,
  maxAttempts = 3,
): string {
  return incompleteNewUntestedSurfaceStopReminder(seenCount, seenSamples, attempt, maxAttempts);
}

/** @deprecated Prefer midRunNewUntestedSurfaceNudge (#411). Alias for call-site migration. */
export function midRunSeenSurfaceNudge(seenCount: number): string {
  return midRunNewUntestedSurfaceNudge(seenCount);
}
