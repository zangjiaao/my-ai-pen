/**
 * OMP-aligned session todo: phases + content-keyed tasks, single in_progress.
 * Pure transitions live in applyTodoOp so smokes can drive the same logic without I/O.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";
export type TodoOpName = "init" | "start" | "done" | "rm" | "drop" | "append" | "view";

export type TodoItem = {
  content: string;
  status: TodoStatus;
};

export type TodoPhase = {
  name: string;
  tasks: TodoItem[];
};

export type TodoParams = {
  op: TodoOpName;
  list?: Array<{ phase: string; items: string[] }>;
  task?: string;
  phase?: string;
  items?: string[];
};

export type TodoApplyResult = {
  phases: TodoPhase[];
  errors: string[];
  /** True when op was view-only or failed (no persist). */
  readOnly: boolean;
  completedTasks: Array<{ phase: string; content: string }>;
};

const DEFAULT_INIT_PHASE = "Tasks";

export function clonePhases(phases: TodoPhase[]): TodoPhase[] {
  return phases.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map((task) => ({ content: task.content, status: task.status })),
  }));
}

export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
  let firstPending: TodoItem | undefined;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.status === "in_progress") return task;
      if (!firstPending && task.status === "pending") firstPending = task;
    }
  }
  return firstPending;
}

export function formatTodoSummary(phases: TodoPhase[], errors: string[] = [], readOnly = false): string {
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length === 0) {
    if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
    return readOnly ? "Todo list is empty." : "Todo list cleared.";
  }

  const remainingByPhase = phases
    .map((phase) => ({
      name: phase.name,
      tasks: phase.tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
    }))
    .filter((phase) => phase.tasks.length > 0);
  const remainingTasks = remainingByPhase.flatMap((phase) =>
    phase.tasks.map((task) => ({ ...task, phase: phase.name })),
  );

  let currentIdx = phases.findIndex((phase) =>
    phase.tasks.some((task) => task.status === "pending" || task.status === "in_progress"),
  );
  if (currentIdx === -1) currentIdx = phases.length - 1;
  const current = phases[currentIdx]!;
  const closedInActive = current.tasks.filter(
    (task) => task.status === "completed" || task.status === "abandoned",
  ).length;
  const closedAll = tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;
  const workedAhead = phases.some(
    (phase, idx) =>
      idx > currentIdx && phase.tasks.some((task) => task.status === "completed" || task.status === "abandoned"),
  );

  const lines: string[] = [];
  if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
  if (remainingTasks.length === 0) {
    lines.push("Remaining items: none.");
  } else {
    lines.push(`Remaining items (${remainingTasks.length}):`);
    for (const task of remainingTasks) {
      lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
    }
  }
  lines.push(`Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open.`);
  lines.push(
    `Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${closedInActive}/${current.tasks.length})${
      workedAhead
        ? " — earliest phase with open tasks; in_progress auto-advances to earliest open task (completed items are not reverted)."
        : "."
    }`,
  );
  for (const phase of phases) {
    lines.push(`  ${phase.name}:`);
    for (const task of phase.tasks) {
      const checkbox = task.status === "completed" ? "[X]" : "[ ]";
      const tag =
        task.status === "in_progress" ? " (in progress)" : task.status === "abandoned" ? " (dropped)" : "";
      lines.push(`    - ${checkbox} ${task.content}${tag}`);
    }
  }
  return lines.join("\n");
}

export function applyTodoOp(previous: TodoPhase[], params: TodoParams): TodoApplyResult {
  const errors: string[] = [];
  const before = clonePhases(previous);
  let next = clonePhases(previous);
  const op = params.op;

  if (op === "view") {
    return { phases: next, errors: [], readOnly: true, completedTasks: [] };
  }

  switch (op) {
    case "init":
      next = initPhases(params, errors);
      break;
    case "start": {
      const hit = resolveTaskOrError(next, params.task, errors);
      if (hit) {
        for (const phase of next) {
          for (const candidate of phase.tasks) {
            if (candidate.status === "in_progress" && candidate !== hit.task) {
              candidate.status = "pending";
            }
          }
        }
        hit.task.status = "in_progress";
      }
      break;
    }
    case "done":
      for (const task of getTaskTargets(next, params, errors)) {
        task.status = "completed";
      }
      break;
    case "drop":
      for (const task of getTaskTargets(next, params, errors)) {
        task.status = "abandoned";
      }
      break;
    case "rm":
      next = removeTasks(next, params, errors);
      break;
    case "append":
      next = appendItems(next, params, errors);
      break;
    default:
      errors.push(`Unknown op "${String(op)}"`);
  }

  if (errors.length > 0) {
    return { phases: before, errors, readOnly: true, completedTasks: [] };
  }

  normalizeInProgressTask(next);
  const completedTasks = getCompletionTransitions(before, next);
  return { phases: next, errors: [], readOnly: false, completedTasks };
}

