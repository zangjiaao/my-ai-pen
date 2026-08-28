/**
 * OMP-aligned session todo: phases + content-keyed tasks, single in_progress.
 * Pure transitions live in applyTodoOp so smokes can drive the same logic without I/O.
 *
 * Spec #301: host may stamp Worker ownership (agent_id / owner_agent_name) on Free
 * Main work items for Tasks chips — separate from Worker-local todo (depth>=1).
 */

import {
  FUZZY_BIND_MIN_SCORE,
  scoreTodoGoalMatch,
  type WorkerBindPath,
  type WorkerBindResult,
  type WorkerChipInput,
} from "../runtime/hard-graph-plan.js";
import { TaskMapHistory, type TaskMapProjection } from "./task-map.js";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";
export type TodoOpName = "init" | "start" | "done" | "rm" | "drop" | "append" | "view";

export type TodoItem = {
  content: string;
  status: TodoStatus;
};

/** Host-stamped Worker ownership on a Free Main todo work item (by node_id). */
export type TodoWorkerOwnership = {
  agent_id: string;
  linked_agent_id?: string;
  owner_agent_name: string;
  /**
   * Host-driven plan status (Graph applyChip parity). When set, toPlanNodes
   * projects this instead of raw TodoItem status so running/done/failed show on Tasks.
   */
  plan_status?: "pending" | "running" | "done" | "failed" | "skipped";
};

/** Synthetic pkg-* row when no Main todo can be bound (Free path mirror of Graph L2). */
export type TodoPackageWorkItem = {
  node_id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  agent_id: string;
  linked_agent_id?: string;
  owner_agent_name: string;
  kind: string;
  source: string;
  level: "work_item";
  parent_id?: string | null;
  priority?: number;
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
  /**
   * Spec #313 Free: when true, apply Free map init/replace policy
   * (silent full init replace forbidden while map non-empty).
   * Graph / subagent / legacy callers omit this and keep full-replace init.
   */
  free_map?: boolean;
  /** Spec #313: explicit user permission to replace Free Tasks map on init. */
  allow_replace?: boolean;
  /**
   * Spec #321 E2: when live map is sealed (all-terminal), full init archives
   * without a new replace grant. Set by TodoStore from TaskMapHistory.
   */
  live_sealed?: boolean;
};

/** True when Free Tasks map has any phase with tasks (open or closed history). */
export function freeMapNonEmpty(phases: readonly TodoPhase[]): boolean {
  return phases.some((phase) => (phase.tasks?.length || 0) > 0);
}

/**
 * Spec #313 S2 / #321 E2–E3 — Free silent todo.init replace gate (pure).
 * Returns error text when replace is denied; undefined when allowed.
 *
 * - empty map → allow
 * - live sealed (all-terminal) → allow without grant (E2 archive-then-init)
 * - allowReplace / platform grant → allow (E3)
 * - otherwise deny when map non-empty
 */
export function freeInitReplaceDenied(
  previous: readonly TodoPhase[],
  allowReplace?: boolean,
  options?: { liveSealed?: boolean },
): string | undefined {
  if (allowReplace === true) return undefined;
  if (options?.liveSealed === true) return undefined;
  if (!freeMapNonEmpty(previous)) return undefined;
  return (
    "Free Tasks map already exists; silent todo.init replace is forbidden. " +
    "Use append/start/done/drop/rm to maintain the map, or obtain platform-issued " +
    "todo_replace_allowed after explicit user permission (ChoiceCard option " +
    "replace_todo_map / todo_replace_permission) — agent allow_replace alone is not enough. " +
    "After the map is fully terminal (sealed), a new init archives the completed map without a grant."
  );
}

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

