/**
 * Project session todos into plan_tree_updated payloads for the platform
 * right-panel Tasks list (same consumer shapes as Node2).
 *
 * OMP/Node2 style: content-keyed phases/items, status map pending|running|done|skipped.
 */

import type { PlatformMessage, PlatformSink, TaskEnvelope } from "../types.js";
import type { TodoStore } from "../stores/todo.js";

/** Build plan nodes + optional progress summary from the current todo store. */
export function buildTodoPlanTreePayload(todo: TodoStore): {
  plan_tree: ReturnType<TodoStore["toPlanNodes"]>;
  todo_phases: ReturnType<TodoStore["snapshot"]>;
  todo_open_count: number;
  progress: { percent: number; label: string };
} {
  const plan_tree = todo.toPlanNodes();
  const phases = todo.snapshot();
  const allTasks = phases.flatMap((p) => p.tasks);
  const total = allTasks.length;
  const done = allTasks.filter((t) => t.status === "completed" || t.status === "abandoned").length;
  const open = todo.openCount();
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return {
    plan_tree,
    todo_phases: phases,
    todo_open_count: open,
    progress: {
      percent,
      label: total === 0 ? "No tasks" : `${done}/${total} done (${open} open)`,
    },
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