export class TodoStore {
  private phases: TodoPhase[] = [];

  snapshot(): TodoPhase[] {
    return clonePhases(this.phases);
  }

  openCount(): number {
    return this.phases
      .flatMap((p) => p.tasks)
      .filter((t) => t.status === "pending" || t.status === "in_progress").length;
  }

  apply(params: TodoParams): TodoApplyResult {
    const result = applyTodoOp(this.phases, params);
    if (!result.readOnly && result.errors.length === 0) {
      this.phases = clonePhases(result.phases);
    }
    return {
      ...result,
      phases: this.snapshot(),
    };
  }

  /**
   * Project phases into plan-like nodes for platform Tasks panel.
   * Shapes must pass RightPanel.unifiedTodoItems filters:
   * work items need level=work_item and (source in agent|strix_todo|plan OR kind in task|work|work_item|...).
   * Use kind=task + source=plan so Tasks list is non-empty (kind=todo-task + source=todo is filtered out).
   */
  toPlanNodes(): Array<{
    node_id: string;
    title: string;
    status: "pending" | "running" | "done" | "skipped";
    kind: string;
    level: "phase" | "work_item";
    parent_id?: string | null;
    source: string;
    priority: number;
  }> {
    const nodes: Array<{
      node_id: string;
      title: string;
      status: "pending" | "running" | "done" | "skipped";
      kind: string;
      level: "phase" | "work_item";
      parent_id?: string | null;
      source: string;
      priority: number;
    }> = [];
    let phasePriority = 100;
    for (const phase of this.phases) {
      const phaseId = `todo-phase-${slug(phase.name)}`;
      const phaseDone = phase.tasks.length > 0 && phase.tasks.every((t) => t.status === "completed" || t.status === "abandoned");
      const phaseRunning = phase.tasks.some((t) => t.status === "in_progress");
      nodes.push({
        node_id: phaseId,
        title: phase.name,
        status: phaseDone ? "done" : phaseRunning ? "running" : "pending",
        // Phases are level=phase (not shown in Tasks list); keep plan-compatible source.
        kind: "phase",
        level: "phase",
        parent_id: null,
        source: "plan",
        priority: phasePriority,
      });
      let taskPriority = phasePriority + 1;
      for (const task of phase.tasks) {
        nodes.push({
          node_id: `todo-task-${slug(phase.name)}-${slug(task.content)}`,
          title: task.content,
          status: mapStatus(task.status),
          // kind=task + source=plan: accepted by platform RightPanel.unifiedTodoItems
          kind: "task",
          level: "work_item",
          parent_id: phaseId,
          source: "plan",
          priority: taskPriority++,
        });
      }
      phasePriority += 100;
    }
    return nodes;
  }
}

function mapStatus(status: TodoStatus): "pending" | "running" | "done" | "skipped" {
  if (status === "completed") return "done";
  if (status === "in_progress") return "running";
  if (status === "abandoned") return "skipped";
  return "pending";
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "item";
}

function findTaskByContent(phases: TodoPhase[], content: string): { task: TodoItem; phase: TodoPhase } | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((t) => t.content === content);
    if (task) return { task, phase };
  }
  return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
  return phases.find((phase) => phase.name === name);
}

