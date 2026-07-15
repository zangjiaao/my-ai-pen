/**
 * OMP-aligned todo session glue (clean-room).
 *
 * State machine: stores/todo.ts (ops, content-keyed tasks, single in_progress).
 * This module: harness mechanics only (eager init, mid-run reconcile, error reminder).
 *
 * Role-specific map content (e.g. Recon/Auth/Injection vs CTF challenge categories)
 * belongs in experts/<pack>/work.md + mission — not hardcoded here.
 */

/** Act tools that count as "landed work" for mid-run todo reconciliation (OMP bash/edit/write family). */
export const MID_RUN_TODO_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "shell",
  "write",
  "edit",
  "script",
  "http",
  "session",
  "browser",
]);

/** Mutating tool results without a todo call before a mid-run nudge (OMP default: 12). */
export const MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD = 12;

/** Max mid-run nudges per outer prompt cycle (OMP: 2). */
export const MID_RUN_TODO_NUDGE_MAX_PER_CYCLE = 2;

export type MidRunTodoTracker = {
  mutationsSinceLastTodoTouch: number;
  midRunNudgeCount: number;
};

export function createMidRunTodoTracker(): MidRunTodoTracker {
  return { mutationsSinceLastTodoTouch: 0, midRunNudgeCount: 0 };
}

/** Reset counters at the start of each outer prompt/continue cycle. */
export function resetMidRunTodoCycle(tracker: MidRunTodoTracker): void {
  tracker.mutationsSinceLastTodoTouch = 0;
  tracker.midRunNudgeCount = 0;
}

/**
 * Record a finished tool call. Returns an OMP-style mid-run nudge body when
 * enough act work landed without a todo update and open items remain.
 */
export function noteToolForMidRunTodoNudge(
  tracker: MidRunTodoTracker,
  toolName: string,
  options: { openTodoCount: number; isError?: boolean },
): string {
  const name = String(toolName || "").toLowerCase();
  if (name === "todo") {
    tracker.mutationsSinceLastTodoTouch = 0;
    return "";
  }
  if (options.isError) return "";
  if (!MID_RUN_TODO_MUTATING_TOOLS.has(name)) return "";
  if (options.openTodoCount < 1) return "";

  tracker.mutationsSinceLastTodoTouch += 1;
  if (tracker.mutationsSinceLastTodoTouch < MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD) return "";
  if (tracker.midRunNudgeCount >= MID_RUN_TODO_NUDGE_MAX_PER_CYCLE) return "";

  tracker.mutationsSinceLastTodoTouch = 0;
  tracker.midRunNudgeCount += 1;
  return midRunTodoNudge(options.openTodoCount);
}

export function eagerTodoInjection(options?: { forced?: boolean }): string {
  if (options?.forced) {
    return [
      "<system-reminder>",
      "Before substantive work, create a phased todo.",
      "You MUST call todo first in this turn with a single init op.",
      "Cover the whole engagement as a coarse phased map — categories from YOUR role/mission and recon, not just the next step.",
      "Task labels: concise 5–10 word category-level work (what, not how). Unique content strings.",
      "Bad: meta prep (configure environment, load skills), micro-checklists, or one todo per atomic item if the mission says use categories.",
      "After todo succeeds, continue act work in the SAME turn (high-density primary tools).",
      "NEVER call todo again unless task state has materially changed (start/done when you switch or finish a category).",
      "</system-reminder>",
    ].join("\n");
  }
  return [
    "<system-reminder>",
    "Consider todo(init) once with a coarse phased map for the whole engagement; keep task labels 5–10 words. Continue act work in the same turn; avoid re-calling todo unless state changes.",
    "</system-reminder>",
  ].join("\n");
}

/**
 * OMP mid-run / stop-time soft nudge: reconcile finished work, else keep acting.
 * Fixes long runs that stay 0/N until a final batch-flip to N/N (OMP #3651).
 */
export function midRunTodoNudge(openCount: number): string {
  if (openCount < 1) return "";
  const plural = openCount === 1 ? "is" : "are";
  return [
    "<system-reminder>",
    `Gentle reminder: ${openCount} todo item${openCount === 1 ? "" : "s"} ${plural} still open.`,
    "If you finished a category since the last todo update, mark it done now (done task=... or done phase=...) so progress stays visible; otherwise just keep working.",
    "Do not batch-flip every phase at the end. Prefer high-density shell over todo thrash — but do not leave finished categories open.",
    "</system-reminder>",
  ].join("\n");
}

/** Stop-time reminder when the agent stops with incomplete todos (OMP #checkTodoCompletion). */
export function incompleteTodoStopReminder(
  openCount: number,
  openTitles: string[] = [],
  attempt = 1,
  maxAttempts = 3,
): string {
  if (openCount < 1) return "";
  const list =
    openTitles.length > 0
      ? openTitles
          .slice(0, 12)
          .map((t) => `  - ${t}`)
          .join("\n")
      : "";
  return [
    "<system-reminder>",
    `You stopped with ${openCount} incomplete todo item(s)${list ? `:\n${list}` : "."}`,
    "Continue working on these categories or mark them complete if finished.",
    `(Reminder ${attempt}/${maxAttempts})`,
    "</system-reminder>",
  ].join("\n");
}

export function todoErrorReminder(errors: string[]): string {
  const detail = errors.length ? errors.join("; ") : "previous todo call failed";
  return [
    "<system-reminder>",
    `Your last todo update failed (${detail}). Todo progress is not visible until you retry with a valid op.`,
    "Tasks are referenced by verbatim content from the list (view first if unsure). Do not invent task-1 ids.",
    "Keep the list coarse; do not expand into a per-vuln checklist.",
    "</system-reminder>",
  ].join("\n");
}

/**
 * Model-facing tool description — OMP ops/anatomy/rules only.
 * Which categories to map is role/pack methodology (system prompt work.md), not this string.
 */
export const TODO_TOOL_DESCRIPTION = [
  "Session progress map (OMP-style). Single op per call. Tasks referenced by verbatim content — NEVER task-1/task-N.",
  "On each completion the earliest still-open task auto-promotes to in_progress.",
  "Use: one early init with coarse phases + mark done when a category finishes. Prefer density of act tools over frequent todo thrash.",
  "",
  "Ops:",
  "- init: list:[{phase,items}] or flat items (+ optional phase, default Tasks) — full replace",
  "- start: task — mark in_progress (demotes other in_progress)",
  "- done / drop / rm: task or phase or neither (all)",
  "- append: phase + items (creates phase if missing) — only when a new category appears",
  "- view: read-only",
  "",
  "Anatomy: phase = short noun phrase (no \"1.\" / \"Phase 1:\" prefixes); task = 5–10 words, category-level, unique.",
  "Rules:",
  "- Mark a task/phase done immediately after finishing that category (live map — not end-of-run batch).",
  "- Prefer completing earlier phases before leaving them open while working ahead.",
  "- Keep task/phase strings stable; view if text lost.",
  "- Open todos never block product booking or harness settlement.",
  "- Follow role/mission for which categories to include; do not invent target answer keys.",
].join("\n");
