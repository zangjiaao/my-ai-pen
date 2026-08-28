/**
 * Host-style parent status for Tasks: children decide the parent icon.
 * Graph L1 stages keep runner status (Feedback can still be in flight after L2 is done).
 */

export type ParentPlanDisplayStatus =
  | "running"
  | "done"
  | "failed"
  | "blocked"
  | "skipped"
  | "pending"
  | "partial";

export function isTerminalChildPlanStatus(status: string | undefined): boolean {
  const s = String(status || "").trim().toLowerCase();
  return s === "done" || s === "completed" || s === "skipped" || s === "failed" || s === "blocked";
}

function isRunningChildPlanStatus(status: string | undefined): boolean {
  const s = String(status || "").trim().toLowerCase();
  return s === "running" || s === "in_progress" || s === "active";
}

/** True for Expert Graph L1 rows — do not roll up from L2 checklist. */
export function isGraphStagePlanNode(node: { node_id?: string; id?: string } | null | undefined): boolean {
  const id = String(node?.node_id || node?.id || "").trim();
  return id.startsWith("graph-stage-");
}

/**
 * Derive parent row status.
 * - Graph stage: ownStatus (runner).
 * - No children: ownStatus.
 * - All children terminal: done (failed if any failed/blocked).
 * - Some terminal, some open: partial (half-circle).
 * - Else running / pending from children.
 */
export function deriveParentPlanStatus(input: {
  children: ReadonlyArray<{ status?: string }>;
  ownStatus?: string;
  graphStage?: boolean;
}): ParentPlanDisplayStatus {
  const own = normalizeOwn(input.ownStatus);
  if (input.graphStage) return own;
  const children = input.children || [];
  if (!children.length) return own;

  const allTerminal = children.every((c) => isTerminalChildPlanStatus(c.status));
  if (allTerminal) {
    if (children.some((c) => {
      const s = String(c.status || "").trim().toLowerCase();
      return s === "failed" || s === "blocked";
    })) {
      return "failed";
    }
    return "done";
  }
  if (children.some((c) => isTerminalChildPlanStatus(c.status))) return "partial";
  if (children.some((c) => isRunningChildPlanStatus(c.status))) return "running";
  return "pending";
}

function normalizeOwn(status: string | undefined): ParentPlanDisplayStatus {
  const s = String(status || "pending").trim().toLowerCase();
  if (s === "completed" || s === "complete" || s === "done") return "done";
  if (s === "running" || s === "in_progress" || s === "active") return "running";
  if (s === "failed" || s === "error" || s === "crashed") return "failed";
  if (s === "blocked") return "blocked";
  if (s === "skipped") return "skipped";
  if (s === "partial") return "partial";
  return "pending";
}
