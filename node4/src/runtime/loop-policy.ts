/**
 * Continue / settlement policy — OMP-aligned.
 *
 * No session wall/max-time. End via natural stop, limited continues, or cancel.
 * After tools then stop: small premature-stop budget, then natural end.
 * Empty-stop glitches and one booking-gap continue remain limited.
 */

import { midRunBookingNudge, type BookingSnapshot } from "./booking-harness.js";
import { midRunTodoNudge, todoErrorReminder } from "./todo-harness.js";

export type ContinueDecision = {
  continue: boolean;
  reason: string;
  nextContinueCount: number;
  /** Hint for prompt composition */
  kind?: "empty" | "booking_gap" | "premature";
};

/**
 * After session.prompt returns (natural model stop or abort), decide whether to
 * inject another user message.
 *
 * `emptyStopStreak` is the streak **before** this segment (do not pre-increment).
 * This function applies +1 for the current empty segment once.
 *
 * Policy:
 * - platform/user abort always ends
 * - evidence without findings → at most **one** booking_gap continue
 * - tools == 0 → limited empty-stop retries
 * - tools > 0 then stop → up to maxPrematureStops exploration pushes, then
 *   natural_stop_after_tools
 */
export function shouldContinueAfterNaturalStop(options: {
  aborted: boolean;
  toolsInLastSegment: number;
  /** Consecutive empty stops **before** this segment (runner must not pre-increment). */
  emptyStopStreak: number;
  continueCount: number;
  maxContinues: number;
  maxEmptyStopStreak: number;
  /** True when pack books findings and evidence exists but bookedFindingCount===0 (or strong lag). */
  bookingGap?: boolean;
  /** Already used the single booking-gap continue this run. */
  bookingContinueUsed?: boolean;
  /**
   * How many premature-stop continues already used this run.
   * Pure default 0; runner supplies live count.
   */
  prematureStopCount?: number;
  /**
   * Max tools-then-stop exploration continues before natural end.
   * Default **0** (pure natural stop) so unit tests stay strict; runner sets >0.
   */
  maxPrematureStops?: number;
}): ContinueDecision {
  if (options.aborted) {
    return { continue: false, reason: "aborted", nextContinueCount: options.continueCount };
  }
  if (options.continueCount >= options.maxContinues) {
    return { continue: false, reason: "max_continues", nextContinueCount: options.continueCount };
  }

  const empty = options.toolsInLastSegment === 0;
  // Count this empty segment once (runner must pass previous streak only).
  const emptyStreak = empty ? options.emptyStopStreak + 1 : 0;

  // One-shot: evidence without product booking (not a wall-padding loop).
  if (options.bookingGap && !options.bookingContinueUsed) {
    return {
      continue: true,
      reason: "booking_gap_continue",
      nextContinueCount: options.continueCount + 1,
      kind: "booking_gap",
    };
  }

  if (empty) {
    if (emptyStreak > options.maxEmptyStopStreak) {
      return {
        continue: false,
        reason: "max_empty_stops",
        nextContinueCount: options.continueCount,
      };
    }
    return {
      continue: true,
      reason: "empty_stop_continue",
      nextContinueCount: options.continueCount + 1,
      kind: "empty",
    };
  }

  // Tools ran then stop: limited premature pushes before natural end.
  const prematureUsed = Math.max(0, options.prematureStopCount ?? 0);
  const maxPremature = Math.max(0, options.maxPrematureStops ?? 0);
  if (prematureUsed < maxPremature) {
    return {
      continue: true,
      reason: "premature_stop_continue",
      nextContinueCount: options.continueCount + 1,
      kind: "premature",
    };
  }

  return {
    continue: false,
    reason: "natural_stop_after_tools",
    nextContinueCount: options.continueCount,
  };
}

/** Streak after evaluating this segment (0 if tools ran). */
export function nextEmptyStopStreak(toolsInLastSegment: number, previousStreak: number): number {
  return toolsInLastSegment === 0 ? previousStreak + 1 : 0;
}

/**
 * Runner wiring helper: decide continue using **previous** empty streak, then
 * return the updated streak. Prevents double-increment bugs in session-runner.
 */
