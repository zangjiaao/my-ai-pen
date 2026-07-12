/**
 * Product booking harness glue (clean-room).
 * Steers the agent to book via finding+evidence immediately when work produces
 * real tool evidence — without target-specific answer keys or scoreboard scraping.
 */

export type BookingSnapshot = {
  evidenceCount: number;
  bookedFindingCount: number;
  /** Tool calls in the last prompt segment (0 = empty stop). */
  toolsInLastSegment: number;
};

/**
 * Whether evidence backlog suggests the agent is testing without booking.
 * Pure predicate for smokes + continue composition.
 */
export function bookingBacklog(snapshot: BookingSnapshot): {
  kind: "none" | "zero_bookings" | "lagging";
  unbookedEvidenceHint: number;
} {
  const { evidenceCount, bookedFindingCount } = snapshot;
  if (evidenceCount <= 0) return { kind: "none", unbookedEvidenceHint: 0 };
  if (bookedFindingCount === 0 && evidenceCount >= 2) {
    return { kind: "zero_bookings", unbookedEvidenceHint: evidenceCount };
  }
  // Rough lag: several evidence records per booking is normal; large excess is a smell.
  const excess = evidenceCount - bookedFindingCount * 4;
  if (excess >= 6) {
    return { kind: "lagging", unbookedEvidenceHint: excess };
  }
  return { kind: "none", unbookedEvidenceHint: 0 };
}

/** Mid-run / continue injection when booking lags tool evidence. */
export function midRunBookingNudge(snapshot: BookingSnapshot): string {
  const backlog = bookingBacklog(snapshot);
  if (backlog.kind === "none") return "";

  if (backlog.kind === "zero_bookings") {
    return [
      "<system-reminder>",
      `Booking gap: ${snapshot.evidenceCount} evidence record(s) exist but 0 findings are booked.`,
      "Product truth is ONLY via finding(action='confirm', evidence_ids=[...]) using real evidence_ids from shell/http/script output.",
      "If you already proved a flag, challenge unlock, vuln, or auth issue, book it NOW before more probes — one finding per distinct issue.",
      "Chat prose, todo text, and script stdout alone are not product conclusions.",
      "</system-reminder>",
    ].join("\n");
  }

  return [
    "<system-reminder>",
    `Booking lag: evidence volume is ahead of booked findings (evidence≈${snapshot.evidenceCount}, findings=${snapshot.bookedFindingCount}).`,
    "If recent tool output proved new issues (flags, unlocked challenges, exploitable vulns), call finding(confirm)+evidence_ids for each before continuing recon.",
    "</system-reminder>",
  ].join("\n");
}

/** First-turn booking rule (always, engagement-agnostic). */
export function eagerBookingInjection(): string {
  return [
    "<system-reminder>",
    "Book proven issues via finding(action='confirm')+evidence_ids. Prefer a productive multi-step shell burst, then batch several confirms in the same turn — avoid one-http / one-finding thrash.",
    "Chat or todo text is never a product conclusion. When work is done, stop without tools; there is no finish tool.",
    "</system-reminder>",
  ].join("\n");
}

export const FINDING_TOOL_DESCRIPTION = [
  "ONLY product conclusion path for vuln / flag / challenge unlock / auth impact.",
  "Call as soon as tool output proves an issue — do not wait until the end of the engagement.",
  "Requires evidence_ids from real shell/http/script/write tool output (use the evidence_id returned by those tools).",
  "action=confirm to book; action=list to list booked findings.",
  "One finding per distinct issue (title should name the issue + key proof).",
  "Booking does NOT end the engagement — keep testing after each confirm.",
  "Chat prose is never product truth.",
].join(" ");
