/**
 * Minimal clean-room subagent host: spawn → worker → structured result → evidence.
 * No OMP TUI/IRC/worktree hub. Workers are injectable for deterministic smokes.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GoalStore } from "../stores/goal.js";
import type { TodoStore } from "../stores/todo.js";
import type { EvidenceStoreLike, PlatformSink, TaskEnvelope } from "../types.js";
import { emitHardGraphPlanTreeUpdate } from "./hard-graph-plan.js";
import { emitTodoPlanTreeUpdate } from "./plan-projection.js";
import { formatWorkerName, resolveSubagentGoal } from "./panel-agents.js";
import { resolvePiInstanceDir, workspaceCaseId } from "./session-workspace.js";

export type SubagentResult = {
  ok: boolean;
  subagentId: string;
  summary: string;
  data: unknown;
  evidenceId?: string;
  goalId?: string;
  artifactPath?: string;
  /** Case todo ownership bind (Hard Graph L2 or Free Main Todo). */
  planBind?: {
    path: string;
    node_id?: string;
    requested_node_id?: string;
    hint?: string;
  };
};

export type SubagentContext = {
  subagentId: string;
  assignment: string;
  goalId?: string;
  piDir: string;
  workDir: string;
  task: TaskEnvelope;
};

export type SubagentWorker = (ctx: SubagentContext) => Promise<{ summary: string; data: unknown; ok?: boolean }>;

export type SubagentHostOptions = {
  task: TaskEnvelope;
  piDir: string;
  workspaceDir?: string;
  evidence: EvidenceStoreLike;
  platform: PlatformSink;
  goals: GoalStore;
  /** Optional right-panel agent tree tracker. */
  panelAgents?: import("./panel-agents.js").PanelAgentTracker;
  /**
   * Optional Hard Graph plan getters — on package start/end upsert L2 work items
   * (agent chips) without a late panel scan.
   */
  hardGraphPlan?: () => import("./hard-graph-plan.js").HardGraphPlanStore | undefined;
  stageId?: () => string | undefined;
  /**
   * Spec #301 Free Main Todo path — host auto-bind Worker chip when Graph is not active.
   * Prefer a getter so the store can be attached after host construction.
   */
  todo?: () => TodoStore | undefined;
};

let subSeq = 0;

export class SubagentHost {
  constructor(private readonly opts: SubagentHostOptions) {}

  /** Push Main + children so Status collaboration tree updates live. */
  private async emitPanelAgentsSnapshot(): Promise<void> {
    const panel = this.opts.panelAgents;
    if (!panel) return;
    const agents = panel.list();
    await this.opts.platform
      .send({
        type: "status_update",
        conversation_id: this.opts.task.conversationId,
        task_id: this.opts.task.taskId,
        message: "panel_agents",
        agent_phase: "subagent",
        status: "running",
        panel_agents: agents,
        expert_id: this.opts.task.expertId,
        expert_name: this.opts.task.expertName,
      })
      .catch(() => {});
    // Persist into checkpoint path consumers (Case participants / snapshot).
    await this.opts.platform
      .send({
        type: "checkpoint_update",
        conversation_id: this.opts.task.conversationId,
        task_id: this.opts.task.taskId,
        checkpoint: {
          runtime: "node4-pi",
          panel_agents: agents,
          agent_phase: "subagent",
          task_id: this.opts.task.taskId,
        },
      })
      .catch(() => {});
  }

  /**
   * Attach Worker chip to Case todo (Hard Graph L2 or Free Main Todo).
   * Priority: explicit → reattach → single_free → fuzzy → pkg-* (owner still set).
   * Spec #301: Main must not need a separate "link" tool.
   */
  private async upsertCaseTodoChip(input: {
    subagentId: string;
    assignment: string;
    label?: string;
    planNodeId?: string;
    status: "running" | "done" | "failed";
  }): Promise<{
    path: string;
    node_id?: string;
    requested_node_id?: string;
    hint?: string;
  }> {
    const plan = this.opts.hardGraphPlan?.();
    const stageId = this.opts.stageId?.();
    if (plan && stageId) {
      return this.upsertHardGraphPackageChip(input, plan, stageId);
    }
    const todo = this.opts.todo?.();
    if (todo) {
      return this.upsertFreeTodoChip(input, todo);
    }
    return { path: "none" };
  }

