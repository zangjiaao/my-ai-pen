/**
 * NC-Honesty-Advance: host-authored fixed-template L0 repair brief for next stage attempt.
 * Machine fields only — not L1 Critic prose.
 */

export type L0RepairBriefInput = {
  stageId: string;
  /** 1-based attempt that just failed (brief is for the next attempt). Unused in booking_tail mode. */
  failedAttempt: number;
  /** Gate errors from evaluateStageGate / host deadends. */
  errors: string[];
  /** repair = retry same stage after L0 fail; booking_tail = post-block booking-only duties. */
  mode?: "repair" | "booking_tail";
};

function formatHardSignals(errors: string[]): string[] {
  const cleaned = (errors || [])
    .map((e) => String(e || "").trim())
    .filter(Boolean);
  if (!cleaned.length) {
    return ["- (none listed — re-check package terminals and structure require)"];
  }
  return cleaned.map((e) => `- ${e}`);
}

/**
 * Fixed template injected into Main context on stage attempt > 1 after L0 fail,
 * or for booking-only tail after mid-graph honesty block.
 */
export function formatL0RepairBrief(input: L0RepairBriefInput): string {
  const stageId = String(input.stageId || "").trim() || "unknown";
  if (input.mode === "booking_tail") {
    return [
      "### L0 booking-only tail brief (host; NC-Honesty-Advance)",
      `stage_id: ${stageId}`,
      "booking_only_tail: true",
      "upstream_stage_blocked: true",
      "Main duties: confirm remaining feedback_ok rows; book or mark unbookable; do not open new probe packages.",
      "Forbidden: treat this as a full-graph success path; do not invent new attack classes.",
      "hard_signals:",
      ...formatHardSignals(input.errors),
    ].join("\n");
  }

  const lines = [
    "### L0 stage settlement repair brief (host; NC-Honesty-Advance)",
    `stage_id: ${stageId}`,
    `prior_failed_attempt: ${Math.max(1, Math.floor(input.failedAttempt || 1))}`,
    "cannot_advance: true",
    "This stage attempt must not pass until hard signals are cleared.",
    "Main duties (M1): fix illegal L2 declaration | honest deadend/fail failed packages (keep successes) | re-dispatch same package with new instructions | abandon package + new strategy package | drive running packages to a real terminal.",
    "Forbidden: ignore this brief and silent-green L2 over failed/unfinished packages.",
    "L1 Critic will not run until stage L0 (honesty + structure) passes.",
    "hard_signals:",
    ...formatHardSignals(input.errors),
  ];
  return lines.join("\n");
}

/**
 * True when final gate errors are honesty cannot-advance (illegal L2 done / running package).
 * Structure-only and pure L1 budget exhaust must not trigger post-block booking tail.
 */
export function isHonestyCannotAdvanceErrors(errors: string[]): boolean {
  return (errors || []).some((e) => {
    const s = String(e || "").trim();
    return s.startsWith("illegal_l2_done:") || s.startsWith("running_package:");
  });
}

/** Booking-only stages still run after mid-graph honesty block (NC-Honesty-Advance V1). */
export function isBookingOnlyStage(stage: {
  intent?: string;
  unbookable_on_exit?: boolean;
  id?: string;
}): boolean {
  if (stage.unbookable_on_exit) return true;
  const intent = String(stage.intent || "").toLowerCase();
  if (intent === "book") return true;
  const id = String(stage.id || "").toLowerCase();
  return id === "validate_book" || id.endsWith("_book");
}
