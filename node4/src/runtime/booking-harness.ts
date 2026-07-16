/**
 * Product booking harness glue (clean-room).
 *
 * Model (simple):
 *   Finding  = user-trustable conclusion
 *   Evidence = materials created **when booking** from the agent's proof
 * Act tools only keep recent observations in memory (for anti-hallucination).
 * Agents do not hunt opaque evidence_ids.
 */

export type BookingSnapshot = {
  /** Recent act observations (or legacy evidence file count). */
  evidenceCount: number;
  bookedFindingCount: number;
  toolsInLastSegment: number;
};

export function bookingBacklog(snapshot: BookingSnapshot): {
  kind: "none" | "zero_bookings" | "lagging";
  unbookedEvidenceHint: number;
} {
  const { evidenceCount, bookedFindingCount } = snapshot;
  if (evidenceCount <= 0) return { kind: "none", unbookedEvidenceHint: 0 };
  if (bookedFindingCount === 0 && evidenceCount >= 2) {
    return { kind: "zero_bookings", unbookedEvidenceHint: evidenceCount };
  }
  // Lag: many probes relative to few bookings.
  const excess = evidenceCount - bookedFindingCount * 4;
  if (excess >= 6) {
    return { kind: "lagging", unbookedEvidenceHint: excess };
  }
  return { kind: "none", unbookedEvidenceHint: 0 };
}

export function midRunBookingNudge(snapshot: BookingSnapshot): string {
  const backlog = bookingBacklog(snapshot);
  if (backlog.kind === "none") return "";

  if (backlog.kind === "zero_bookings") {
    return [
      "<system-reminder>",
      `Booking gap: ${snapshot.evidenceCount} probe observation(s) but 0 findings booked.`,
      "Product truth is finding(confirm) with location, description, poc, and proof.",
      "proof = proving fragment copied from your tool output (response body / reflection / stdout).",
      "Case evidence is created automatically from that proof — do not hunt evidence_ids.",
      "Chat prose alone is not a conclusion.",
      "</system-reminder>",
    ].join("\n");
  }

  return [
    "<system-reminder>",
    `Booking lag: probes≈${snapshot.evidenceCount}, findings=${snapshot.bookedFindingCount}.`,
    "If a probe proved an issue, book with finding(confirm): location + poc + proof (quote the real observation).",
    "</system-reminder>",
  ].join("\n");
}

export function eagerBookingInjection(): string {
  return [
    "<system-reminder>",
    "Book only issues you can *prove* with finding(confirm).",
    "Required: title, location, description, poc (how + observed result), proof (proving fragment from tool output).",
    "Finding = user-trustable conclusion. Evidence is created from your proof at booking time — one strong proof is enough.",
    "Do not pass evidence_ids; quote real stdout/response text into proof after probing.",
    "Chat/todo text is never product truth. When done, stop without tools.",
    "</system-reminder>",
  ].join("\n");
}

export const FINDING_TOOL_DESCRIPTION = [
  "ONLY product conclusion path for vuln / flag / challenge unlock / auth impact.",
  "Finding = user-trustable conclusion; proof = fragment from your tool output that demonstrates the claim.",
  "action=confirm requires: title, location|url, description, poc (≥40 chars how+result), proof (proving observation ≥24 chars from real tool output).",
  "Case evidence is created automatically from proof — do not look up or pass evidence_ids.",
  "Prefer quoting response body / reflection / proving stdout. One strong proof is enough to trust and reproduce.",
  "action=list lists booked findings. Booking does NOT end the engagement.",
  "Chat prose is never product truth.",
].join(" ");

/** Soft trust signals after confirm (kept for metrics; short lists are fine). */
export type BookingChainAssessment = {
  short_chain: boolean;
  shared_proof: boolean;
  chain_length: number;
  warnings: string[];
  nudge: string;
};

export type BookingChainProofStep = {
  evidence_id: string;
  excerpt: string;
  role: "proof" | "support";
};

/** Soft assessment — book-time single proof is healthy; only warn on weak shared reuse. */
export function assessBookingChainQuality(input: {
  evidenceIds: string[];
  location: string;
  proofExcerpts: BookingChainProofStep[];
  reuseCounts: Map<string, number>;
  locationSupported?: (excerpt: string, location: string) => boolean;
}): BookingChainAssessment {
  const evidenceIds = input.evidenceIds.filter(Boolean);
  const chain_length = evidenceIds.length;
  const short_chain = chain_length < 2;
  const warnings: string[] = [];
  let shared_proof = false;

  for (const step of input.proofExcerpts) {
    if (step.role !== "proof") continue;
    const prior = input.reuseCounts.get(step.evidence_id) || 0;
    if (prior < 1) continue;
    shared_proof = true;
    const locOk = input.locationSupported
      ? input.locationSupported(step.excerpt, input.location)
      : true;
    if (!locOk) {
      warnings.push(
        `Proof material does not clearly support ${input.location}. Next booking: quote a claim-specific observation for this location.`,
      );
    }
  }

  const uniqueWarnings = [...new Set(warnings)];
  const nudge =
    uniqueWarnings.length === 0
      ? ""
      : [
          "booking_nudge (soft — finding was still booked):",
          ...uniqueWarnings.map((w, i) => `${i + 1}) ${w}`),
        ].join("\n");

  return { short_chain, shared_proof, chain_length, warnings: uniqueWarnings, nudge };
}