export function evaluateContinueAfterSegment(options: {
  aborted: boolean;
  toolsInLastSegment: number;
  previousEmptyStopStreak: number;
  continueCount: number;
  maxContinues: number;
  maxEmptyStopStreak: number;
  bookingGap?: boolean;
  bookingContinueUsed?: boolean;
  prematureStopCount?: number;
  maxPrematureStops?: number;
}): ContinueDecision & { nextEmptyStopStreak: number } {
  const decision = shouldContinueAfterNaturalStop({
    aborted: options.aborted,
    toolsInLastSegment: options.toolsInLastSegment,
    emptyStopStreak: options.previousEmptyStopStreak,
    continueCount: options.continueCount,
    maxContinues: options.maxContinues,
    maxEmptyStopStreak: options.maxEmptyStopStreak,
    bookingGap: options.bookingGap,
    bookingContinueUsed: options.bookingContinueUsed,
    prematureStopCount: options.prematureStopCount,
    maxPrematureStops: options.maxPrematureStops,
  });
  return {
    ...decision,
    nextEmptyStopStreak: nextEmptyStopStreak(options.toolsInLastSegment, options.previousEmptyStopStreak),
  };
}

/**
 * Harness-owned terminal status after the loop ends.
 * natural_stop_after_tools with findings → completed (work happened, agent chose to stop).
 */
export function resolveHarnessTerminalStatus(options: {
  bookedFindingCount: number;
  aborted: boolean;
  stopReason: string;
}): "completed" | "incomplete" | "blocked" {
  if (options.aborted && options.bookedFindingCount === 0) return "incomplete";
  if (options.bookedFindingCount > 0 && !options.aborted) return "completed";
  return "incomplete";
}

export function emptyStopContinuePrompt(attempt: number, max: number): string {
  return [
    `<system-injection>`,
    `You stopped without tool calls. If the engagement is still open, continue with high-density shell (multi-step curl|python in one call; multiple tool calls in the same turn when independent).`,
    `If you already proved issues, book them with finding(confirm)+evidence_ids (batch ok after a shell burst).`,
    `There is no finish tool. When you are done working, simply stop with no more tools — the harness will settle.`,
    `Empty-stop retry ${attempt}/${max}.`,
    `</system-injection>`,
  ].join("\n");
}

export function bookingGapContinuePrompt(): string {
  return [
    `<system-injection>`,
    `You produced tool evidence but have not booked product findings yet.`,
    `Call finding(action=confirm) with evidence_ids for each proven flag / challenge unlock / vuln now (batch multiple confirms ok).`,
    `Then stop if the engagement work is complete — do not pad time. There is no finish tool.`,
    `</system-injection>`,
  ].join("\n");
}

/**
 * Limited exploration push after tools-then-stop.
 * Generic (no target answer keys): another dense shell/API burst on unexplored classes.
 */
export function prematureStopContinuePrompt(attempt: number, max: number): string {
  return [
    `<system-injection>`,
    `You stopped after tool work, but the harness is giving a limited exploration push (${attempt}/${max}).`,
    `Do another high-density shell/API burst on categories not yet proven or only weakly tested.`,
    `Prefer: auth/session/JWT, injection, IDOR/access control, file/path, XSS/HTML sinks, misconfig/exposed endpoints, business-logic edge cases.`,
    `Do not treat "might need SPA/browser" as terminal without trying: JS/static asset recon, API-only paths, cookie/session chaining, and headless browser via shell if available in the environment.`,
    `Book newly proven issues with finding(confirm)+evidence_ids (batch ok). If truly stuck after this push, stop with no tools — do not pad idle time.`,
    `There is no finish tool.`,
    `</system-injection>`,
  ].join("\n");
}

/** Compose continue text — kind selects empty / booking-gap / premature body. */
export function composeContinuePrompt(options: {
  attempt: number;
  max: number;
  openTodoCount: number;
  todoErrors?: string[];
  booking?: BookingSnapshot;
  goalSummary?: string;
  kind?: "empty" | "booking_gap" | "premature";
  /** For premature prompt attempt/max (defaults to attempt/max). */
  prematureAttempt?: number;
  prematureMax?: number;
}): string {
  const body =
    options.kind === "booking_gap"
      ? bookingGapContinuePrompt()
      : options.kind === "premature"
        ? prematureStopContinuePrompt(options.prematureAttempt ?? options.attempt, options.prematureMax ?? options.max)
        : emptyStopContinuePrompt(options.attempt, options.max);
  const parts = [body];
  if (options.goalSummary) {
    parts.push(`<system-reminder>\n${options.goalSummary}\n</system-reminder>`);
  }
  if (options.todoErrors?.length) {
    parts.push(todoErrorReminder(options.todoErrors));
  }
  if (options.openTodoCount > 0) {
    parts.push(midRunTodoNudge(options.openTodoCount));
  }
  if (options.booking) {
    const bookingNudge = midRunBookingNudge(options.booking);
    if (bookingNudge) parts.push(bookingNudge);
  }
  return parts.join("\n\n");
}
