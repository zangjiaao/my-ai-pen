/**
 * NC-Honesty-Advance: host-authored fixed-template L0 repair brief for next stage attempt.
 * Machine fields only — not L1 Critic prose.
 */

export type L0RepairBriefInput = {
  stageId: string;
  /** 1-based attempt that just failed (brief is for the next attempt). */
  failedAttempt: number;
  /** Gate errors from evaluateStageGate / host deadends. */
  errors: string[];
};

/**
 * Fixed template injected into Main context on stage attempt > 1 after L0 fail.
 */
export function formatL0RepairBrief(input: L0RepairBriefInput): string {
  const errors = (input.errors || [])
    .map((e) => String(e || "").trim())
    .filter(Boolean);
  const lines = [
    "### L0 stage settlement repair brief (host; NC-Honesty-Advance)",
    `stage_id: ${String(input.stageId || "").trim() || "unknown"}`,
    `prior_failed_attempt: ${Math.max(1, Math.floor(input.failedAttempt || 1))}`,
    "cannot_advance: true",
    "This stage attempt must not pass until hard signals are cleared.",
    "Main duties (M1): fix illegal L2 declaration | honest deadend/fail failed packages (keep successes) | re-dispatch same package with new instructions | abandon package + new strategy package | drive running packages to a real terminal.",
    "Forbidden: ignore this brief and silent-green L2 over failed/unfinished packages.",
    "L1 Critic will not run until stage L0 (honesty + structure) passes.",
    "hard_signals:",
  ];
  if (!errors.length) {
    lines.push("- (none listed — re-check package terminals and structure require)");
  } else {
    for (const e of errors) {
      lines.push(`- ${e}`);
    }
  }
  return lines.join("\n");
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
