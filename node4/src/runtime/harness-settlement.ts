/**
 * Terminal settlement is harness-owned only.
 * There is no agent finish/status tool that can end the run or force completed.
 */

export function agentCanForceCompleted(): boolean {
  return false;
}

export function resolveTerminalTaskStatus(options: {
  harnessStatus?: "completed" | "incomplete" | "blocked";
  gateCanComplete?: boolean;
}): "completed" | "incomplete" | "blocked" {
  if (options.harnessStatus) return options.harnessStatus;
  if (options.gateCanComplete) return "completed";
  return "incomplete";
}

export function allowCompletedDespiteCoverageGaps(options: {
  eligibilityAllowed: boolean;
  confirmedFindingCount: number;
}): boolean {
  if (options.eligibilityAllowed) return true;
  return options.confirmedFindingCount > 0;
}
