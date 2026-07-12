/**
 * Continue / settlement policy — OMP essence (clean-room).
 *
 * Discovery belongs **in-loop** (pi agent-loop keeps tool-calling until the
 * model emits no tools). Outer continues are **rare recovery** only:
 * empty-stop glitches, one booking gap, and a small open-work premature
 * budget. No session wall. No empty thrash as a score engine.
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
 *
 * Policy:
 * - abort → end
 * - bookingGap once → booking_gap_continue
 * - tools==0 → limited empty-stop retries
 * - tools>0 then stop → premature only while budget remains AND open work
 *   remains (open todos/goals), except one free recovery push (prematureUsed===0)
 *   so a single early “I am done” after tools is not fatal
 * - else natural_stop_after_tools
 */
export function shouldContinueAfterNaturalStop(options: {
  aborted: boolean;
  toolsInLastSegment: number;
  /** Consecutive empty stops **before** this segment (runner must not pre-increment). */
  emptyStopStreak: number;
  continueCount: number;
  maxContinues: number;
  maxEmptyStopStreak: number;
  bookingGap?: boolean;
  bookingContinueUsed?: boolean;
  prematureStopCount?: number;
  /** Max premature continues; default 0 in pure unit tests. */
  maxPrematureStops?: number;
  /**
   * Generic open work (open todos or open goals). Further premature pushes after
   * the first recovery require this so continue is not a blind score padder.
   */
  openWorkRemaining?: boolean;
}): ContinueDecision {
  if (options.aborted) {
    return { continue: false, reason: "aborted", nextContinueCount: options.continueCount };
  }
  if (options.continueCount >= options.maxContinues) {
    return { continue: false, reason: "max_continues", nextContinueCount: options.continueCount };
  }

  const empty = options.toolsInLastSegment === 0;
  const emptyStreak = empty ? options.emptyStopStreak + 1 : 0;

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

  // Tools ran then stop: rare premature recovery, not empty thrash.
  const prematureUsed = Math.max(0, options.prematureStopCount ?? 0);
  const maxPremature = Math.max(0, options.maxPrematureStops ?? 0);
  const openWork = Boolean(options.openWorkRemaining);
  // First tools-then-stop always eligible once (recovery). Later pushes need open work.
  const allowPremature =
    prematureUsed < maxPremature && (prematureUsed === 0 || openWork);
  if (allowPremature) {
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
  openWorkRemaining?: boolean;
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
    openWorkRemaining: options.openWorkRemaining,
  });
  return {
    ...decision,
    nextEmptyStopStreak: nextEmptyStopStreak(options.toolsInLastSegment, options.previousEmptyStopStreak),
  };
}

/**
 * Harness-owned terminal status after the loop ends.
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
    `You stopped without tool calls. Resume with high-density shell (multi-step curl|python in ONE call; multiple independent shell calls in the same turn).`,
    `Do NOT spam single-request http for multi-step chains — use shell.`,
    `If you already proved issues, book them with finding(confirm)+evidence_ids (batch ok).`,
    `There is no finish tool. When truly stuck after dense shell work, stop with no tools.`,
    `Empty-stop retry ${attempt}/${max}.`,
    `</system-injection>`,
  ].join("\n");
}

export function bookingGapContinuePrompt(): string {
  return [
    `<system-injection>`,
    `You produced tool evidence but have not booked product findings yet.`,
    `Call finding(action=confirm) with evidence_ids for each proven flag / challenge unlock / vuln now (batch multiple confirms ok).`,
    `Then continue dense shell if open work remains, or stop if stuck — do not pad idle time. No finish tool.`,
    `</system-injection>`,
  ].join("\n");
}

/**
 * Limited recovery push — shell-first, in-loop density, no answer keys.
 */
export function prematureStopContinuePrompt(attempt: number, max: number): string {
  return [
    `<system-injection>`,
    `Recovery push ${attempt}/${max} (OMP-style rare continue — discovery should mostly stay in-loop).`,
    `Do another high-density SHELL burst (not a stream of single http calls): multi-step pipelines, cookie jars, python parse, parallel independent shell calls in the same turn.`,
    `Rotate unexplored categories from YOUR own recon (auth, injection, access control, files, XSS, misconfig, business logic). Do not invent target answer keys.`,
    `Do not stop solely because remaining work "might need SPA" — try API/static JS first; drive headless browser via shell only if available.`,
    `Keep coarse todo categories open until approaches in that category are exhausted. Book proven issues with finding(confirm)+evidence_ids.`,
    `If truly stuck after this shell push, stop with no tools. There is no finish tool.`,
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
