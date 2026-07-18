/**
 * Continue / settlement policy — OMP essence (clean-room).
 *
 * Discovery belongs **in-loop** (pi agent-loop keeps tool-calling until the
 * model emits no tools). Outer continues are **rare recovery** only:
 * empty-stop glitches, one booking gap, and a small open-work premature
 * budget. No session wall. No empty thrash as a score engine.
 */

import { midRunBookingNudge, type BookingSnapshot } from "./booking-harness.js";
import { incompleteTodoStopReminder, midRunTodoNudge, todoErrorReminder } from "./todo-harness.js";

export type ContinueDecision = {
  continue: boolean;
  reason: string;
  nextContinueCount: number;
  /** Hint for prompt composition */
  kind?: "empty" | "booking_gap" | "premature" | "goal";
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
 * - tools>0 then stop → if OMP goal mode active → goal_continuation (until complete/cap)
 * - else premature while budget remains (breadth recovery — not gated on open todos)
 * - else natural_stop_after_tools
 *
 * Lab evidence: agents often mark all todos done before finishing recon surfaces.
 * Gating premature on openWork caused early natural_stop after the first free push.
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
   * Soft open work (open todos). Kept for prompts/telemetry; no longer required
   * for premature breadth continues (see discovery-breadth policy).
   */
  openWorkRemaining?: boolean;
  /**
   * OMP-style goal mode still active (status=active). Takes priority over premature
   * for long-task continuation after tools (and after empty once recovered).
   */
  goalModeActive?: boolean;
  /** How many goal-continuation injects already used this run. */
  goalContinueCount?: number;
  /** Cap goal continuations (prevents infinite open-ended goals). Default 0 = off in pure tests. */
  maxGoalContinues?: number;
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
      // Empty streak exhausted: if goal still active, one more path via goal continue.
      const goalUsed = Math.max(0, options.goalContinueCount ?? 0);
      const maxGoal = Math.max(0, options.maxGoalContinues ?? 0);
      if (options.goalModeActive && goalUsed < maxGoal) {
        return {
          continue: true,
          reason: "goal_continuation",
          nextContinueCount: options.continueCount + 1,
          kind: "goal",
        };
      }
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

  // Tools ran then stop: OMP goal mode continues while active (long-task).
  const goalUsed = Math.max(0, options.goalContinueCount ?? 0);
  const maxGoal = Math.max(0, options.maxGoalContinues ?? 0);
  if (options.goalModeActive && goalUsed < maxGoal) {
    return {
      continue: true,
      reason: "goal_continuation",
      nextContinueCount: options.continueCount + 1,
      kind: "goal",
    };
  }

  // Breadth recovery when not in goal mode (or goal exhausted).
  // Cap only — do not require open todos (map-complete ≠ surface complete).
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
  openWorkRemaining?: boolean;
  goalModeActive?: boolean;
  goalContinueCount?: number;
  maxGoalContinues?: number;
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
    goalModeActive: options.goalModeActive,
    goalContinueCount: options.goalContinueCount,
    maxGoalContinues: options.maxGoalContinues,
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
 * Emphasizes breadth: todo map complete is not coverage of recon surfaces.
 */
export function prematureStopContinuePrompt(attempt: number, max: number): string {
  return [
    `<system-injection>`,
    `Breadth recovery push ${attempt}/${max} (rare outer continue — prefer keeping tool-calling in-loop).`,
    `Do another high-density SHELL burst (not a stream of single http calls): multi-step pipelines, cookie jars, python parse, parallel independent shell calls in the same turn.`,
    `CRITICAL: Completing the todo map is NOT the same as finishing discovery. Re-read YOUR recon notes/facts — if modules, params, or flows were listed but not yet probed with act tools, test them now.`,
    `Prefer write scripts/ under the task dir for multi-module apps (enumerate + probe), then shell them — not only one-off curls.`,
    `Rotate unexplored categories from YOUR own recon (auth, session, injection, access control, files, XSS variants, CSRF, misconfig, business logic). Do not invent target answer keys or fixed vuln lists.`,
    `Skill: if stuck on a class, load ONE different skill matching an untested observed surface (still at most one body loaded at a time).`,
    `Do not stop solely because remaining work "might need SPA" — try API/static JS first; drive headless browser via shell only if available.`,
    `Only mark a todo category done when you acted on it or recorded an explicit deadend note. Book proven issues with finding(confirm)+proof (quote real tool output).`,
    `If truly stuck after dense work on remaining recon surfaces, stop with no tools. There is no finish tool.`,
    `</system-injection>`,
  ].join("\n");
}

/** When todos are empty on a premature continue — still push untested recon surfaces. */
export function discoveryBreadthReminder(): string {
  return [
    `<system-reminder>`,
    `Todo map shows no open items — that does not mean every recon surface was tested.`,
    `From your own notes/facts/session history: list untested modules or param families and probe them in this turn, or stop only if none remain.`,
    `Do not invent modules that never appeared in recon.`,
    `</system-reminder>`,
  ].join("\n");
}

/** Compose continue text — kind selects empty / booking-gap / premature / goal body. */
export function composeContinuePrompt(options: {
  attempt: number;
  max: number;
  openTodoCount: number;
  /** Optional open task titles for OMP incomplete-stop reminder. */
  openTodoTitles?: string[];
  todoErrors?: string[];
  booking?: BookingSnapshot;
  goalSummary?: string;
  kind?: "empty" | "booking_gap" | "premature" | "goal";
  prematureAttempt?: number;
  prematureMax?: number;
  /** When kind=goal, full goal continuation body (from GoalStore). */
  goalContinuationBody?: string;
}): string {
  const body =
    options.kind === "booking_gap"
      ? bookingGapContinuePrompt()
      : options.kind === "goal"
        ? options.goalContinuationBody ||
          prematureStopContinuePrompt(options.attempt, options.max)
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
  // OMP: empty/premature stops with open todos get an incomplete-list reminder;
  // other continues keep the gentle mid-run reconcile nudge.
  if (options.openTodoCount > 0) {
    if (options.kind === "empty" || options.kind === "premature") {
      parts.push(
        incompleteTodoStopReminder(
          options.openTodoCount,
          options.openTodoTitles || [],
          options.attempt,
          options.max,
        ),
      );
    } else {
      parts.push(midRunTodoNudge(options.openTodoCount));
    }
  } else if (options.kind === "premature") {
    // Map-complete false finish: still steer toward untested recon surfaces.
    parts.push(discoveryBreadthReminder());
  }
  if (options.booking) {
    const bookingNudge = midRunBookingNudge(options.booking);
    if (bookingNudge) parts.push(bookingNudge);
  }
  return parts.join("\n\n");
}
