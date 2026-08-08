/**
 * Spec #354 S4: seed TodoStore from Case pending-handoff snapshot.
 * Accepts Node TodoPhase snapshot (`tasks[].content`) and plan_tree-shaped (`title`) payloads.
 */
import { TodoStore } from "../stores/todo.js";
import type { TaskEnvelope } from "../types.js";

/** Terminal Todo statuses (Node TodoStore + plan_tree synonyms). */
const HANDOFF_TERMINAL = new Set([
  "completed",
  "abandoned",
  "done",
  "failed",
  "skipped",
  "blocked",
]);

export function seedTodoFromHandoff(task: Pick<TaskEnvelope, "pendingHandoffTodos">): TodoStore {
  const store = new TodoStore();
  const raw = task.pendingHandoffTodos;
  if (!Array.isArray(raw) || raw.length === 0) return store;
  try {
    const list: Array<{ phase: string; items: string[] }> = [];
    for (const phase of raw) {
      if (!phase || typeof phase !== "object") continue;
      const p = phase as { name?: unknown; tasks?: unknown; items?: unknown };
      const name = String(p.name || "Handoff").trim() || "Handoff";
      const items: string[] = [];
      if (Array.isArray(p.tasks)) {
        for (const t of p.tasks) {
          if (!t || typeof t !== "object") continue;
          const row = t as { status?: unknown; title?: unknown; content?: unknown };
          const status = String(row.status || "").toLowerCase();
          if (status && HANDOFF_TERMINAL.has(status)) continue;
          // Node snapshot uses `content`; plan_tree / platform hold may use `title`.
          const text = String(row.content ?? row.title ?? "").trim();
          if (text) items.push(text);
        }
      } else if (Array.isArray(p.items)) {
        for (const it of p.items) {
          const text = String(it || "").trim();
          if (text) items.push(text);
        }
      }
      if (items.length) list.push({ phase: name, items });
    }
    if (list.length) {
      store.apply({ op: "init", list, free_map: true });
    }
  } catch {
    /* empty store */
  }
  return store;
}
