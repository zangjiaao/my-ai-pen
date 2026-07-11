/**
 * Terminal settlement helpers. Agent status/finish tools are non-terminal.
 * Only the harness runner emits task_complete after loop exit.
 */

export type AgentStatusNote = {
  /** Non-terminal progress label from agent. */
  kind: "progress" | "blocked" | "summary";
  summary: string;
  calledAt: string;
  toolCallId?: string;
  confirmedFindings?: string[];
  findingsDedupedCount?: number;
  evidenceIds?: string[];
};

/** @deprecated Use AgentStatusNote — kept for older call sites. */
export type FinishSettlementRecord = {
  status?: string;
  summary?: string;
  confirmedFindings?: string[];
  findingsDedupedCount?: number;
};

/**
 * Agent "finish_scan" / status must NOT settle the task loop.
 * Always non-terminal from the agent tool's perspective.
 */
export function agentStatusIsTerminal(_note: AgentStatusNote | FinishSettlementRecord | null | undefined): boolean {
  return false;
}

export function finishScanSettlesTask(
  _finishScan: FinishSettlementRecord | null | undefined,
): { settled: boolean; canComplete: boolean; summary: string } {
  // Agent finish no longer settles the run.
  return {
    settled: false,
    canComplete: false,
    summary: "agent status/finish is non-terminal; harness settles after loop exit",
  };
}

/**
 * Whether agent can force task_complete=completed by calling finish with findings.
 * Always false under booking-without-finish-stop policy.
 */
export function agentCanForceCompletedViaFinish(): boolean {
  return false;
}

export function resolveTerminalTaskStatus(options: {
  gateCanComplete?: boolean;
  finishStatus?: string;
  /** Preferred: harness-computed status after loop. */
  harnessStatus?: "completed" | "incomplete" | "blocked";
}): "completed" | "incomplete" | "blocked" {
  if (options.harnessStatus) return options.harnessStatus;
  // Ignore agent finishStatus for completed — never honor agent-driven complete.
  const finish = String(options.finishStatus || "").toLowerCase();
  if (finish === "blocked") return "blocked";
  // Map legacy agent "completed" to incomplete unless harness says otherwise — harness should set harnessStatus.
  if (finish === "incomplete") return "incomplete";
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
