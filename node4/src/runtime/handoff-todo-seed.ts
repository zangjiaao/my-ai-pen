/**
 * Spec #354 S4: seed TodoStore from Case pending-handoff / cold-continue snapshot.
 * Accepts Node TodoPhase snapshot (`tasks[].content`) and plan_tree-shaped (`title`) payloads.
 *
 * When any open item exists, preserves completed/abandoned siblings so Free continue
 * reuses the Case Tasks map (Spec #313 silent replace stays denied).
 * Sealed maps (all terminal) leave an empty store so a fresh init is allowed.
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

type SeedTask = { content: string; status: string };
type SeedPhase = { name: string; tasks: SeedTask[] };

function parseSeedPhases(raw: unknown[]): SeedPhase[] {
  const phases: SeedPhase[] = [];
  for (const phase of raw) {
    if (!phase || typeof phase !== "object") continue;
    const p = phase as { name?: unknown; tasks?: unknown; items?: unknown };
    const name = String(p.name || "Handoff").trim() || "Handoff";
    const tasks: SeedTask[] = [];
    if (Array.isArray(p.tasks)) {
      for (const t of p.tasks) {
        if (!t || typeof t !== "object") continue;
        const row = t as { status?: unknown; title?: unknown; content?: unknown };
        // Node snapshot uses `content`; plan_tree / platform hold may use `title`.
        const text = String(row.content ?? row.title ?? "").trim();
        if (!text) continue;
        tasks.push({
          content: text,
          status: String(row.status || "pending").toLowerCase() || "pending",
        });
      }
    } else if (Array.isArray(p.items)) {
      for (const it of p.items) {
        const text = String(it || "").trim();
        if (text) tasks.push({ content: text, status: "pending" });
      }
    }
    if (tasks.length) phases.push({ name, tasks });
  }
  return phases;
}

export function seedTodoFromHandoff(task: Pick<TaskEnvelope, "pendingHandoffTodos">): TodoStore {
  const store = new TodoStore();
  const raw = task.pendingHandoffTodos;
  if (!Array.isArray(raw) || raw.length === 0) return store;
  try {
    const phases = parseSeedPhases(raw);
    if (!phases.length) return store;

    const hasOpen = phases.some((phase) =>
      phase.tasks.some((t) => !HANDOFF_TERMINAL.has(t.status)),
    );
    // Sealed map: leave empty so Free may legitimately init a new plan.
    if (!hasOpen) return store;

    const list = phases.map((phase) => ({
      phase: phase.name,
      items: phase.tasks.map((t) => t.content),
    }));
    const init = store.apply({ op: "init", list, free_map: true });
    if (init.errors.length || init.readOnly) return store;

    // Restore statuses after init (init always starts as pending + first in_progress).
    for (const phase of phases) {
      for (const task of phase.tasks) {
        const st = task.status;
        if (st === "completed" || st === "done") {
          store.apply({ op: "done", task: task.content });
        } else if (st === "abandoned" || st === "failed" || st === "skipped" || st === "blocked") {
          store.apply({ op: "drop", task: task.content });
        }
      }
    }
    for (const phase of phases) {
      for (const task of phase.tasks) {
        const st = task.status;
        if (st === "in_progress" || st === "running") {
          store.apply({ op: "start", task: task.content });
        }
      }
    }
  } catch {
    /* empty store */
  }
  return store;
}
