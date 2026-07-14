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
      "Product truth is ONLY via finding(confirm) with evidence_ids whose response body/stdout *shows* the issue.",
      "Required: title, location/url, description, poc (steps + observed result), evidence_ids with demonstrable output.",
      "Sharing one evidence across findings is fine when that output proves each claim; status-only or empty evidence is rejected.",
      "Chat prose alone is not a conclusion — book only what the evidence demonstrates.",
      "</system-reminder>",
    ].join("\n");
  }

  return [
    "<system-reminder>",
    `Booking lag: evidence≈${snapshot.evidenceCount}, findings=${snapshot.bookedFindingCount}.`,
    "If tool output proved a new issue, book with finding(confirm)+evidence_ids that contain the proving response/stdout, plus a concrete poc.",
    "</system-reminder>",
  ].join("\n");
}

/** First-turn booking rule (always, engagement-agnostic). */
export function eagerBookingInjection(): string {
  return [
    "<system-reminder>",
    "Book only issues you can *prove*: finding(confirm) needs location, description, poc (how + observed result), and evidence_ids.",
    "Evidence must capture demonstrable output (HTTP response body, redirect Location, or shell stdout) — not status-only or empty login wrappers.",
    "Multiple findings may share one evidence_id when that one output proves each claim; otherwise run a dedicated probe.",
    "Chat/todo text is never product truth. When done, stop without tools.",
    "</system-reminder>",
  ].join("\n");
}

export const FINDING_TOOL_DESCRIPTION = [
  "ONLY product conclusion path for vuln / flag / challenge unlock / auth impact.",
  "Goal: book only what tool output can demonstrate exists — as soon as a probe proves an issue.",
  "action=confirm requires: title, location|url, description, poc (≥40 chars with request/payload/steps AND observed result), evidence_ids.",
  "Each evidence_id must contain demonstrable output (response body / stdout / redirect), not HTTP status alone.",
  "Multiple findings may reuse one evidence_id if that evidence's output supports each claim; otherwise use a dedicated probe evidence.",
  "action=list lists booked findings. Booking does NOT end the engagement.",
  "Chat prose is never product truth.",
].join(" ");
