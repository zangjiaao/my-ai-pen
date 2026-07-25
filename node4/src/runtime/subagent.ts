/**
 * Minimal clean-room subagent host: spawn → worker → structured result → evidence.
 * No OMP TUI/IRC/worktree hub. Workers are injectable for deterministic smokes.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GoalStore } from "../stores/goal.js";
import type { EvidenceStoreLike, PlatformSink, TaskEnvelope } from "../types.js";
import { emitHardGraphPlanTreeUpdate } from "./hard-graph-plan.js";
import { formatWorkerName, resolveSubagentGoal } from "./panel-agents.js";

export type SubagentResult = {
  ok: boolean;
  subagentId: string;
  summary: string;
  data: unknown;
  evidenceId?: string;
  goalId?: string;
  artifactPath?: string;
};

export type SubagentContext = {
  subagentId: string;
  assignment: string;
  goalId?: string;
  taskDir: string;
  workDir: string;
  task: TaskEnvelope;
};

export type SubagentWorker = (ctx: SubagentContext) => Promise<{ summary: string; data: unknown; ok?: boolean }>;

export type SubagentHostOptions = {
  task: TaskEnvelope;
  taskDir: string;
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
   * Attach Worker chip to Hard Graph L2:
   * 1) explicit plan_node_id
   * 2) re-attach by agent_id (status updates)
   * 3) last-resort title↔goal fuzzy (free rows only)
   * 4) host-owned pkg-* row
   */
  private async upsertHardGraphPackageChip(input: {
    subagentId: string;
    assignment: string;
    label?: string;
    planNodeId?: string;
    status: "running" | "done" | "failed";
  }): Promise<void> {
    const plan = this.opts.hardGraphPlan?.();
    const stageId = this.opts.stageId?.();
    if (!plan || !stageId) return;
    const goal = resolveSubagentGoal(input.label, input.assignment);
    const title = goal.slice(0, 240) || input.subagentId;
    const workerN = this.opts.panelAgents?.workerIndexFor(input.subagentId) ?? 0;
    const owner = workerN > 0 ? formatWorkerName(workerN) : "Worker";
    const chip = {
      agent_id: input.subagentId,
      owner_agent_name: owner,
      status: input.status,
    };

    let bound: string | null = null;
    const planNodeId = String(input.planNodeId || "").trim();
    if (planNodeId) {
      bound = plan.attachWorker(stageId, planNodeId, chip);
    }
    if (!bound) {
      bound = plan.reattachWorkerByAgent(stageId, chip);
    }
    if (!bound) {
      bound = plan.bindWorkerToBestTodo(stageId, { ...chip, goal });
    }

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
    ).catch(() => {});
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
    const workDir = join(this.opts.taskDir, "subagents", subagentId);
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
    await this.upsertHardGraphPackageChip({
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
        taskDir: this.opts.taskDir,
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
    await this.upsertHardGraphPackageChip({
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

    return {
      ok,
      subagentId,
      summary,
      data,
      evidenceId: evidence.id,
      goalId: options.goalId,
      artifactPath,
    };
  }
}