/** Host-derived Free phase status from projected child statuses (incl. Worker plan_status). */
export function deriveTodoPhasePlanStatus(
  childStatuses: readonly string[],
): "pending" | "running" | "done" | "skipped" | "failed" | "partial" {
  if (!childStatuses.length) return "pending";
  const norm = childStatuses.map((s) => String(s || "pending").trim().toLowerCase());
  const terminal = (s: string) =>
    s === "done" ||
    s === "completed" ||
    s === "skipped" ||
    s === "abandoned" ||
    s === "failed" ||
    s === "blocked";
  const running = (s: string) => s === "running" || s === "in_progress" || s === "active";
  const allTerminal = norm.every(terminal);
  if (allTerminal) {
    if (norm.some((s) => s === "failed" || s === "blocked")) return "failed";
    return "done";
  }
  if (norm.some(terminal)) return "partial";
  if (norm.some(running)) return "running";
  return "pending";
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

/** Stable L2 node_id for a todo task (must match TodoStore.toPlanNodes). */
export function todoTaskNodeId(phaseName: string, taskContent: string): string {
  return `todo-task-${slug(phaseName)}-${slug(taskContent)}`;
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
      const nid = todoTaskNodeId(task.phase, task.content);
      lines.push(`  - ${task.content} [${task.status}] (${task.phase}) node_id=${nid}`);
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
      const nid = todoTaskNodeId(phase.name, task.content);
      lines.push(`    - ${checkbox} ${task.content}${tag}  [node_id=${nid}]`);
    }
  }
  if (remainingTasks.length > 1) {
    lines.push(
      "Hint: pass work_items[].node_id as subagent plan_node_id when multiple open todos so the Worker chip binds correctly.",
    );
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
    case "init": {
      // Spec #313 Free / #321 E2–E3: silent full replace forbidden when map exists
      // unless allow_replace (grant) or live is sealed (E2).
      if (params.free_map) {
        const denied = freeInitReplaceDenied(previous, params.allow_replace === true, {
          liveSealed: params.live_sealed === true,
        });
        if (denied) {
          errors.push(denied);
          break;
        }
      }
      next = initPhases(params, errors);
      break;
    }
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
  /** Spec #301 host Worker chips on Free Main todos (keyed by plan node_id). */
  private ownershipByNodeId = new Map<string, TodoWorkerOwnership>();
  /** Synthetic pkg-* rows when bind falls through (owner still set). */
  private packageItems: TodoPackageWorkItem[] = [];
  /**
   * Spec #321 Task Map history for Free Main checklist (archive-then-switch).
   * Graph whole-participation maps may share this instance via setTaskMap / lifecycle.
   */
  private readonly taskMap: TaskMapHistory;

  constructor(taskMap?: TaskMapHistory) {
    this.taskMap = taskMap ?? new TaskMapHistory();
  }

  /** Spec #321: Session Task Map history (shared with Graph when wired). */
  getTaskMap(): TaskMapHistory {
    return this.taskMap;
  }

  /** Spec #321 product-state projection fields. */
  taskMapProjection(): TaskMapProjection {
    return this.taskMap.projection();
  }

  snapshot(): TodoPhase[] {
    return clonePhases(this.phases);
  }

  openCount(): number {
    return this.phases
      .flatMap((p) => p.tasks)
      .filter((t) => t.status === "pending" || t.status === "in_progress").length;
  }

  apply(params: TodoParams): TodoApplyResult {
    const freeMap = params.free_map === true;
    const priorNonEmpty = freeMap && freeMapNonEmpty(this.phases);
    const liveSealed = freeMap && this.taskMap.isSealed;
    const input: TodoParams = freeMap
      ? { ...params, live_sealed: liveSealed || params.live_sealed === true }
      : params;

    const result = applyTodoOp(this.phases, input);
    if (!result.readOnly && result.errors.length === 0) {
      this.phases = clonePhases(result.phases);
      this.pruneOrphanOwnership();
      if (freeMap) {
        this.syncFreeTaskMap(params.op, priorNonEmpty);
      }
    }
    return {
      ...result,
      phases: this.snapshot(),
    };
  }

  /**
   * Spec #321: after a successful Free map mutation, keep Task Map history in sync.
   * - init on non-empty prior (sealed E2 or granted E3) → archive-then-install
   * - first init / empty → install live
   * - maintain ops → mutate live only (E5); may seal (E1)
   */
  private syncFreeTaskMap(op: TodoOpName, priorNonEmpty: boolean): void {
    const planTree = this.toPlanNodes();
    const meta = { work_mode: "free" as const };
    if (op === "init") {
      if (priorNonEmpty) {
        this.taskMap.archiveThenInstall(planTree, meta);
      } else if (!this.taskMap.liveRevisionId || !this.taskMap.hasLiveContent()) {
        this.taskMap.installLive(planTree, meta);
      } else {
        // Empty re-init onto existing empty live shell
        this.taskMap.installLive(planTree, meta);
      }
      return;
    }
    if (op === "view") return;
    this.taskMap.mutateLive(planTree, meta);
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
    status: "pending" | "running" | "done" | "skipped" | "failed" | "partial";
    kind: string;
    level: "phase" | "work_item";
    parent_id?: string | null;
    source: string;
    priority: number;
    agent_id?: string;
    linked_agent_id?: string;
    owner_agent_name?: string;
  }> {
    const nodes: Array<{
      node_id: string;
      title: string;
      status: "pending" | "running" | "done" | "skipped" | "failed" | "partial";
      kind: string;
      level: "phase" | "work_item";
      parent_id?: string | null;
      source: string;
      priority: number;
      agent_id?: string;
      linked_agent_id?: string;
      owner_agent_name?: string;
    }> = [];
    let phasePriority = 100;
    for (const phase of this.phases) {
      const phaseId = `todo-phase-${slug(phase.name)}`;
      const childStatuses = phase.tasks.map((task) => {
        const node_id = todoTaskNodeId(phase.name, task.content);
        const own = this.ownershipByNodeId.get(node_id);
        return own?.plan_status ?? mapStatus(task.status);
      });
      nodes.push({
        node_id: phaseId,
        title: phase.name,
        status: deriveTodoPhasePlanStatus(childStatuses),
        // Phases are level=phase (not shown in Tasks list); keep plan-compatible source.
        kind: "phase",
        level: "phase",
        parent_id: null,
        source: "plan",
        priority: phasePriority,
      });
      let taskPriority = phasePriority + 1;
      for (const task of phase.tasks) {
        const node_id = todoTaskNodeId(phase.name, task.content);
        const own = this.ownershipByNodeId.get(node_id);
        // Host chip status wins (Graph applyChip parity); else TodoItem map.
        const status = own?.plan_status ?? mapStatus(task.status);
        nodes.push({
          node_id,
          title: task.content,
          status,
          // kind=task + source=plan: accepted by platform RightPanel.unifiedTodoItems
          kind: "task",
          level: "work_item",
          parent_id: phaseId,
          source: "plan",
          priority: taskPriority++,
          ...(own
            ? {
                agent_id: own.agent_id,
                linked_agent_id: own.linked_agent_id || own.agent_id,
                owner_agent_name: own.owner_agent_name,
              }
            : {}),
        });
      }
      phasePriority += 100;
    }
    // Synthetic package rows (pkg-*) after Main-authored work items.
    let pkgPri = phasePriority + 1;
    for (const pkg of this.packageItems) {
      nodes.push({
        node_id: pkg.node_id,
        title: pkg.title,
        status: pkg.status === "failed" ? "failed" : pkg.status,
        kind: pkg.kind || "task",
        level: "work_item",
        parent_id: pkg.parent_id ?? null,
        source: pkg.source || "plan",
        priority: typeof pkg.priority === "number" ? pkg.priority : pkgPri++,
        agent_id: pkg.agent_id,
        linked_agent_id: pkg.linked_agent_id || pkg.agent_id,
        owner_agent_name: pkg.owner_agent_name,
      });
    }
    return nodes;
  }

  /**
   * Spec #301 Free host bind — same priority as Hard Graph resolveWorkerBind:
   * explicit → reattach → single_free → fuzzy (caller must not invent a row on null).
   */
  resolveWorkerBind(
    input: WorkerChipInput & { goal?: string; plan_node_id?: string },
  ): WorkerBindResult | null {
    const planNodeId = String(input.plan_node_id || "").trim();
    let explicitMissed = false;
    if (planNodeId) {
      const id = this.attachWorker(planNodeId, input);
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
          `plan_node_id "${planNodeId}" not found in Free todos; fell back to ${path}. ` +
          "Copy work_items[].node_id from the last todo result.",
      };
    };
    const re = this.reattachWorkerByAgent(input);
    if (re) return decorate(re, "reattach");
    const single = this.bindWorkerToSingleFreeTodo(input);
    if (single) return decorate(single, "single_free");
    const goal = String(input.goal || "").trim();
    if (goal) {
      const fuzzy = this.bindWorkerToBestTodo({ ...input, goal });
      if (fuzzy) return decorate(fuzzy, "fuzzy");
    }
    return null;
  }

  attachWorker(nodeId: string, input: WorkerChipInput): string | null {
    const id = String(nodeId || "").trim();
    if (!id || id.startsWith("pkg-")) return null;
    if (!this.mainWorkItemIds().has(id)) return null;
    this.applyOwnership(id, input);
    return id;
  }

  reattachWorkerByAgent(input: WorkerChipInput): string | null {
    const agentId = String(input.agent_id || "").trim();
    if (!agentId) return null;
    for (const [nodeId, own] of this.ownershipByNodeId) {
      if (nodeId.startsWith("pkg-")) continue;
      if (String(own.agent_id || own.linked_agent_id || "").trim() === agentId) {
        this.applyOwnership(nodeId, input);
        return nodeId;
      }
    }
    // Also check package rows for reattach.
    const pkgIdx = this.packageItems.findIndex(
      (p) => String(p.agent_id || p.linked_agent_id || "").trim() === agentId,
    );
    if (pkgIdx >= 0) {
      const cur = this.packageItems[pkgIdx]!;
      this.packageItems[pkgIdx] = {
        ...cur,
        agent_id: input.agent_id,
        linked_agent_id: input.agent_id,
        owner_agent_name: input.owner_agent_name,
        status: mapChipStatus(input.status, cur.status),
      };
      return cur.node_id;
    }
    return null;
  }

  bindWorkerToSingleFreeTodo(input: WorkerChipInput): string | null {
    const free: string[] = [];
    for (const id of this.mainWorkItemIds()) {
      if (String(this.ownershipByNodeId.get(id)?.agent_id || "").trim()) continue;
      free.push(id);
    }
    if (free.length !== 1) return null;
    const id = free[0]!;
    this.applyOwnership(id, input);
    return id;
  }

  bindWorkerToBestTodo(input: WorkerChipInput & { goal: string }): string | null {
    const goal = String(input.goal || "").trim();
    if (!goal) return null;
    let best: { id: string; score: number } | null = null;
    for (const phase of this.phases) {
      for (const task of phase.tasks) {
        const id = todoTaskNodeId(phase.name, task.content);
        const aid = String(this.ownershipByNodeId.get(id)?.agent_id || "").trim();
        if (aid && aid !== input.agent_id) continue;
        const score = scoreTodoGoalMatch(task.content, goal);
        if (score < FUZZY_BIND_MIN_SCORE) continue;
        if (!best || score > best.score) best = { id, score };
      }
    }
    if (!best) return null;
    this.applyOwnership(best.id, input);
    return best.id;
  }

  upsertPackageWorkItem(item: {
    node_id: string;
    title: string;
    status: "pending" | "running" | "done" | "failed" | "skipped";
    agent_id: string;
    owner_agent_name: string;
  }): void {
    const node_id = String(item.node_id || "").trim();
    if (!node_id) return;
    const next: TodoPackageWorkItem = {
      node_id,
      title: item.title,
      status: item.status,
      agent_id: item.agent_id,
      linked_agent_id: item.agent_id,
      owner_agent_name: item.owner_agent_name,
      kind: "task",
      source: "plan",
      level: "work_item",
      parent_id: null,
    };
    const idx = this.packageItems.findIndex((p) => p.node_id === node_id);
    if (idx >= 0) this.packageItems[idx] = { ...this.packageItems[idx], ...next };
    else this.packageItems.push(next);
  }

  removePackageWorkItem(nodeId: string): void {
    const id = String(nodeId || "").trim();
    this.packageItems = this.packageItems.filter((p) => p.node_id !== id);
  }

  /**
   * Stamp ownership + optional host status (Graph applyChip parity).
   * When input.status is set: plan_status for Tasks projection and TodoItem
   * status for openCount (running→in_progress, done→completed, failed→abandoned).
   * Does not run single-in_progress normalize so parallel packages can all be running.
   */
  private applyOwnership(nodeId: string, input: WorkerChipInput): void {
    const prev = this.ownershipByNodeId.get(nodeId);
    const next: TodoWorkerOwnership = {
      agent_id: input.agent_id,
      linked_agent_id: input.agent_id,
      owner_agent_name: input.owner_agent_name,
      plan_status: prev?.plan_status,
    };
    if (input.status !== undefined && String(input.status).trim()) {
      next.plan_status = mapChipStatus(input.status, prev?.plan_status || "pending");
      this.driveTaskStatusFromChip(nodeId, next.plan_status);
    }
    this.ownershipByNodeId.set(nodeId, next);
  }

  /** Map host chip status onto the Main TodoItem row (not worker-local store). */
  private driveTaskStatusFromChip(
    nodeId: string,
    planStatus: NonNullable<TodoWorkerOwnership["plan_status"]>,
  ): void {
    const todoStatus = chipPlanStatusToTodoStatus(planStatus);
    if (!todoStatus) return;
    for (const phase of this.phases) {
      for (const task of phase.tasks) {
        if (todoTaskNodeId(phase.name, task.content) === nodeId) {
          task.status = todoStatus;
          return;
        }
      }
    }
  }

  private mainWorkItemIds(): Set<string> {
    const ids = new Set<string>();
    for (const phase of this.phases) {
      for (const task of phase.tasks) {
        ids.add(todoTaskNodeId(phase.name, task.content));
      }
    }
    return ids;
  }

  private pruneOrphanOwnership(): void {
    const live = this.mainWorkItemIds();
    for (const key of [...this.ownershipByNodeId.keys()]) {
      if (!live.has(key)) this.ownershipByNodeId.delete(key);
    }
  }
}