  private async upsertHardGraphPackageChip(
    input: {
      subagentId: string;
      assignment: string;
      label?: string;
      planNodeId?: string;
      status: "running" | "done" | "failed";
    },
    plan: import("./hard-graph-plan.js").HardGraphPlanStore,
    stageId: string,
  ): Promise<{
    path: string;
    node_id?: string;
    requested_node_id?: string;
    hint?: string;
  }> {
    const goal = resolveSubagentGoal(input.label, input.assignment);
    const title = goal.slice(0, 240) || input.subagentId;
    const workerN = this.opts.panelAgents?.workerIndexFor(input.subagentId) ?? 0;
    const owner = workerN > 0 ? formatWorkerName(workerN) : "Worker";
    const requested = String(input.planNodeId || "").trim() || undefined;
    const chip = {
      agent_id: input.subagentId,
      owner_agent_name: owner,
      status: input.status,
      goal,
      plan_node_id: input.planNodeId,
    };

    const bound = plan.resolveWorkerBind(stageId, chip);
    if (!bound) {
      plan.upsertStageWorkItem(stageId, {
        node_id: `pkg-${input.subagentId}`,
        title,
        status: input.status,
        agent_id: input.subagentId,
        owner_agent_name: owner,
        kind: "task",
        source: "plan",
      });
    } else {
      plan.removeStageWorkItem(stageId, `pkg-${input.subagentId}`);
    }

    await emitHardGraphPlanTreeUpdate(
      this.opts.platform,
      this.opts.task,
      plan,
      `subagent.${input.status}:${input.subagentId}`,
      {
        // Spec #321 E5: package chip updates mutate live map only.
        taskMap: this.opts.todo?.()?.getTaskMap(),
      },
    ).catch(() => {});

    if (bound) {
      return {
        path: bound.path,
        node_id: bound.node_id,
        requested_node_id: bound.requested_node_id,
        hint: bound.hint,
      };
    }
    return {
      path: "pkg",
      node_id: `pkg-${input.subagentId}`,
      requested_node_id: requested,
      hint: requested
        ? `plan_node_id "${requested}" not found in stage L2; fell back to pkg. Copy work_items[].node_id from the last todo result.`
        : "No matching Main todo; host pkg-* row created. Pass plan_node_id when multiple todos are open.",
    };
  }

  /** Free Main Todo path — same bind priority; emit plan_tree_updated from TodoStore. */
  private async upsertFreeTodoChip(
    input: {
      subagentId: string;
      assignment: string;
      label?: string;
      planNodeId?: string;
      status: "running" | "done" | "failed";
    },
    todo: TodoStore,
  ): Promise<{
    path: string;
    node_id?: string;
    requested_node_id?: string;
    hint?: string;
  }> {
    const goal = resolveSubagentGoal(input.label, input.assignment);
    const title = goal.slice(0, 240) || input.subagentId;
    const workerN = this.opts.panelAgents?.workerIndexFor(input.subagentId) ?? 0;
    const owner = workerN > 0 ? formatWorkerName(workerN) : "Worker";
    const requested = String(input.planNodeId || "").trim() || undefined;
    const chip = {
      agent_id: input.subagentId,
      owner_agent_name: owner,
      status: input.status,
      goal,
      plan_node_id: input.planNodeId,
    };

    const bound = todo.resolveWorkerBind(chip);
    if (!bound) {
      todo.upsertPackageWorkItem({
        node_id: `pkg-${input.subagentId}`,
        title,
        status: input.status,
        agent_id: input.subagentId,
        owner_agent_name: owner,
      });
    } else {
      todo.removePackageWorkItem(`pkg-${input.subagentId}`);
    }

    await emitTodoPlanTreeUpdate(
      this.opts.platform,
      this.opts.task,
      todo,
      `subagent.${input.status}:${input.subagentId}`,
    ).catch(() => {});

    if (bound) {
      return {
        path: bound.path,
        node_id: bound.node_id,
        requested_node_id: bound.requested_node_id,
        hint: bound.hint,
      };
    }
    return {
      path: "pkg",
      node_id: `pkg-${input.subagentId}`,
      requested_node_id: requested,
      hint: requested
        ? `plan_node_id "${requested}" not found in Free todos; fell back to pkg. Copy work_items[].node_id from the last todo result.`
        : "No matching Main todo; host pkg-* row created. Pass plan_node_id when multiple todos are open.",
    };
  }

