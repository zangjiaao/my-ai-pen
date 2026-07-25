/**
 * Expert Graph Tasks map: L1 = fixed Graph stages, L2 = stage-local todos.
 * Stage todo.init merges children under one stage; never replaces sibling stages.
 */

import type { HardGraphDefinition } from "./hard-graph-definition.js";
import type { PlanNodeLike } from "./plan-projection.js";
import { stampPlanTreeOwner } from "./plan-projection.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope } from "../types.js";

export type GraphStagePlanStatus = "pending" | "running" | "done" | "failed" | "blocked" | "skipped";

/** Normalize worker/plan status vocabulary to plan-store terms. */
export function normalizePlanWorkStatus(status: string | undefined): string {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return "pending";
  if (s === "completed" || s === "complete" || s === "done") return "done";
  if (s === "failed" || s === "error" || s === "crashed") return "failed";
  if (s === "running" || s === "in_progress" || s === "active") return "running";
  if (s === "blocked") return "blocked";
  if (s === "skipped") return "skipped";
  if (s === "pending" || s === "todo") return "pending";
  return s;
}

function stageNodeId(stageId: string): string {
  return `graph-stage-${String(stageId || "").trim() || "unknown"}`;
}

function slug(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "item";
}

function normalizeMatchText(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/subagent handoff package/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff/_.-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Minimum score for last-resort title↔goal binding (avoid weak token hits). */
export const FUZZY_BIND_MIN_SCORE = 60;

/** Higher = better match between a todo title and worker this_turn_goal. */
export function scoreTodoGoalMatch(title: string, goal: string): number {
  const t = normalizeMatchText(title);
  const g = normalizeMatchText(goal);
  if (!t || !g) return 0;
  if (t === g) return 100;
  if (g.includes(t) || t.includes(g)) return 85;
  // Path-like tokens (/vulnerabilities/sqli) are strong signals.
  const pathTokens = [...g.matchAll(/\/[a-z0-9_./-]{3,}/g)].map((m) => m[0]!);
  for (const p of pathTokens) {
    if (t.includes(p.replace(/^\//, "")) || t.includes(p)) return 75;
  }
  const tParts = new Set(t.split(/[\s/_.-]+/).filter((x) => x.length >= 3));
  const gParts = new Set(g.split(/[\s/_.-]+/).filter((x) => x.length >= 3));
  if (!tParts.size || !gParts.size) return 0;
  let hit = 0;
  for (const x of tParts) if (gParts.has(x)) hit++;
  if (hit === 0) return 0;
  const ratio = hit / Math.min(tParts.size, gParts.size);
  return Math.round(20 + ratio * 50 + hit * 3);
}

export type WorkerChipInput = {
  agent_id: string;
  owner_agent_name: string;
  /**
   * When set, Worker chip also drives L2 status (running/done/failed) so Tasks
   * shows live ownership progress. Omit to keep prior status (ownership-only).
   */
  status?: string;
};

/** How a Worker chip was attached to an L2 todo (telemetry / tool result). */
export type WorkerBindPath = "explicit" | "reattach" | "single_free" | "fuzzy" | "pkg";

/** Result of resolveWorkerBind (includes explicit-miss fallthrough telemetry). */
export type WorkerBindResult = {
  node_id: string;
  path: WorkerBindPath;
  /** plan_node_id that was requested but not found in stage L2 (if any). */
  requested_node_id?: string;
  /** Human hint when binding was non-explicit or explicit missed then fell back. */
  hint?: string;
};

/**
 * Mutable L1/L2 plan for one Hard Graph run.
 */
export class HardGraphPlanStore {
  private readonly graphId: string;
  private readonly stageOrder: string[];
  private readonly stageTitles: Map<string, string>;
  private readonly stageStatus = new Map<string, GraphStagePlanStatus>();
  /** L2 work items keyed by stage id (parent rewritten to graph-stage-*). */
  private readonly stageTodos = new Map<string, PlanNodeLike[]>();

  constructor(graph: HardGraphDefinition) {
    this.graphId = graph.id;
    this.stageOrder = graph.stages.map((s) => s.id);
    this.stageTitles = new Map(
      graph.stages.map((s) => [s.id, s.id] as const),
    );
    for (const id of this.stageOrder) {
      this.stageStatus.set(id, "pending");
      this.stageTodos.set(id, []);
    }
  }

  getGraphId(): string {
    return this.graphId;
  }

  setStageStatus(stageId: string, status: GraphStagePlanStatus): void {
    if (!this.stageStatus.has(stageId)) return;
    this.stageStatus.set(stageId, status);
  }

  /**
   * Replace L2 todos for one stage only. Incoming nodes may be raw TodoStore
   * projections; parent_id is rewritten to the Graph stage L1 id.
   *
   * Preserves Worker ownership (agent_id / owner_agent_name) on matching node_ids,
   * and keeps pkg-* package rows that Main's todo snapshot would otherwise wipe.
   */
  setStageTodos(stageId: string, nodes: PlanNodeLike[]): void {
    if (!this.stageTodos.has(stageId)) return;
    const parentId = stageNodeId(stageId);
    const prev = this.stageTodos.get(stageId) || [];
    const prevById = new Map(prev.map((n) => [String(n.node_id || n.id || ""), n]));
    const workItems = nodes
      .filter((n) => (n.level || "work_item") === "work_item")
      .map((n, i) => {
        const title = String(n.title || n.node_id || `task-${i}`);
        const nodeId =
          String(n.node_id || n.id || "").trim() ||
          `todo-task-${slug(stageId)}-${slug(title)}`;
        const prior = prevById.get(nodeId);
        const merged: PlanNodeLike = {
          ...n,
          node_id: nodeId,
          id: nodeId,
          title,
          level: "work_item" as const,
          kind: String(n.kind || "task"),
          source: String(n.source || "plan"),
          parent_id: parentId,
          status: n.status || "pending",
          priority: typeof n.priority === "number" ? n.priority : 100 + i,
        };
        // Keep Worker chip if todo tool rewrite omitted ownership.
        if (prior?.agent_id && !String(merged.agent_id || "").trim()) {
          merged.agent_id = prior.agent_id;
          merged.owner_agent_name = prior.owner_agent_name || merged.owner_agent_name;
          merged.linked_agent_id = prior.linked_agent_id || merged.linked_agent_id;
        }
        return merged;
      });
    const seen = new Set(workItems.map((n) => String(n.node_id || n.id || "")));
    // Package rows are host-owned; do not drop them on Main todo.init.
    for (const p of prev) {
      const id = String(p.node_id || p.id || "");
      if (id.startsWith("pkg-") && !seen.has(id)) {
        workItems.push({ ...p, parent_id: parentId });
        seen.add(id);
      }
    }
    this.stageTodos.set(stageId, workItems);
  }

  /** Remove one L2 row by node_id (e.g. drop pkg-* mirror after binding to a Main todo). */
  removeStageWorkItem(stageId: string, nodeId: string): void {
    if (!this.stageTodos.has(stageId)) return;
    const id = String(nodeId || "").trim();
    if (!id) return;
    const list = this.stageTodos.get(stageId) || [];
    this.stageTodos.set(
      stageId,
      list.filter((n) => String(n.node_id || n.id || "") !== id),
    );
  }

  /** Upsert a single L2 work item (e.g. package/worker row with agent chip). */
  upsertStageWorkItem(stageId: string, item: PlanNodeLike): void {
    if (!this.stageTodos.has(stageId)) return;
    const parentId = stageNodeId(stageId);
    const nodeId =
      String(item.node_id || item.id || "").trim() ||
      `todo-task-${slug(stageId)}-${slug(String(item.title || "work"))}`;
    const next: PlanNodeLike = {
      ...item,
      node_id: nodeId,
      id: nodeId,
      level: "work_item",
      kind: String(item.kind || "task"),
      source: String(item.source || "plan"),
      parent_id: parentId,
      status: item.status || "pending",
    };
    const list = this.stageTodos.get(stageId) || [];
    const idx = list.findIndex((n) => String(n.node_id || n.id) === nodeId);
    if (idx >= 0) list[idx] = { ...list[idx], ...next };
    else list.push(next);
    this.stageTodos.set(stageId, list);
  }

  /**
   * Explicit ownership: attach Worker chip to a known L2 node_id.
   * Preferred over fuzzy goal matching.
   */
  attachWorker(
    stageId: string,
    nodeId: string,
    input: WorkerChipInput,
  ): string | null {
    if (!this.stageTodos.has(stageId)) return null;
    const id = String(nodeId || "").trim();
    if (!id || id.startsWith("pkg-")) return null;
    const list = this.stageTodos.get(stageId) || [];
    const idx = list.findIndex((n) => String(n.node_id || n.id || "") === id);
    if (idx < 0) return null;
    this.applyChip(list, idx, input);
    this.stageTodos.set(stageId, list);
    return id;
  }

  /**
   * Re-attach by existing agent_id (status updates after first bind).
   * Does not steal another worker's row.
   */
  reattachWorkerByAgent(
    stageId: string,
    input: WorkerChipInput,
  ): string | null {
    if (!this.stageTodos.has(stageId)) return null;
    const agentId = String(input.agent_id || "").trim();
    if (!agentId) return null;
    const list = this.stageTodos.get(stageId) || [];
    const idx = list.findIndex((n) => {
      const id = String(n.node_id || n.id || "");
      if (id.startsWith("pkg-")) return false;
      return String(n.agent_id || n.linked_agent_id || "").trim() === agentId;
    });
    if (idx < 0) return null;
    this.applyChip(list, idx, input);
    this.stageTodos.set(stageId, list);
    return String(list[idx]!.node_id || list[idx]!.id || "");
  }

  /**
   * Deterministic: exactly one unbound Main-authored L2 row → attach there.
   * Free = no agent_id (same-agent updates must use reattachWorkerByAgent).
   */
  bindWorkerToSingleFreeTodo(
    stageId: string,
    input: WorkerChipInput,
  ): string | null {
    if (!this.stageTodos.has(stageId)) return null;
    const list = this.stageTodos.get(stageId) || [];
    const freeIdx: number[] = [];
    for (let i = 0; i < list.length; i++) {
      const n = list[i]!;
      const id = String(n.node_id || n.id || "");
      if (id.startsWith("pkg-")) continue;
      // Truly unbound only — never treat same-agent occupied rows as free.
      if (String(n.agent_id || "").trim()) continue;
      freeIdx.push(i);
    }
    if (freeIdx.length !== 1) return null;
    const idx = freeIdx[0]!;
    const cur = list[idx]!;
    this.applyChip(list, idx, input);
    this.stageTodos.set(stageId, list);
    return String(cur.node_id || cur.id || "");
  }

  /**
   * Last-resort: attach to free Main todo by title↔goal score.
   * Never steals a row already bound to a different agent.
   * Prefer attachWorker / reattach / single-free when possible.
   */
  bindWorkerToBestTodo(
    stageId: string,
    input: WorkerChipInput & { goal: string },
  ): string | null {
    if (!this.stageTodos.has(stageId)) return null;
    const goal = String(input.goal || "").trim();
    if (!goal) return null;
    const list = this.stageTodos.get(stageId) || [];
    let best: { idx: number; score: number } | null = null;
    for (let i = 0; i < list.length; i++) {
      const n = list[i]!;
      const id = String(n.node_id || n.id || "");
      if (id.startsWith("pkg-")) continue;
      const aid = String(n.agent_id || "").trim();
      // Never steal another worker's chip.
      if (aid && aid !== input.agent_id) continue;
      const score = scoreTodoGoalMatch(String(n.title || ""), goal);
      if (score < FUZZY_BIND_MIN_SCORE) continue;
      if (!best || score > best.score) best = { idx: i, score };
    }
    if (!best) return null;
    const cur = list[best.idx]!;
    this.applyChip(list, best.idx, input);
    this.stageTodos.set(stageId, list);
    return String(cur.node_id || cur.id || "");
  }

  /**
   * Resolve Worker chip bind path in priority order:
   * explicit → reattach → single_free → fuzzy.
   * If plan_node_id was provided but not found, fall through and attach
   * requested_node_id + hint on the eventual result.
   */
  resolveWorkerBind(
    stageId: string,
    input: WorkerChipInput & { goal?: string; plan_node_id?: string },
  ): WorkerBindResult | null {
    const planNodeId = String(input.plan_node_id || "").trim();
    let explicitMissed = false;
    if (planNodeId) {
      const id = this.attachWorker(stageId, planNodeId, input);
      if (id) return { node_id: id, path: "explicit" };
      explicitMissed = true;
    }
    const decorate = (node_id: string, path: WorkerBindPath): WorkerBindResult => {
      if (!explicitMissed) return { node_id, path };
      return {
        node_id,
        path,
        requested_node_id: planNodeId,
        hint:
          `plan_node_id "${planNodeId}" not found in stage L2; fell back to ${path}. ` +
          "Copy work_items[].node_id from the last todo result.",
      };
    };
    const re = this.reattachWorkerByAgent(stageId, input);
    if (re) return decorate(re, "reattach");
    const single = this.bindWorkerToSingleFreeTodo(stageId, input);
    if (single) return decorate(single, "single_free");
    const goal = String(input.goal || "").trim();
    if (goal) {
      const fuzzy = this.bindWorkerToBestTodo(stageId, { ...input, goal });
      if (fuzzy) return decorate(fuzzy, "fuzzy");
    }
    return null;
  }

  /**
   * Apply Worker ownership chip. When input.status is set, also drive L2 status
   * (product: bound Worker progress is visible on Tasks while owned).
   */
  private applyChip(list: PlanNodeLike[], idx: number, input: WorkerChipInput): void {
    const cur = list[idx]!;
    const next: PlanNodeLike = {
      ...cur,
      agent_id: input.agent_id,
      owner_agent_name: input.owner_agent_name,
      linked_agent_id: input.agent_id,
    };
    if (input.status !== undefined && String(input.status).trim()) {
      next.status = normalizePlanWorkStatus(input.status);
    }
    list[idx] = next;
  }

  toPlanTree(): PlanNodeLike[] {
    const nodes: PlanNodeLike[] = [];
    let priority = 100;
    for (const stageId of this.stageOrder) {
      const status = this.stageStatus.get(stageId) || "pending";
      const l1Id = stageNodeId(stageId);
      nodes.push({
        node_id: l1Id,
        id: l1Id,
        title: this.stageTitles.get(stageId) || stageId,
        status,
        kind: "phase",
        level: "phase",
        parent_id: null,
        source: "plan",
        priority,
      });
      const todos = this.stageTodos.get(stageId) || [];
      let p = priority + 1;
      for (const t of todos) {
        nodes.push({ ...t, priority: typeof t.priority === "number" ? t.priority : p++ });
      }
      priority += 100;
    }
    return nodes;
  }
}

export async function emitHardGraphPlanTreeUpdate(
  platform: PlatformSink,
  task: TaskEnvelope,
  plan: HardGraphPlanStore,
  reason: string,
): Promise<void> {
  const plan_tree = stampPlanTreeOwner(plan.toPlanTree(), task);
  const workItems = plan_tree.filter((n) => (n.level || "work_item") === "work_item");
  const done = workItems.filter((n) => {
    const s = normalizePlanWorkStatus(String(n.status || ""));
    return s === "done" || s === "skipped";
  }).length;
  const total = workItems.length;
  const open = workItems.filter((n) => {
    const s = normalizePlanWorkStatus(String(n.status || ""));
    return s === "pending" || s === "running";
  }).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  await platform.send({
    type: "plan_tree_updated",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    reason,
    plan_tree,
    todo_open_count: open,
    progress: {
      percent,
      label: total === 0 ? "No stage todos" : `${done}/${total} done (${open} open)`,
    },
    expert_id: task.expertId,
    expert_name: task.expertName,
    engagement: task.engagement || task.role,
    hard_graph: { graph_id: plan.getGraphId(), event: "plan_tree" },
  } as PlatformMessage);
}
