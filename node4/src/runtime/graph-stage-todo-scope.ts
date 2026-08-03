/**
 * Spec #281: Graph Todo is current-stage L2 only.
 * Reject Free-style whole-engagement multi-phase todo(init) on Expert Graph.
 */

export type TodoInitPhaseInput = { phase: string; items: string[] };

function norm(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

/** Phase name is an alias of the current host stage id (init/surface/…). */
export function phaseMatchesGraphStage(phaseName: string, stageId: string): boolean {
  const p = norm(phaseName);
  const s = norm(stageId);
  if (!p || !s) return false;
  if (p === s) return true;
  // Allow light aliases: "init stage", "surface-enum", Chinese free labels only when single-phase
  // (multi-phase uses strict match / reject).
  if (p.includes(s) || s.includes(p)) return true;
  return false;
}

/**
 * True when init list looks like a Free whole-engagement map on Graph
 * (multiple phases not all tied to current stageId).
 */
export function isWholeEngagementTodoInitOnGraph(
  list: TodoInitPhaseInput[] | undefined,
  stageId: string,
): boolean {
  const phases = Array.isArray(list) ? list : [];
  if (phases.length <= 1) return false;
  const sid = String(stageId || "").trim();
  if (!sid) return false;
  return phases.some((ph) => !phaseMatchesGraphStage(ph.phase, sid));
}

export function graphStageLocalTodoInitError(stageId: string): string {
  const sid = String(stageId || "").trim() || "current";
  return [
    `error: Expert Graph todo(init) must be a checklist for the current stage only (stage=${sid}).`,
    "Do not init a whole-engagement multi-phase map (recon/auth/vuln/report…) under one stage.",
    "Call todo(init) with a single phase (or phases that all name this stage) and stage-local items.",
    "Full engagement maps belong in Free work mode.",
  ].join(" ");
}
