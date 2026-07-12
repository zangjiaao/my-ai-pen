/**
 * OMP-class todo session glue (clean-room): light coarse map, not a per-finding ledger.
 * Calibrated to OMP Juice-style use: one init with phases + occasional done; bash does the work.
 */

export function eagerTodoInjection(options?: { forced?: boolean }): string {
  if (options?.forced) {
    return [
      "<system-reminder>",
      "Before substantive work, call todo(op=init) ONCE with a coarse phased map (not a micro-checklist).",
      "Good: phases like Recon / Exploit categories / Report, with a few 5–10 word category tasks (e.g. \"Solve SQL injection class\", not one task per challenge/vuln).",
      "Bad: enumerating every endpoint, flag, or challenge as its own todo item.",
      "After init succeeds, spend the rest of the turn on high-density shell/act work — do not keep calling todo every few probes.",
      "Mark done only when a whole category/phase is largely finished (or use done with phase=...). Occasional done is enough.",
      "</system-reminder>",
    ].join("\n");
  }
  return [
    "<system-reminder>",
    "If the engagement needs structure, init a coarse phased todo once; keep items category-level. Prefer shell density over frequent todo updates.",
    "</system-reminder>",
  ].join("\n");
}

/**
 * Soft mid-run nudge. Only when several items remain — avoid nagging after every probe.
 * Threshold matches "light maintenance": do not push micro done/start thrash.
 */
export function midRunTodoNudge(openCount: number): string {
  // OMP mid-run nudge: any open items remind; keep working in-loop.
  if (openCount < 1) return "";
  const plural = openCount === 1 ? "is" : "are";
  return [
    "<system-reminder>",
    `Todo note: ${openCount} coarse item${openCount === 1 ? "" : "s"} ${plural} still open.`,
    "Only mark a category done when approaches in that category are exhausted — not after the first easy win.",
    "Prefer more high-density shell (multi-step / multi-call same turn) over todo bookkeeping.",
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

/** Tool-facing description (OMP-class ops, light-touch progress map). */
export const TODO_TOOL_DESCRIPTION = [
  "Light session progress map (OMP-style). Single op per call. Tasks identified by verbatim content — NEVER task-1/task-N.",
  "Use sparingly: one init with coarse phases + occasional done. Do NOT maintain a per-challenge / per-finding checklist.",
  "On each done, the earliest still-open task auto-promotes to in_progress.",
  "",
  "Ops:",
  "- init: list:[{phase,items}] or flat items (+ optional phase, default Tasks) — full replace",
  "- start: task — mark in_progress (demotes other in_progress)",
  "- done / drop / rm: task or phase or neither (all)",
  "- append: phase + items (creates phase if missing) — avoid unless a new category appears",
  "- view: read-only",
  "",
  "Anatomy: phase = short noun (Recon, Auth, Injection); task = 5–10 words, category-level.",
  "Rules: init once early; mark done when a category is largely finished; keep strings stable; view if text lost.",
  "Open todos never block booking or harness settlement. Prefer high-density shell over frequent todo calls.",
].join("\n");