  /**
   * Run a child unit of work under the task workspace contract.
   * `worker` is required for non-LLM deterministic execution; agent tools supply a default.
   */
  async spawn(options: {
    assignment: string;
    goalId?: string;
    worker: SubagentWorker;
    subagentId?: string;
    /** Graph node type for panel label (optional). */
    nodeType?: string;
    /** Short purpose (this_turn_goal) for Tasks/panel — not full package markdown. */
    label?: string;
    skillId?: string;
    /** Explicit L2 todo node_id for Tasks Worker chip (preferred over fuzzy match). */
    planNodeId?: string;
  }): Promise<SubagentResult> {
    const subagentId = options.subagentId?.trim() || `sub_${Date.now()}_${++subSeq}`;
    const exp = String(this.opts.task.expertId || "").trim() || "default";
    const ws = String(this.opts.workspaceDir || "").trim();
    const workDir = ws
      ? resolvePiInstanceDir(ws, workspaceCaseId(this.opts.task.conversationId), exp, subagentId)
      : join(dirname(this.opts.piDir), `pi-${subagentId}`);
    await mkdir(workDir, { recursive: true });

    if (options.goalId) {
      this.opts.goals.attachSubagent(options.goalId, subagentId);
    }

    await writeFile(
      join(workDir, "assignment.md"),
      `# Subagent ${subagentId}\n\n${options.assignment}\n\ngoalId: ${options.goalId || ""}\nnodeType: ${options.nodeType || ""}\nplanNodeId: ${options.planNodeId || ""}\n`,
      "utf8",
    );

    this.opts.panelAgents?.noteSubagentStart({
      id: subagentId,
      assignment: options.assignment,
      goalId: options.goalId,
      nodeType: options.nodeType,
      label: options.label,
      skillId: options.skillId,
    });
    // Push full collaboration tree immediately — tool_execution_start checkpoint
    // fires before spawn, so without this the UI only ever sees Main.
    await this.emitPanelAgentsSnapshot();
    const planBindStart = await this.upsertCaseTodoChip({
      subagentId,
      assignment: options.assignment,
      label: options.label,
      planNodeId: options.planNodeId,
      status: "running",
    });

    await this.opts.platform.send({
      type: "subagent_started",
      conversation_id: this.opts.task.conversationId,
      task_id: this.opts.task.taskId,
      subagent_id: subagentId,
      goal_id: options.goalId,
      assignment: (options.label || options.assignment).slice(0, 500),
      // Include panel so clients that only listen for this event can render kids.
      panel_agents: this.opts.panelAgents?.list() || [],
    });

    let summary = "";
    let data: unknown = null;
    let ok = true;
    try {
      const out = await options.worker({
        subagentId,
        assignment: options.assignment,
        goalId: options.goalId,
        piDir: this.opts.piDir,
        workDir,
        task: this.opts.task,
      });
      summary = String(out.summary || "").trim() || "subagent finished";
      data = out.data;
      ok = out.ok !== false;
    } catch (err) {
      ok = false;
      summary = err instanceof Error ? err.message : String(err);
      data = { error: summary };
    }

    const artifactPath = join(workDir, "result.json");
    const payload = {
      subagentId,
      ok,
      summary,
      data,
      goalId: options.goalId,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(artifactPath, JSON.stringify(payload, null, 2), "utf8");

    const evidence = await this.opts.evidence.create({
      type: "subagent_result",
      sourceTool: "subagent",
      summary: `subagent ${subagentId}: ${summary.slice(0, 200)}`,
      data: payload,
    });

    this.opts.panelAgents?.noteSubagentEnd({ id: subagentId, ok, summary });
    await this.emitPanelAgentsSnapshot();
    const planBindEnd = await this.upsertCaseTodoChip({
      subagentId,
      assignment: options.assignment,
      label: options.label,
      planNodeId: options.planNodeId,
      status: ok ? "done" : "failed",
    });

    await this.opts.platform.send({
      type: "subagent_finished",
      conversation_id: this.opts.task.conversationId,
      task_id: this.opts.task.taskId,
      subagent_id: subagentId,
      goal_id: options.goalId,
      ok,
      evidence_id: evidence.id,
      summary: summary.slice(0, 500),
      panel_agents: this.opts.panelAgents?.list() || [],
    });

    const planBind = planBindEnd.path !== "none" ? planBindEnd : planBindStart;
    return {
      ok,
      subagentId,
      summary,
      data,
      evidenceId: evidence.id,
      goalId: options.goalId,
      artifactPath,
      planBind: planBind.path !== "none" ? planBind : undefined,
    };
  }
}