function resolveTaskOrError(
  phases: TodoPhase[],
  content: string | undefined,
  errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
  if (!content) {
    errors.push("Missing task content");
    return undefined;
  }
  const hit = findTaskByContent(phases, content);
  if (!hit) {
    if (/^task-\d+$/i.test(content)) {
      errors.push(
        `Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
      );
    } else {
      const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
      const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
      errors.push(`Task "${content}" not found${hint}`);
    }
  }
  return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
  if (!name) {
    errors.push("Missing phase name");
    return undefined;
  }
  const phase = findPhaseByName(phases, name);
  if (!phase) errors.push(`Phase "${name}" not found`);
  return phase;
}

function getTaskTargets(phases: TodoPhase[], entry: TodoParams, errors: string[]): TodoItem[] {
  if (entry.task) {
    const hit = resolveTaskOrError(phases, entry.task, errors);
    return hit ? [hit.task] : [];
  }
  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors);
    return phase ? [...phase.tasks] : [];
  }
  return phases.flatMap((phase) => phase.tasks);
}

function initPhases(entry: TodoParams, errors: string[]): TodoPhase[] {
  const list =
    entry.list ??
    (entry.items && entry.items.length > 0
      ? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
      : undefined);
  if (!list) {
    errors.push("Missing list for init operation");
    return [];
  }
  const seenPhases = new Set<string>();
  const seenTasks = new Set<string>();
  for (const listEntry of list) {
    if (seenPhases.has(listEntry.phase)) {
      errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
    }
    seenPhases.add(listEntry.phase);
    if (!listEntry.items?.length) {
      errors.push(`Phase "${listEntry.phase}" needs at least one item`);
      continue;
    }
    for (const content of listEntry.items) {
      if (seenTasks.has(content)) {
        errors.push(`Duplicate task "${content}" in init list`);
      }
      seenTasks.add(content);
    }
  }
  if (errors.length) return [];
  return list.map((listEntry) => ({
    name: listEntry.phase,
    tasks: listEntry.items.map((content) => ({ content, status: "pending" as const })),
  }));
}

function appendItems(phases: TodoPhase[], entry: TodoParams, errors: string[]): TodoPhase[] {
  if (!entry.phase) {
    errors.push("Missing phase name for append operation");
    return phases;
  }
  if (!entry.items || entry.items.length === 0) {
    errors.push("Missing items for append operation");
    return phases;
  }
  const seen = new Set<string>();
  let hasDuplicate = false;
  for (const content of entry.items) {
    if (seen.has(content) || findTaskByContent(phases, content)) {
      errors.push(`Task "${content}" already exists`);
      hasDuplicate = true;
    }
    seen.add(content);
  }
  if (hasDuplicate) return phases;

  let phase = findPhaseByName(phases, entry.phase);
  if (!phase) {
    phase = { name: entry.phase, tasks: [] };
    phases.push(phase);
  }
  for (const content of entry.items) {
    phase.tasks.push({ content, status: "pending" });
  }
  return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoParams, errors: string[]): TodoPhase[] {
  if (entry.task) {
    const hit = resolveTaskOrError(phases, entry.task, errors);
    if (!hit) return phases;
    hit.phase.tasks = hit.phase.tasks.filter((candidate) => candidate !== hit.task);
    return phases;
  }
  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors);
    if (!phase) return phases;
    phase.tasks = [];
    return phases;
  }
  for (const phase of phases) {
    phase.tasks = [];
  }
  return phases;
}

function normalizeInProgressTask(phases: TodoPhase[]): void {
  const orderedTasks = phases.flatMap((phase) => phase.tasks);
  if (orderedTasks.length === 0) return;

  const inProgressTasks = orderedTasks.filter((task) => task.status === "in_progress");
  if (inProgressTasks.length > 1) {
    for (const task of inProgressTasks.slice(1)) {
      task.status = "pending";
    }
  }
  if (inProgressTasks.length > 0) return;

  const firstPendingTask = orderedTasks.find((task) => task.status === "pending");
  if (firstPendingTask) firstPendingTask.status = "in_progress";
}

function getCompletionTransitions(
  previous: TodoPhase[],
  updated: TodoPhase[],
): Array<{ phase: string; content: string }> {
  const previousStatuses = new Map<string, TodoStatus>();
  for (const phase of previous) {
    for (const task of phase.tasks) {
      previousStatuses.set(`${phase.name}\0${task.content}`, task.status);
    }
  }
  const transitions: Array<{ phase: string; content: string }> = [];
  for (const phase of updated) {
    for (const task of phase.tasks) {
      if (task.status !== "completed") continue;
      const prev = previousStatuses.get(`${phase.name}\0${task.content}`);
      if (prev && prev !== "completed") {
        transitions.push({ phase: phase.name, content: task.content });
      }
    }
  }
  return transitions;
}
