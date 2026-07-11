/**
 * Harness v2: once finish_scan accepts a terminal status, session completion
 * must not re-litigate conversion gates and force incomplete.
 * Pure helpers for finish tool + session-runner (smokes drive these).
 */

export type FinishSettlementStatus = "completed" | "incomplete" | "blocked";

export type FinishSettlementRecord = {
  status: FinishSettlementStatus | string;
  confirmedFindings?: string[];
  findingsDedupedCount?: number;
  summary?: string;
};

/** Terminal finish_scan outcomes that settle the task lifecycle. */
export function isTerminalFinishSettlement(status: string | undefined): boolean {
  return status === "completed" || status === "incomplete" || status === "blocked";
}

/**
 * Whether session-runner may treat the task as settled after finish_scan.
 * completed/incomplete/blocked from the tool are final — do not re-apply
 * coverage conversion gates that the tool already handled (or waived with findings).
 */
export function finishScanSettlesTask(finishScan: FinishSettlementRecord | undefined | null): {
  settled: boolean;
  canComplete: boolean;
  summary: string;
} {
  if (!finishScan) {
    return { settled: false, canComplete: false, summary: "finish_scan has not been called" };
  }
  const status = String(finishScan.status || "").toLowerCase();
  if (status === "incomplete" || status === "blocked") {
    return {
      settled: true,
      canComplete: true,
      summary: `finish_scan settled as ${status} (terminal incomplete lifecycle)`,
    };
  }
  if (status === "completed") {
    const findings =
      Number(finishScan.findingsDedupedCount || 0) ||
      (Array.isArray(finishScan.confirmedFindings) ? finishScan.confirmedFindings.length : 0);
    return {
      settled: true,
      canComplete: true,
      summary:
        findings > 0
          ? `finish_scan completed with ${findings} authoritative finding(s)`
          : "finish_scan completed (accepted by tool; evidence-oriented)",
    };
  }
  return {
    settled: false,
    canComplete: false,
    summary: `finish_scan requested ${finishScan.status}`,
  };
}

/**
 * Platform task_complete status from gate + finish_scan.
 * Never demote an accepted finish_scan(completed) to incomplete.
 */
export function resolveTerminalTaskStatus(options: {
  gateCanComplete: boolean;
  finishStatus?: string;
}): "completed" | "incomplete" | "blocked" {
  const finish = String(options.finishStatus || "").toLowerCase();
  if (finish === "blocked") return "blocked";
  if (finish === "completed") return "completed";
  if (finish === "incomplete") return "incomplete";
  if (options.gateCanComplete) return "completed";
  return "incomplete";
}

/**
 * Evidence-oriented completed allowance shared with finish tool semantics:
 * disk-confirmed findings waive remaining assess conversion gaps.
 */
export function allowCompletedDespiteCoverageGaps(options: {
  eligibilityAllowed: boolean;
  confirmedFindingCount: number;
}): boolean {
  if (options.eligibilityAllowed) return true;
  return options.confirmedFindingCount > 0;
}