/** Host L2 chip status → TodoItem status for openCount / phases honesty. */
function chipPlanStatusToTodoStatus(
  planStatus: NonNullable<TodoWorkerOwnership["plan_status"]>,
): TodoStatus | null {
  if (planStatus === "running") return "in_progress";
  if (planStatus === "done") return "completed";
  if (planStatus === "failed" || planStatus === "skipped") return "abandoned";
  if (planStatus === "pending") return "pending";
  return null;
}

function mapChipStatus(
  chip: string | undefined,
  fallback: TodoPackageWorkItem["status"],
): TodoPackageWorkItem["status"] {
  const s = String(chip || "").trim().toLowerCase();
  if (s === "running" || s === "pending" || s === "done" || s === "failed" || s === "skipped") {
    return s;
  }
  return fallback;
}

function mapStatus(status: TodoStatus): "pending" | "running" | "done" | "skipped" {
  if (status === "completed") return "done";
  if (status === "in_progress") return "running";
  if (status === "abandoned") return "skipped";
  return "pending";
}

function slug(value: string): string {
  // Keep CJK / unicode letters — ASCII-only strip collapsed all Chinese titles to "item".
  const cleaned = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (cleaned) return cleaned;
  // Stable fallback from content so plan node_ids stay unique.
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return `t${h.toString(16)}`;
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
