/**
 * Soft Surface coverage harness — NEW → TESTED discipline (#411).
 *
 * Runtime ledger is objective (Traffic settle: first→seen, later→touched/TESTED).
 * Inventory novelty (is_new) is preferred when present; otherwise first-touch
 * status=seen is the temporary untested fallback until Node dual-writes is_new.
 * This module only reminds the Agent — never hard-blocks settlement/booking.
 * Profession copy lives in experts/pentest work.md; keep vocabulary aligned.
 */

/** Minimal row shape for queue selection (SQLite SurfaceRow or lean fixtures). */
export type SurfaceCoverageRow = {
  status?: string | null;
  /** Inventory novelty (Spec #410). Optional until Node dual-writes from platform. */
  is_new?: boolean | null;
  isNew?: boolean | null;
  path_key?: string | null;
  location?: string | null;
  id?: string | null;
};

function rowIsNew(row: SurfaceCoverageRow): boolean | undefined {
  if (row.is_new === true || row.isNew === true) return true;
  if (row.is_new === false || row.isNew === false) return false;
  return undefined;
}

/**
 * Select the soft-coverage queue: prefer inventory **NEW untested**
 * (is_new && status=seen); fallback to all first-touch **seen** when no is_new flags.
 * Never hard-blocks — callers only use this for reminders.
 */
export function selectNewUntestedSurfaces(
  rows: SurfaceCoverageRow[],
  sampleMax = 12,
): { count: number; samples: string[]; mode: "new_untested" | "seen_fallback" } {
  const list = Array.isArray(rows) ? rows : [];
  const hasIsNewFlag = list.some((r) => rowIsNew(r) !== undefined);
  const untested = hasIsNewFlag
    ? list.filter((r) => rowIsNew(r) === true && String(r.status || "") === "seen")
    : list.filter((r) => String(r.status || "") === "seen");
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

/** Stop-time soft reminder when the agent stops with NEW untested (or seen fallback) remaining. */
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
    "<system-reminder>",
    `You stopped with ${newUntestedCount} Surface item(s) still **NEW untested** (not yet TESTED this Case)${list ? `:\n${list}` : "."}`,
    "Duty: NEW → TESTED via real further traffic (Runtime), or mark deadend/skipped_roe. Platform vuln priors alone ≠ this-Case TESTED / ≠ coverage complete.",
    "Use surface(summary|list) as the coverage queue. Open NEW untested never blocks booking or settlement — still disclose remaining NEW untested on pause/next_steps.",
    `(Reminder ${attempt}/${maxAttempts})`,
    "</system-reminder>",
  ].join("\n");
}

/** Gentle mid-run nudge when NEW untested (or seen fallback) remain. */
export function midRunNewUntestedSurfaceNudge(newUntestedCount: number): string {
  if (newUntestedCount < 1) return "";
  const plural = newUntestedCount === 1 ? "is" : "are";
  return [
    "<system-reminder>",
    `Gentle reminder: ${newUntestedCount} Surface item${newUntestedCount === 1 ? "" : "s"} ${plural} still **NEW untested** (not yet TESTED this Case).`,
    "Call surface(summary|list) and drive NEW → TESTED with real requests (or deadend) — platform priors are re-verify context, not a skip list.",
    "Do not claim recon/coverage complete while NEW untested remain without an honest pause that discloses the queue.",
    "</system-reminder>",
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
