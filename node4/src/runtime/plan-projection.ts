/**
 * Project session todos into plan_tree_updated payloads for the platform
 * right-panel Tasks list (same consumer shapes as Node2).
 *
 * OMP/Node2 style: content-keyed phases/items, status map pending|running|done|skipped.
 * Work-item nodes must pass platform RightPanel.unifiedTodoItems (kind/source allowlist).
 */

import type { PlatformMessage, PlatformSink, TaskEnvelope } from "../types.js";
import type { TodoStore } from "../stores/todo.js";

export type PlanNodeLike = {
  node_id?: string;
  id?: string;
  title?: string;
  status?: string;
  kind?: string;
  level?: string;
  parent_id?: string | null;
  source?: string;
  priority?: number;
};

/**
 * Mirror of platform RightPanel.unifiedTodoItems filter (keep in sync).
 * Used so node-side smokes fail if projection shapes would yield an empty Tasks list.
 */
export function unifiedTodoItemsFilter(nodes: PlanNodeLike[]): PlanNodeLike[] {
  const noiseKinds = new Set([
    "tool",
    "browser",
    "http",
    "poc",
    "scan",
    "traffic",
    "finding",
    "coverage",
    "verifier",
    "finish_scan",
    "workflow",
    "workflow_run",
    "workflow_list",
    "workflow_dynamic",
    "read",
    "actor",
    "surface",
    "request",
    "test",
    "worker",
    "stage",
  ]);

  return nodes.filter((node) => {
    if ((node.level || "work_item") !== "work_item") return false;
    const source = String(node.source || "");
    const kind = String(node.kind || "task");
    const parent = String(node.parent_id || "");
    const id = String(node.node_id || node.id || "");
    if (
      kind === "worker" ||
      (source === "worker" && !id.startsWith("plan-followup-") && !/^Follow-up /i.test(String(node.title || "")))
    ) {
      return false;
    }
    if (source === "coverage" || source === "pi_tool" || kind === "test") return false;
    if (noiseKinds.has(kind)) return false;
    if (source === "agent" || source === "strix_todo" || source === "plan") return true;
    if (source === "worker" && (id.startsWith("plan-followup-") || /^Follow-up /i.test(String(node.title || "")))) {
      return true;
    }
    if (["task", "work", "work_item", "package", "objective"].includes(kind)) return true;
    if (parent.startsWith("workflow-") || id.startsWith("ctf-") || id.startsWith("workflow-")) return true;
    return false;
  });
}

/** Build plan nodes + optional progress summary from the current todo store. */
export function buildTodoPlanTreePayload(todo: TodoStore): {
  plan_tree: ReturnType<TodoStore["toPlanNodes"]>;
  todo_phases: ReturnType<TodoStore["snapshot"]>;
  todo_open_count: number;
  progress: { percent: number; label: string };
  /** Work items that would appear in platform Tasks after unifiedTodoItems filter. */
  task_panel_items: PlanNodeLike[];
} {
  const plan_tree = todo.toPlanNodes();
  const phases = todo.snapshot();
  const allTasks = phases.flatMap((p) => p.tasks);
  const total = allTasks.length;
  const done = allTasks.filter((t) => t.status === "completed" || t.status === "abandoned").length;
  const open = todo.openCount();
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const task_panel_items = unifiedTodoItemsFilter(plan_tree);
  return {
    plan_tree,
    todo_phases: phases,
    todo_open_count: open,
    progress: {
      percent,
      label: total === 0 ? "No tasks" : `${done}/${total} done (${open} open)`,
    },
    task_panel_items,
  };
}

/** Emit plan_tree_updated so ConversationPage Tasks list updates live. */
export async function emitTodoPlanTreeUpdate(
  platform: PlatformSink,
  task: TaskEnvelope,
  todo: TodoStore,
  reason: string,
): Promise<void> {
  const payload = buildTodoPlanTreePayload(todo);
  await platform.send({
    type: "plan_tree_updated",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    reason,
    plan_tree: payload.plan_tree,
    todo_phases: payload.todo_phases,
    todo_open_count: payload.todo_open_count,
    progress: payload.progress,
  } as PlatformMessage);
}
