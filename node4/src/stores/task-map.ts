/**
 * Spec #321 — Task Map lifecycle (archive-then-switch, seal, revision list).
 *
 * Pure Session-scoped history: one live map + archived immutable snapshots.
 * Free and Graph share the same revision model; content is plan_tree-shaped.
 */

export type TaskMapWorkMode = "free" | "graph";

export type TaskMapItemCounts = {
  done: number;
  total: number;
  open: number;
};

/** Immutable revision entry for product-state / RightPanel history. */
export type TaskMapRevision = {
  id: string;
  label: string;
  work_mode: TaskMapWorkMode;
  /** Live revision occupies the panel; archived rows are history. */
  is_live: boolean;
  sealed: boolean;
  sealed_at: string | null;
  archived_at: string | null;
  title: string | null;
  graph_id: string | null;
  done: number;
  total: number;
  open: number;
  /** Frozen plan_tree sufficient to re-render Tasks (not a live alias). */
  plan_tree: unknown[];
};

export type TaskMapMeta = {
  work_mode: TaskMapWorkMode;
  title?: string | null;
  graph_id?: string | null;
};

export type TaskMapProjection = {
  task_map_revisions: TaskMapRevision[];
  live_revision_id: string | null;
  live_sealed: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function deepClonePlanTree(planTree: unknown[]): unknown[] {
  try {
    return JSON.parse(JSON.stringify(planTree ?? [])) as unknown[];
  } catch {
    return Array.isArray(planTree) ? planTree.map((n) => (n && typeof n === "object" ? { ...n } : n)) : [];
  }
}

/** Counts from plan_tree work_item nodes (user-visible Tasks rows). */
export function countsFromPlanTree(planTree: readonly unknown[]): TaskMapItemCounts {
  let total = 0;
  let done = 0;
  let open = 0;
  for (const raw of planTree || []) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as Record<string, unknown>;
    const level = String(node.level || "work_item");
    if (level !== "work_item") continue;
    total += 1;
    const status = String(node.status || "pending").toLowerCase();
    if (status === "done" || status === "skipped" || status === "failed" || status === "blocked") {
      done += 1;
    } else {
      open += 1;
    }
  }
  return { done, total, open };
}

/**
 * Seal predicate (Spec #321): every user-visible work item terminal.
 * Empty map is not sealed. Agent narrative alone never seals.
 *
 * Graph: when any L1 stage is failed/blocked and open L2 work_items remain,
 * refuse auto-seal (failed L1 must not sweep unfinished stage debt).
 */
/**
 * Seal when every user-visible work_item is terminal.
 * Failed/blocked L1 with residual open L2 is already covered by open>0 → no seal.
 * When L2 is all closed, failed L1 may still seal (debt was dropped/closed).
 */
export function shouldSealPlanTree(planTree: readonly unknown[]): boolean {
  const counts = countsFromPlanTree(planTree);
  return counts.total > 0 && counts.open === 0;
}

export function buildRevisionLabel(opts: {
  work_mode: TaskMapWorkMode;
  title?: string | null;
  done: number;
  total: number;
  at?: string | null;
}): string {
  const title = String(opts.title || "").trim();
  if (title) return title.slice(0, 80);
  const mode = opts.work_mode === "graph" ? "Graph" : "Free";
  const time = opts.at ? opts.at.slice(0, 16).replace("T", " ") : "";
  const counts = opts.total > 0 ? `${opts.done}/${opts.total}` : "0/0";
  return [mode, time, counts].filter(Boolean).join(" · ");
}

/**
 * Session-scoped Task Map history.
 * Mutations always target live; archive freezes a deep-cloned snapshot.
 */
export class TaskMapHistory {
  private liveId: string | null = null;
  private liveSealed = false;
  private liveSealedAt: string | null = null;
  private liveMeta: TaskMapMeta = { work_mode: "free" };
  private livePlanTree: unknown[] = [];
  private liveCounts: TaskMapItemCounts = { done: 0, total: 0, open: 0 };
  private archived: TaskMapRevision[] = [];
  private seq = 0;

  get liveRevisionId(): string | null {
    return this.liveId;
  }

  get isSealed(): boolean {
    return this.liveSealed;
  }

  /** True when no live map has ever been installed (brand-new Session). */
  get isEmpty(): boolean {
    return this.liveId === null && this.livePlanTree.length === 0 && this.archived.length === 0;
  }

  /** Live has user-visible content (open or closed). */
  hasLiveContent(): boolean {
    return this.liveCounts.total > 0 || this.livePlanTree.length > 0;
  }

  private nextId(): string {
    this.seq += 1;
    return `tm-${this.seq}-${Date.now().toString(36)}`;
  }

