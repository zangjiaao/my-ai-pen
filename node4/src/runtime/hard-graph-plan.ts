/**
 * Expert Graph Tasks map: L1 = fixed Graph stages, L2 = stage-local todos.
 * Stage todo.init merges children under one stage; never replaces sibling stages.
 */

import type { HardGraphDefinition } from "./hard-graph-definition.js";
import type { PlanNodeLike } from "./plan-projection.js";
import { stampPlanTreeOwner } from "./plan-projection.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope } from "../types.js";

export type GraphStagePlanStatus = "pending" | "running" | "done" | "failed" | "blocked" | "skipped";

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
   */
  setStageTodos(stageId: string, nodes: PlanNodeLike[]): void {
    if (!this.stageTodos.has(stageId)) return;
    const parentId = stageNodeId(stageId);
    const workItems = nodes
      .filter((n) => (n.level || "work_item") === "work_item")
      .map((n, i) => {
        const title = String(n.title || n.node_id || `task-${i}`);
        const nodeId =
          String(n.node_id || n.id || "").trim() ||
          `todo-task-${slug(stageId)}-${slug(title)}`;
        return {
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
      });
    this.stageTodos.set(stageId, workItems);
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
  const done = workItems.filter((n) => n.status === "done" || n.status === "skipped").length;
  const total = workItems.length;
  const open = workItems.filter((n) => n.status === "pending" || n.status === "running").length;
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
