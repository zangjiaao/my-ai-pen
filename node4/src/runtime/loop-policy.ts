/**
 * Pure continue / terminal settlement policy for OMP-class Node4 runner.
 * Smokes call these same functions as session-runner.
 */

export type ContinueDecision = {
  continue: boolean;
  reason: string;
  nextContinueCount: number;
};

/**
 * After a natural agent stop (session.prompt returned), decide whether to inject
 * another continue prompt. Agent status/finish tools do NOT force stop.
 */
export function shouldContinueAfterNaturalStop(options: {
  timedOut: boolean;
  aborted: boolean;
  /** Tool calls observed during the last prompt segment. */
  toolsInLastSegment: number;
  /** Consecutive stops with zero tools (empty stops). */
  emptyStopStreak: number;
  /** Total continue prompts already injected this run. */
  continueCount: number;
  maxContinues: number;
  maxEmptyStopStreak: number;
  /** Agent explicitly requested blocked via status tool. */
  agentBlocked: boolean;
}): ContinueDecision {
  if (options.timedOut) {
    return { continue: false, reason: "wall_budget", nextContinueCount: options.continueCount };
  }
  if (options.aborted) {
    return { continue: false, reason: "aborted", nextContinueCount: options.continueCount };
  }
  if (options.agentBlocked) {
    return { continue: false, reason: "agent_blocked", nextContinueCount: options.continueCount };
  }
  if (options.continueCount >= options.maxContinues) {
    return { continue: false, reason: "max_continues", nextContinueCount: options.continueCount };
  }

  const emptyStreak =
    options.toolsInLastSegment === 0 ? options.emptyStopStreak + 1 : 0;

  // Premature stop: agent stopped after tools — still continue until cap (OMP-like don't early end).
  // Empty stop: also continue until empty streak cap.
  if (options.toolsInLastSegment === 0 && emptyStreak > options.maxEmptyStopStreak) {
    return {
      continue: false,
      reason: "max_empty_stops",
      nextContinueCount: options.continueCount,
    };
  }

  return {
    continue: true,
    reason: options.toolsInLastSegment === 0 ? "empty_stop_continue" : "premature_stop_continue",
    nextContinueCount: options.continueCount + 1,
  };
}

export function nextEmptyStopStreak(toolsInLastSegment: number, previousStreak: number): number {
  return toolsInLastSegment === 0 ? previousStreak + 1 : 0;
}

/**
 * Harness-owned terminal status after the loop ends.
 * Agent cannot force completed mid-loop via finish; settlement is here only.
 */
export function resolveHarnessTerminalStatus(options: {
  agentBlocked: boolean;
  bookedFindingCount: number;
  timedOut: boolean;
  aborted: boolean;
  stopReason: string;
}): "completed" | "incomplete" | "blocked" {
  if (options.agentBlocked) return "blocked";
  // Booked findings + natural/budget end → completed; findings alone during run do not stop the loop.
  if (options.bookedFindingCount > 0 && !options.aborted) return "completed";
  return "incomplete";
}

export function emptyStopContinuePrompt(attempt: number, max: number): string {
  return [
    `<system-injection>`,
    `You stopped without finishing the authorized engagement. Continue thorough testing.`,
    `Use shell/write/edit/http/script; book proven issues only via finding+evidence_ids.`,
    `Do not stop early because you already booked some findings. Chat prose is not product truth.`,
    `status tool notes progress only — it does not end the task.`,
    `Continue attempt ${attempt}/${max}.`,
    `</system-injection>`,
  ].join("\n");
}