  private snapshotLiveAsArchived(archivedAt: string): TaskMapRevision {
    const id = this.liveId || this.nextId();
    const counts = this.liveCounts;
    return {
      id,
      label: buildRevisionLabel({
        work_mode: this.liveMeta.work_mode,
        title: this.liveMeta.title,
        done: counts.done,
        total: counts.total,
        at: this.liveSealedAt || archivedAt,
      }),
      work_mode: this.liveMeta.work_mode,
      is_live: false,
      sealed: this.liveSealed || shouldSealPlanTree(this.livePlanTree),
      sealed_at: this.liveSealedAt,
      archived_at: archivedAt,
      title: this.liveMeta.title ?? null,
      graph_id: this.liveMeta.graph_id ?? null,
      done: counts.done,
      total: counts.total,
      open: counts.open,
      plan_tree: deepClonePlanTree(this.livePlanTree),
    };
  }

  private liveAsRevision(): TaskMapRevision | null {
    if (!this.liveId) return null;
    const counts = this.liveCounts;
    return {
      id: this.liveId,
      label: buildRevisionLabel({
        work_mode: this.liveMeta.work_mode,
        title: this.liveMeta.title,
        done: counts.done,
        total: counts.total,
        at: this.liveSealedAt,
      }),
      work_mode: this.liveMeta.work_mode,
      is_live: true,
      sealed: this.liveSealed,
      sealed_at: this.liveSealedAt,
      archived_at: null,
      title: this.liveMeta.title ?? null,
      graph_id: this.liveMeta.graph_id ?? null,
      done: counts.done,
      total: counts.total,
      open: counts.open,
      plan_tree: deepClonePlanTree(this.livePlanTree),
    };
  }

  /**
   * Install first live map (empty Session first init) or replace empty live.
   * Does not archive.
   */
  installLive(planTree: unknown[], meta?: TaskMapMeta): string {
    const counts = countsFromPlanTree(planTree);
    const id = this.nextId();
    this.liveId = id;
    this.liveMeta = {
      work_mode: meta?.work_mode || this.liveMeta.work_mode || "free",
      title: meta?.title ?? null,
      graph_id: meta?.graph_id ?? null,
    };
    this.livePlanTree = deepClonePlanTree(planTree);
    this.liveCounts = counts;
    this.liveSealed = shouldSealPlanTree(this.livePlanTree);
    this.liveSealedAt = this.liveSealed ? nowIso() : null;
    return id;
  }

  /**
   * Archive current live (if it has content) then install a new live revision.
   * Used by E2 (sealed+init), E3 (granted replace), E4 (restart Graph).
   */
  archiveThenInstall(planTree: unknown[], meta?: TaskMapMeta): string {
    if (this.liveId && this.hasLiveContent()) {
      const at = nowIso();
      this.archived.push(this.snapshotLiveAsArchived(at));
    }
    return this.installLive(planTree, meta);
  }

  /**
   * E5: mutate live only — stage advance, continue, append/done/drop.
   * E1: may seal when all terminal. Open items unseal.
   * Does not mint a history row.
   */
  mutateLive(planTree: unknown[], meta?: Partial<TaskMapMeta>): void {
    if (!this.liveId) {
      this.installLive(planTree, {
        work_mode: meta?.work_mode || "free",
        title: meta?.title,
        graph_id: meta?.graph_id,
      });
      return;
    }
    if (meta?.work_mode) this.liveMeta.work_mode = meta.work_mode;
    if (meta?.title !== undefined) this.liveMeta.title = meta.title;
    if (meta?.graph_id !== undefined) this.liveMeta.graph_id = meta.graph_id;
    this.livePlanTree = deepClonePlanTree(planTree);
    this.liveCounts = countsFromPlanTree(this.livePlanTree);
    const seal = shouldSealPlanTree(this.livePlanTree);
    if (seal) {
      if (!this.liveSealed) {
        this.liveSealed = true;
        this.liveSealedAt = nowIso();
      }
    } else {
      this.liveSealed = false;
      this.liveSealedAt = null;
    }
  }

  /**
   * E4 / explicit restart: archive current and start empty-ready live shell,
   * or install provided plan tree as the new live map.
   */
  archiveForRestart(planTree: unknown[] = [], meta?: TaskMapMeta): string {
    return this.archiveThenInstall(planTree, meta || { work_mode: "graph" });
  }

  /** E6: session settle/interrupt/park — do not archive. */
  onSessionSettleOrPark(): void {
    // Intentionally no-op: last live remains current for resume/review.
  }

  /** Read-only projection for product-state / plan_tree_updated. */
  projection(): TaskMapProjection {
    const revs: TaskMapRevision[] = this.archived.map((r) => ({
      ...r,
      plan_tree: deepClonePlanTree(r.plan_tree),
      is_live: false,
    }));
    const live = this.liveAsRevision();
    if (live) revs.push(live);
    return {
      task_map_revisions: revs,
      live_revision_id: this.liveId,
      live_sealed: this.liveSealed,
    };
  }

  /** Archived count (excludes live). */
  archivedCount(): number {
    return this.archived.length;
  }

  /** Total revision rows including live. */
  revisionCount(): number {
    return this.archived.length + (this.liveId ? 1 : 0);
  }

  /**
   * Immutability check helper: return archived plan_tree by id (cloned).
   */
  getArchivedPlanTree(revisionId: string): unknown[] | null {
    const hit = this.archived.find((r) => r.id === revisionId);
    return hit ? deepClonePlanTree(hit.plan_tree) : null;
  }
}
