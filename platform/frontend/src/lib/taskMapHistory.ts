/**
 * Spec #321 — Task Map history types + pure helpers for RightPanel.
 * Product-state owns revisions; FE only selects a view (history is read-only).
 */

import type { PlanNode } from "./panelTypes";

export type TaskMapWorkMode = "free" | "graph";

export type TaskMapRevision = {
  id: string;
  label?: string;
  work_mode?: TaskMapWorkMode | string;
  is_live?: boolean;
  sealed?: boolean;
  sealed_at?: string | null;
  archived_at?: string | null;
  title?: string | null;
  graph_id?: string | null;
  done?: number;
  total?: number;
  open?: number;
  plan_tree?: PlanNode[];
  owner_expert_id?: string;
  owner_expert_name?: string;
};

export function isLiveRevision(
  rev: TaskMapRevision | undefined,
  liveRevisionId: string | null | undefined,
): boolean {
  if (!rev) return false;
  // Case live_revision_id is canonical when present (multi-role may leave stale is_live flags).
  if (liveRevisionId) return rev.id === liveRevisionId;
  return rev.is_live === true;
}

/**
 * Spec #321 S3 selection policy:
 * - If operator was intentionally viewing history, keep that selection when still present.
 * - If operator was on live (or unset), follow the new live after archive-then-switch.
 * - If previous history id vanished, fall back to live.
 */
export function nextViewedRevisionId(opts: {
  prevViewedId: string | null;
  prevLiveId: string | null;
  nextLiveId: string | null;
  revisions: TaskMapRevision[];
}): string | null {
  const { prevViewedId, prevLiveId, nextLiveId, revisions } = opts;
  const ids = new Set(revisions.map((r) => r.id));
  const wasViewingHistory = Boolean(
    prevViewedId && prevLiveId && prevViewedId !== prevLiveId,
  );
  if (wasViewingHistory && prevViewedId && ids.has(prevViewedId)) {
    return prevViewedId;
  }
  if (nextLiveId && ids.has(nextLiveId)) return nextLiveId;
  return nextLiveId || prevViewedId || null;
}

/** Normalize product-state / WS payload into revision list. */
export function normalizeTaskMapRevisions(raw: unknown): TaskMapRevision[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskMapRevision[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = String(r.id || "").trim();
    if (!id) continue;
    const plan_tree = Array.isArray(r.plan_tree) ? (r.plan_tree as PlanNode[]) : [];
    out.push({
      id,
      label: r.label != null ? String(r.label) : undefined,
      work_mode: r.work_mode != null ? String(r.work_mode) : undefined,
      is_live: r.is_live === true,
      sealed: r.sealed === true,
      sealed_at: r.sealed_at != null ? String(r.sealed_at) : null,
      archived_at: r.archived_at != null ? String(r.archived_at) : null,
      title: r.title != null ? String(r.title) : null,
      graph_id: r.graph_id != null ? String(r.graph_id) : null,
      done: typeof r.done === "number" ? r.done : undefined,
      total: typeof r.total === "number" ? r.total : undefined,
      open: typeof r.open === "number" ? r.open : undefined,
      plan_tree,
      owner_expert_id: r.owner_expert_id != null ? String(r.owner_expert_id) : undefined,
      owner_expert_name: r.owner_expert_name != null ? String(r.owner_expert_name) : undefined,
    });
  }
  return out;
}

export function revisionDisplayLabel(rev: TaskMapRevision): string {
  const label = String(rev.label || "").trim();
  if (label) return label;
  const mode =
    rev.work_mode === "graph" || String(rev.work_mode || "").startsWith("hard_graph")
      ? "Graph"
      : "Free";
  const total = typeof rev.total === "number" ? rev.total : rev.plan_tree?.length || 0;
  const done =
    typeof rev.done === "number"
      ? rev.done
      : (rev.plan_tree || []).filter((n) => {
          const s = String(n.status || "").toLowerCase();
          return s === "done" || s === "skipped" || s === "failed" || s === "blocked";
        }).length;
  const counts = total > 0 ? `${done}/${total}` : "";
  const liveTag = rev.is_live ? "当前" : "历史";
  return [mode, liveTag, counts].filter(Boolean).join(" · ");
}

/**
 * Plan tree to show in Tasks for the current FE selection.
 * History selection uses the frozen revision payload; live uses the live planTree.
 */
export function planTreeForView(opts: {
  planTree: PlanNode[];
  revisions: TaskMapRevision[];
  liveRevisionId: string | null;
  viewedRevisionId: string | null;
}): PlanNode[] {
  const { planTree, revisions, liveRevisionId, viewedRevisionId } = opts;
  if (!viewedRevisionId || !liveRevisionId || viewedRevisionId === liveRevisionId) {
    return planTree;
  }
  const rev = revisions.find((r) => r.id === viewedRevisionId);
  // History: always use frozen payload when id is not the Case live id.
  if (!rev || rev.id === liveRevisionId) return planTree;
  return Array.isArray(rev.plan_tree) ? rev.plan_tree : planTree;
}

export function isViewingHistory(
  viewedRevisionId: string | null,
  liveRevisionId: string | null,
): boolean {
  return Boolean(viewedRevisionId && liveRevisionId && viewedRevisionId !== liveRevisionId);
}
