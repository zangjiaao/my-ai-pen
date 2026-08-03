/**
 * Spec #281: Graph Todo is current-stage L2 only.
 * Reject Free-style whole-engagement multi-phase todo(init) on Expert Graph.
 */

export type TodoInitPhaseInput = { phase: string; items: string[] };

/** Normalize for alias compare: lower + keep a-z0-9 and CJK; drop punctuation/space. */
export function normalizePhaseLabel(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

/**
 * Phase name is a real alias of the current host stage id (init/surface/…).
 *
 * Wave1 (tight): exact normalize equality, OR phase is stage slug with optional
 * suffix only (e.g. `init-checklist` → `initchecklist` starts with `init`).
 * Rejects bidirectional substring matches (e.g. stage fragment inside an
 * unrelated name like `minit` / mid-string hits) so multi-phase maps cannot
 * slip through as "all aliases".
 *
 * Single-phase free labels are accepted at the whole-engagement check layer
 * (`phases.length <= 1`), not here.
 */
export function phaseMatchesGraphStage(phaseName: string, stageId: string): boolean {
  const p = normalizePhaseLabel(phaseName);
  const s = normalizePhaseLabel(stageId);
  if (!p || !s) return false;
  if (p === s) return true;
  // stage + optional suffix material only (init-checklist, Init Stage → initstage)
  if (p.startsWith(s) && p.length > s.length) return true;
  return false;
}

/**
 * True when init list looks like a Free whole-engagement map on Graph
 * (multiple phases not all tied to current stageId).
 *
 * Single phase (any label, including empty free label after trim failure) is
 * always stage-local for Wave1 — agent may name the phase freely for one checklist.
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
