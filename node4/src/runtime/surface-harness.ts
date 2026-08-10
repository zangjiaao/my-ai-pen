/**
 * Soft Surface coverage harness (SEEN discipline).
 *
 * Runtime ledger is objective (Traffic settle: first→seen, later→touched).
 * This module only reminds the Agent — never hard-blocks settlement/booking.
 * Profession copy lives in experts/pentest work.md; keep vocabulary aligned.
 */

/** Stop-time soft reminder when the agent stops with surfaces still at seen. */
export function incompleteSeenSurfaceStopReminder(
  seenCount: number,
  seenSamples: string[] = [],
  attempt = 1,
  maxAttempts = 3,
): string {
  if (seenCount < 1) return "";
  const list =
    seenSamples.length > 0
      ? seenSamples
          .slice(0, 12)
          .map((t) => `  - ${t}`)
          .join("\n")
      : "";
  return [
    "<system-reminder>",
    `You stopped with ${seenCount} Surface item(s) still at **seen** (first traffic only)${list ? `:\n${list}` : "."}`,
    "seen ≠ done: re-request those identities (Runtime advances to touched) or mark deadend when appropriate before claiming recon/coverage complete.",
    "Use surface(summary|list) as the coverage queue. Open seen never blocks booking or settlement — still disclose remaining seen on pause/next_steps.",
    `(Reminder ${attempt}/${maxAttempts})`,
    "</system-reminder>",
  ].join("\n");
}

/** Gentle mid-run nudge when many surfaces remain first-touch only. */
export function midRunSeenSurfaceNudge(seenCount: number): string {
  if (seenCount < 1) return "";
  const plural = seenCount === 1 ? "is" : "are";
  return [
    "<system-reminder>",
    `Gentle reminder: ${seenCount} Surface item${seenCount === 1 ? "" : "s"} ${plural} still **seen** (first-touch only).`,
    "Call surface(summary|list) and deepen remaining seen with real requests (or deadend) — one-shot path spray is not full coverage.",
    "Do not claim recon complete while the seen set is large without an honest pause that discloses remaining work.",
    "</system-reminder>",
  ].join("\n");
}
